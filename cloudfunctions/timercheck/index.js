/**
 * timercheck —— 定时兜底查单（每 5 分钟一次）
 *
 * 为什么需要它：前端的支付成功回调可能丢失（用户支付后异常退出），
 * 发货推送也可能因网络原因没到。按官方建议，定时主动查单补发货。
 *
 * 环境变量与 vpay 保持一致：
 *   MP_APPID / MP_APP_SECRET / APP_KEY
 */
/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    定时触发的表现就是「触发器有调用记录但每次都失败」。
 *    两个顺序要求，缺一即崩：
 *      ① require('wx-server-sdk') 必须成功
 *         —— 部署时必须选「上传并部署：云端安装依赖」
 *      ② cloud.init() 必须早于任何 cloud.database() 调用，**包括**
 *         require('./wechat.js')：wechat.js 在自身模块顶层就会取 db。
 * ------------------------------------------------------------------ */
let cloud = null;
let BOOT_ERROR = '';
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (e) {
  BOOT_ERROR = (e && e.message) || String(e);
}

// 必须在 init 之后再加载 wechat.js（它在模块顶层即调用 cloud.database()）
const wx = require('./wechat.js');

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
      '常见原因：① 依赖未安装 —— 右键 cloudfunctions/timercheck 选「上传并部署：云端安装依赖」重新部署；' +
      '② 云函数运行时版本过低 —— 在云开发控制台把运行时改为 Nodejs16.13。'
  };
}

const MP_APPID = process.env.MP_APPID || '';
const MP_APP_SECRET = process.env.MP_APP_SECRET || '';
const APP_KEY = process.env.APP_KEY || '';

/** 只查最近 2 小时内、未发货、未退款的订单，避免无谓调用 */
const LOOKBACK_MS = 2 * 3600 * 1000;

exports.main = async () => {
  // 启动期失败时给出可读原因，避免日志里只有 145
  if (BOOT_ERROR) return bootFailure();

  if (!MP_APPID || !MP_APP_SECRET || !APP_KEY) {
    return { ok: false, msg: '环境变量未配置完整' };
  }
  const since = new Date(Date.now() - LOOKBACK_MS);

  const res = await db
    .collection('xpay_orders')
    .where({ delivered: false, status: 'pending', createdAt: db.command.gte(since) })
    .limit(50)
    .get();

  const orders = res.data || [];
  const stat = { checked: orders.length, delivered: 0, stillPending: 0, errors: 0 };

  for (const order of orders) {
    try {
      const q = await wx.queryOrder({
        openid: order.openid,
        outTradeNo: order.outTradeNo,
        appid: MP_APPID,
        secret: MP_APP_SECRET,
        appKey: APP_KEY
      });
      if (!isPaid(q)) {
        stat.stillPending++;
        continue;
      }
      await cloud.callFunction({
        name: 'deliver',
        data: {
          openid: order.openid,
          outTradeNo: order.outTradeNo,
          productId: order.productId,
          quantity: order.quantity || 1
        }
      });
      stat.delivered++;
      console.log('[timercheck] 兜底补发货成功', order.outTradeNo);
    } catch (e) {
      stat.errors++;
      console.error('[timercheck] 查单/发货失败', order.outTradeNo, e.message);
    }
  }

  console.log('[timercheck] 本次统计', JSON.stringify(stat));
  return Object.assign({ ok: true }, stat);
};

/** 宽松判定是否已支付；字段名以官方返回为准，这里做多路径兼容 */
const PAID_FLAGS = ['PAID', 'SUCCESS', 'SUCC', 'DELIVERED', 'FINISHED', 'DONE', '1', '2'];
function isPaid(resp) {
  const hits = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (/status|state|pay_?state|order_?status/i.test(k)) hits.push(String(v).toUpperCase());
      if (v && typeof v === 'object') walk(v);
    });
  })(resp);
  return hits.some((h) => PAID_FLAGS.includes(h));
}
