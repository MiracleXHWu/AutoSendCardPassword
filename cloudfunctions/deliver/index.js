/**
 * deliver —— 统一发货入口（云函数）
 * 被两个调用方复用：
 *   1) vpaynotify  收到 xpay_goods_deliver_notify 发货推送后调用（主路径）
 *   2) vpay/timercheck  兜底查单确认已支付后调用
 *
 * 幂等原则：同一个 outTradeNo（或平台单号 wxOrderId）只会真正发一次货。
 */
/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    前端只会看到 -504002 functions execute fail | 145 code exit unexpected。
 *    因此把「依赖加载 + init + 取 db」全部纳入保护，失败时改为返回可读错误。
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

/** 启动失败时返回可操作的错误，而不是让进程崩溃 */
function bootFailure() {
  return {
    ok: false,
    code: 'FUNCTION_BOOT_FAIL',
    error: BOOT_ERROR,
    msg: '云函数启动失败：' + BOOT_ERROR,
    hint:
      '常见原因：① 依赖未安装 —— 右键 cloudfunctions/deliver 选「上传并部署：云端安装依赖」重新部署；' +
      '② 云函数运行时版本过低 —— 在云开发控制台把运行时改为 Nodejs16.13。'
  };
}

exports.main = async (p = {}) => {
  // 启动期失败时给出可读原因，避免上游只看到 145
  if (BOOT_ERROR) return bootFailure();

  try {
    const r = await deliver(p);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    console.error('[deliver] 失败', e);
    return { ok: false, msg: e.message || '发货失败' };
  }
};

async function deliver({ openid, outTradeNo, wxOrderId, productId, quantity = 1 }) {
  if (!openid || !outTradeNo) throw new Error('缺少 openid 或 outTradeNo');

  // ① 幂等：已发货则直接返回。
  //    优先用平台单号 wx_order_id 去重（官方建议），其次用业务单号 outTradeNo。
  if (wxOrderId) {
    const byWx = await db
      .collection('xpay_orders')
      .where({ wxOrderId, delivered: true })
      .limit(1)
      .get();
    if (byWx.data[0]) {
      console.log('[deliver] 幂等命中（wx_order_id），跳过重复发货', wxOrderId);
      return { duplicated: true, order: byWx.data[0] };
    }
  }

  const orderRes = await db.collection('xpay_orders').where({ outTradeNo }).limit(1).get();
  const order = orderRes.data[0];
  if (order && order.delivered) {
    console.log('[deliver] 幂等命中（outTradeNo），跳过重复发货', outTradeNo);
    return { duplicated: true, order };
  }

  // ② 找商品配置
  const pid = productId || (order && order.productId);
  const goodsRes = await db.collection('goods').where({ productId: pid }).limit(1).get();
  const goods = goodsRes.data[0];
  if (!goods) throw new Error('商品不存在：' + pid);

  // ③ 生成发货内容
  const content = await buildContent(goods, quantity, { outTradeNo, openid });

  // ④ 落库（已支付 + 已发货）
  const now = new Date();
  const patch = {
    status: 'delivered',
    delivered: true,
    wxOrderId: wxOrderId || (order && order.wxOrderId) || '',
    deliveredAt: now,
    content
  };
  let saved;
  if (order) {
    await db.collection('xpay_orders').doc(order._id).update({ data: patch });
    saved = Object.assign({}, order, patch);
  } else {
    // 极端情况：推送先到、下单记录缺失，补建一条避免丢单
    saved = Object.assign(
      {
        outTradeNo,
        openid,
        productId: pid,
        goodsTitle: goods.title,
        quantity,
        price: goods.price,
        amount: (goods.price || 0) * quantity,
        createdAt: now
      },
      patch
    );
    await db.collection('xpay_orders').add({ data: saved });
  }

  // ⑤ 通知用户（失败不影响发货，内容在「我的订单」里永远可查）
  await notifyUser({ openid, goods, content, outTradeNo });

  return { duplicated: false, order: saved };
}

