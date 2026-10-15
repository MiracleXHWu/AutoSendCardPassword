/**
 * vpaynotify —— 接收微信虚拟支付「消息推送」（HTTP 触发）
 *
 * 部署要点：
 *   1. 云开发控制台 → 云函数 vpaynotify → 开启「HTTP 访问服务」，得到形如
 *      https://<envId>.service.tcloudbase.com/vpaynotify 的地址
 *   2. 该访问路径必须开启「集成响应」（否则无法返回微信要求的 XML 报文）
 *   3. MP 后台 → 开发与服务 → 开发管理 → 消息推送 → 填入上面的 URL，
 *      数据格式选 XML，并订阅虚拟支付相关事件
 *
 * 处理原则：
 *   - 只认平台单号 WeChatPayInfo.MchOrderNo（wx_order_id）做幂等去重
 *   - 返回 ErrCode=0 平台才停止重试（最多重试 15 次）
 *   - 任何异常都要吞掉并返回明确错误码，避免平台无限重推
 */
/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    表现为「微信消息推送全部失败」，日志里只有 145 code exit unexpected。
 *    因此把「依赖加载 + init + 取 db」全部纳入保护，失败时改为返回失败 XML。
 * ------------------------------------------------------------------ */
let cloud = null;
let BOOT_ERROR = '';
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (e) {
  BOOT_ERROR = (e && e.message) || String(e);
}

let db = null;
if (!BOOT_ERROR) {
  try {
    db = cloud.database();
  } catch (e) {
    BOOT_ERROR = (e && e.message) || String(e);
  }
}

const OK_XML = '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>';
const failXml = (code, msg) =>
  `<xml><ErrCode>${code}</ErrCode><ErrMsg><![CDATA[${String(msg).replace(/]]>/g, '')}]]></ErrMsg></xml>`;

function xmlResponse(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body
  };
}

/** 极简 XML → Object（微信推送层级很浅，够用） */
function parseXml(xml) {
  const obj = {};
  const re = /<([A-Za-z_][\w.]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : m[3];
    obj[key] = /<[A-Za-z_][\w.]*>/.test(val) ? parseXml(val) : val;
  }
  return obj;
}

/** 兼容云函数 HTTP 触发的多种入参形态 */
function extractPayload(event) {
  if (!event) return {};
  // 直接以事件对象进来（事件订阅场景）
  if (event.Event && !event.body) return event;

  let body = event.body;
  if (body && event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  if (typeof body === 'string' && body.trim()) {
    const text = body.trim();
    if (text.startsWith('<')) return parseXml(text);
    try {
      return JSON.parse(text);
    } catch (e) {
      return {};
    }
  }
  if (body && typeof body === 'object') return body;
  return event;
}

exports.main = async (event) => {
  // 启动期失败：返回失败 XML，让平台按重试策略稍后再推，同时日志留下可读原因
  if (BOOT_ERROR) {
    console.error('[vpaynotify] 云函数启动失败：', BOOT_ERROR);
    return xmlResponse(failXml(1, 'function boot failed: ' + BOOT_ERROR));
  }

  let payload;
  try {
    payload = extractPayload(event);
  } catch (e) {
    console.error('[vpaynotify] 报文解析失败', e);
    return xmlResponse(failXml(1, 'parse error'));
  }

  const evt = payload.Event || payload.event || '';
  console.log('[vpaynotify] 收到事件', evt, JSON.stringify(payload));

  try {
    switch (evt) {
      case 'xpay_goods_deliver_notify':
        return xmlResponse(await onDeliver(payload));
      case 'xpay_refund_notify':
        return xmlResponse(await onRefund(payload));
      case 'xpay_complaint_notify':
        return xmlResponse(await onComplaint(payload));
      default:
        // 代币、订阅等事件本项目未使用，直接成功应答
        console.log('[vpaynotify] 未处理事件，忽略：', evt);
        return xmlResponse(OK_XML);
    }
  } catch (e) {
    console.error('[vpaynotify] 处理异常', e);
    return xmlResponse(failXml(1, e.message || 'handle error'));
  }
};

/* ------------------------------------------------------------------ */
/* 道具发货通知：核心事件                                              */
/* ------------------------------------------------------------------ */
async function onDeliver(payload) {
  const openid = payload.OpenId || payload.openid || '';
  const outTradeNo = payload.OutTradeNo || payload.outTradeNo || '';
  const wxOrderId =
    (payload.WeChatPayInfo && (payload.WeChatPayInfo.MchOrderNo || payload.WeChatPayInfo.mchOrderNo)) || '';
  const productId = (payload.GoodsInfo && (payload.GoodsInfo.ProductId || payload.GoodsInfo.productId)) || '';
  const quantity = Number((payload.GoodsInfo && (payload.GoodsInfo.Quantity || payload.GoodsInfo.quantity)) || 1);

  if (!openid || !outTradeNo) {
    console.error('[vpaynotify] 发货推送缺少关键字段', JSON.stringify(payload));
    return failXml(1, 'missing openid/outTradeNo');
  }

  // 交给 deliver 统一处理（内部以 outTradeNo 做幂等，重复推送不会重复发货）
  const res = await cloud.callFunction({
    name: 'deliver',
    data: {
      openid,
      outTradeNo,
      wxOrderId,
      productId,
      quantity: quantity > 0 ? quantity : 1
    }
  });

  const r = (res && res.result) || {};
  if (r.ok === false) {
    // 返回非 0，平台会重试，正好用来兜住「卡密临时不足」这类可恢复错误
    console.error('[vpaynotify] 发货失败，等待平台重试', r.msg);
    return failXml(1, r.msg || 'deliver failed');
  }
  return OK_XML;
}

/* ------------------------------------------------------------------ */
/* 退款通知                                                            */
/* ------------------------------------------------------------------ */
async function onRefund(payload) {
  const outTradeNo = payload.OutTradeNo || payload.outTradeNo || '';
  const wxOrderId =
    (payload.WeChatPayInfo && (payload.WeChatPayInfo.MchOrderNo || payload.WeChatPayInfo.mchOrderNo)) || '';
  if (!outTradeNo && !wxOrderId) return OK_XML;

  const where = outTradeNo ? { outTradeNo } : { wxOrderId };
  const r = await db.collection('xpay_orders').where(where).limit(1).get();
  const order = r.data[0];
  if (order) {
    await db.collection('xpay_orders').doc(order._id).update({
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        refundRaw: JSON.stringify(payload)
      }
    });
    console.log('[vpaynotify] 已标记退款', order.outTradeNo);
  }
  return OK_XML;
}

/* ------------------------------------------------------------------ */
/* 投诉通知：仅落库，建议人工跟进                                       */
/* ------------------------------------------------------------------ */
async function onComplaint(payload) {
  try {
    await db.collection('xpay_complaints').add({
      data: { raw: JSON.stringify(payload), createdAt: new Date(), handled: false }
    });
  } catch (e) {
    console.error('[vpaynotify] 投诉落库失败', e);
  }
  return OK_XML;
}