/* ------------------------------------------------------------------ */
/* 生成发货内容                                                        */
/*   static：所有买家拿到同一份链接/提取码（适合卖自己的一份资料）           */
/*   pool  ：从卡密池里按序分配，一人一份、发完即止（适合卖兑换码/账号）       */
/* ------------------------------------------------------------------ */
async function buildContent(goods, quantity, ctx) {
  if (goods.deliveryMode === 'pool') {
    const items = [];
    for (let i = 0; i < quantity; i++) {
      items.push(await pickOneCard(goods.productId, ctx));
    }
    return { mode: 'pool', items };
  }
  return {
    mode: 'static',
    items: [{ link: goods.link || '', pwd: goods.pwd || '', raw: goods.raw || '' }]
  };
}

/**
 * 卡密池并发安全分配：
 * 先取一条未使用的，再用「带 used:false 条件」的更新做乐观锁，
 * 只有 stats.updated === 1 才算真正抢到，否则重试下一条。
 */
async function pickOneCard(productId, ctx) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await db
      .collection('cards')
      .where({ productId, used: false })
      .orderBy('seq', 'asc')
      .limit(1)
      .get();
    const card = r.data[0];
    if (!card) throw new Error('卡密库存不足，请及时补货');

    const up = await db
      .collection('cards')
      .where({ _id: card._id, used: false })
      .update({
        data: {
          used: true,
          orderNo: ctx.outTradeNo,
          openid: ctx.openid,
          usedAt: new Date()
        }
      });

    if (up.stats && up.stats.updated === 1) {
      return { link: card.link || '', pwd: card.pwd || '', raw: card.raw || '' };
    }
  }
  throw new Error('卡密分配冲突，请重试');
}

/* ------------------------------------------------------------------ */
/* 通知用户                                                            */
/*   客服消息：支付后 48 小时内可主动下发，文本里的网盘链接会变成可点链接      */
/*   订阅消息：只是「提醒」，字段长度有限（thing 限 20 个字符），放不下完整链接   */
/* ------------------------------------------------------------------ */
function buildText(goods, content) {
  const lines = [`【${goods.title}】购买成功，下载信息如下：`];
  content.items.forEach((it, i) => {
    if (content.items.length > 1) lines.push(`— 第 ${i + 1} 份 —`);
    if (it.link) lines.push(`链接：${it.link}`);
    if (it.pwd) lines.push(`提取码：${it.pwd}`);
    if (!it.link && it.raw) lines.push(it.raw);
  });
  if (goods.tips) lines.push(goods.tips);
  lines.push('若链接失效，可在小程序「我的订单」中重新查看。');
  return lines.join('\n');
}

async function notifyUser({ openid, goods, content, outTradeNo }) {
  // 1) 客服消息（首选，可携带完整链接）
  try {
    await cloud.openapi.customerServiceMessage.send({
      touser: openid,
      msgtype: 'text',
      text: { content: buildText(goods, content) }
    });
    console.log('[deliver] 客服消息已发送', outTradeNo);
  } catch (e) {
    console.warn('[deliver] 客服消息发送失败（多因超过 48 小时或用户未与服务交互）', e.errCode, e.errMsg);
  }

  // 2) 一次性订阅消息（可选，模板 ID 配在商品上）
  if (goods.templateId) {
    try {
      const data = {};
      const fieldName = goods.templateFieldName || 'thing1';
      data[fieldName] = { value: (goods.templateValue || '发货完成，请回小程序查看').slice(0, 20) };
      if (goods.templateFieldDate) {
        data[goods.templateFieldDate] = { value: formatNow() };
      }
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: goods.templateId,
        page: `pages/order/order?outTradeNo=${outTradeNo}`,
        data,
        miniprogramState: 'formal'
      });
      console.log('[deliver] 订阅消息已发送', outTradeNo);
    } catch (e) {
      console.warn('[deliver] 订阅消息发送失败', e.errCode, e.errMsg);
    }
  }
}

function formatNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 转北京时间
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}`;
}
