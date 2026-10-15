/**
 * vpay —— 虚拟支付服务端（云函数）
 * action:
 *   ping        探活（供「环境自检」页确认云函数已部署）
 *   createOrder 生成业务单号 + signData + paySig + signature，返回给前端拉起支付
 *   getOrder    查询单个订单（校验归属）
 *   listOrders  我的订单列表
 *   recheck     兜底：先查本地，未发货则调官方 query_order 补发
 *   listGoods   商品列表（管理端权限代读，见文末说明）
 *   getGoods    单个商品（管理端权限代读）
 *   diagnoseGoods 商品配置体检（价格/链接/发货方式逐条校验，返回可读问题清单）
 *
 * 环境变量（云开发控制台 → 云函数 → vpay → 配置 → 环境变量）：
 *   MP_APPID      小程序 AppID
 *   MP_APP_SECRET 小程序 AppSecret（用于 code2Session / access_token，切勿放前端）
 *   OFFER_ID      虚拟支付 OfferID
 *   APP_KEY       虚拟支付「现网 AppKey」
 */
/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    前端只会看到 -504002 functions execute fail | 145 code exit unexpected。
 *    两个顺序要求，缺一即崩：
 *      ① require('wx-server-sdk') 必须成功
 *         —— 部署时必须选「上传并部署：云端安装依赖」
 *      ② cloud.init() 必须早于任何 cloud.database() 调用，**包括**
 *         require('./wechat.js')：wechat.js 在自身模块顶层就会取 db。
 *         顺序颠倒会让 SDK 抛「please call init first」并终止进程。
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
      '常见原因：① 依赖未安装 —— 右键 cloudfunctions/vpay 选「上传并部署：云端安装依赖」重新部署；' +
      '② 云函数运行时版本过低 —— 在云开发控制台把运行时改为 Nodejs16.13。'
  };
}

const MP_APPID = process.env.MP_APPID || '';
const MP_APP_SECRET = process.env.MP_APP_SECRET || '';
const OFFER_ID = process.env.OFFER_ID || '';
const APP_KEY = process.env.APP_KEY || '';

/** 业务单号：8-32 位，数字/大小写字母与 _-|*@，不能以下划线开头，不可复用 */
function genOutTradeNo() {
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  return `T${Date.now()}${rand}`;
}

exports.main = async (event = {}) => {
  // 启动期失败时给出可读原因，避免只看到 145
  if (BOOT_ERROR) return bootFailure();

  const { action } = event;
  try {
    const { OPENID } = cloud.getWXContext();
    switch (action) {
      case 'ping':
        // 供「环境自检」页探测：能返回就说明函数已部署且依赖完整
        return { ok: true, pong: true, env: process.env.TCB_ENV || '', at: Date.now() };
      case 'createOrder':
        return await createOrder(event, OPENID);
      case 'getOrder':
        return await getOrder(event, OPENID);
      case 'listOrders':
        return await listOrders(OPENID);
      case 'listGoods':
        return await listGoods();
      case 'getGoods':
        return await getGoods(event);
      case 'diagnoseGoods':
        return await diagnoseGoods();
      case 'recheck':
        return await recheck(event, OPENID);
      default:
        return { ok: false, code: 'UNKNOWN_ACTION', msg: '不支持的操作：' + action };
    }
  } catch (e) {
    console.error('[vpay]', action, e);
    return { ok: false, msg: e.message || '服务异常' };
  }
};

/* ------------------------------------------------------------------ */
/* 下单                                                                */
/* ------------------------------------------------------------------ */
/**
 * 环境变量缺失时返回结构化错误。
 * 只给一句「未配置完整」用户无从下手，必须列出**缺哪几个**、去哪儿填。
 */
function missingEnv() {
  const need = [
    ['MP_APPID', MP_APPID],
    ['MP_APP_SECRET', MP_APP_SECRET],
    ['OFFER_ID', OFFER_ID],
    ['APP_KEY', APP_KEY]
  ];
  return need.filter(([, v]) => !v).map(([k]) => k);
}

async function createOrder({ productId, code, quantity = 1 }, openid) {
  const missing = missingEnv();
  if (missing.length) {
    return {
      ok: false,
      code: 'ENV_MISSING',
      missing,
      msg: '云函数环境变量未配置完整，缺少：' + missing.join('、'),
      hint:
        '云开发控制台 →「云函数」→ 选中 vpay →「配置」→「环境变量」添加这 4 个变量后立即生效，无需重新部署。' +
        'OFFER_ID 与 APP_KEY 来自 MP 后台「虚拟支付」页面；MP_APPID / MP_APP_SECRET 在「开发管理 → 开发设置」获取。'
    };
  }
  if (!productId) return { ok: false, code: 'BAD_REQUEST', msg: '缺少 productId' };
  if (!code) return { ok: false, code: 'BAD_REQUEST', msg: '缺少登录凭证 code' };
  if (!openid) return { ok: false, code: 'NO_OPENID', msg: '未能获取 openid，请重新进入小程序' };

  const goodsRes = await db.collection('goods').where({ productId, enabled: true }).limit(1).get();
  const goods = goodsRes.data[0];
  if (!goods) {
    return {
      ok: false,
      code: 'PRODUCT_NOT_FOUND',
      msg: '商品不存在或已下架（productId = ' + productId + '）',
      hint: '确认 goods 集合里存在该 productId 且 enabled 为 true。'
    };
  }

  // 价格必须是「整数分」。NaN / 小数 / 文本都会让下方的 goodsPrice 与后台道具价格不一致，
  // 与其在微信侧报一个看不懂的错，不如在这里拦住并说明原因。
  const priceFen = toFen(goods.price);
  if (priceFen === null) {
    return {
      ok: false,
      code: 'PRICE_INVALID',
      priceRaw: goods.price === undefined ? null : goods.price,
      priceType: typeName(goods.price),
      msg:
        '商品价格未正确配置：price = ' +
        describeValue(goods.price) +
        '。必须是「整数分」，例如 9.90 元填 990',
      hint:
        '云开发控制台 →「数据库」→ goods → 找到 productId = ' +
        productId +
        ' 的记录，把 price 改成数字类型的整数分（不能是文本、不能带小数）。'
    };
  }

  const session = await wx.code2Session({ appid: MP_APPID, secret: MP_APP_SECRET, code });
  const outTradeNo = genOutTradeNo();

  // signData 的字符串要与后续签名使用的完全一致（不要二次序列化）
  const signData = JSON.stringify({
    offerId: OFFER_ID,
    buyQuantity: quantity,
    env: 0, // 0 = 正式环境（现网）。沙箱仅限开发版/体验版工具内调试
    currencyType: 'CNY',
    productId: goods.productId,
    goodsPrice: priceFen, // 单位：分，必须与后台道具价格一致
    outTradeNo,
    attach: JSON.stringify({ productId: goods.productId, title: goods.title })
  });

  const payData = {
    signData,
    mode: 'short_series_goods', // 道具直购
    paySig: wx.calcPaySig('requestVirtualPayment', signData, APP_KEY),
    signature: wx.calcSignature(signData, session.session_key)
  };

  await db.collection('xpay_orders').add({
    data: {
      outTradeNo,
      openid,
      productId: goods.productId,
      goodsTitle: goods.title,
      quantity,
      price: priceFen,
      amount: priceFen * quantity,
      tips: goods.tips || '',
      status: 'pending',
      delivered: false,
      createdAt: new Date()
    }
  });

  return { ok: true, outTradeNo, payData };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */
async function getOrder({ outTradeNo }, openid) {
  const res = await db.collection('xpay_orders').where({ outTradeNo, openid }).limit(1).get();
  return { ok: true, order: res.data[0] || null };
}

async function listOrders(openid) {
  const res = await db
    .collection('xpay_orders')
    .where({ openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return { ok: true, orders: res.data || [] };
}

/* ------------------------------------------------------------------ */
/* 商品目录（管理端权限代读）                                          */
/* ------------------------------------------------------------------ */
/**
 * 为什么商品要由云函数代读，而不是前端直连 goods？
 *
 *   云开发新建集合的默认权限是「仅创建者可读写」。initdb 是用云函数写入的，
 *   记录里没有 _openid；小程序端查询时权限规则会自动追加 _openid == 当前用户，
 *   于是返回**空数组且不报错** —— 首页就永远停在「还没有上架的商品」。
 *
 * 走云函数读（管理端权限，不受权限规则限制）有两个好处：
 *   ① goods 集合即使保持「仅管理端可读写」也能正常工作，少一步控制台配置；
 *   ② 商品表不外泄整行数据，前端只拿到需要展示的字段。
 * 前端仍保留客户端直连优先：权限配好后直连更快，这一路只是兜底。
 */
function pickGoodsFields(g) {
  const priceFen = toFen(g.price);
  return {
    _id: g._id,
    productId: g.productId,
    title: g.title,
    desc: g.desc || '',
    icon: g.icon || '',
    // 归一化后的整数分（无效时为 null）；priceValid 让前端不必重复判断
    price: priceFen,
    priceValid: priceFen !== null,
    priceReason: priceFen === null ? describeValue(g.price) : '',
    sort: g.sort || 0,
    deliveryMode: g.deliveryMode === 'pool' ? 'pool' : 'static',
    tips: g.tips || '',
    notice: g.notice || '',
    templateId: g.templateId || '',
    hasLink: !!(g.link || '').trim(),
    hasPwd: !!(g.pwd || '').trim()
  };
}

async function listGoods() {
  const res = await db
    .collection('goods')
    .where({ enabled: true })
    .orderBy('sort', 'asc')
    .limit(50)
    .get();
  return { ok: true, source: 'server', goods: (res.data || []).map(pickGoodsFields) };
}

async function getGoods({ productId }) {
  if (!productId) return { ok: false, msg: '缺少 productId' };
  const res = await db.collection('goods').where({ productId, enabled: true }).limit(1).get();
  const g = (res.data || [])[0];
  return { ok: true, source: 'server', goods: g ? pickGoodsFields(g) : null };
}

/**
 * 商品配置体检：逐条列出每个商品能不能卖，不能卖的话缺什么。
 *
 * 典型场景：商品记录是手工在控制台录入的，price 漏填或存成了文本，
 * 前端就会显示「¥NaN」，下单到云函数才报错。这里把问题在自检页一次说清，
 * 不必再到数据库里逐行比对。
 */
async function diagnoseGoods() {
  const missing = missingEnv();
  const res = await db.collection('goods').orderBy('sort', 'asc').limit(50).get();
  const all = res.data || [];

  const records = all.map((g) => {
    const priceFen = toFen(g.price);
    const mode = g.deliveryMode === 'pool' ? 'pool' : 'static';
    const problems = [];

    if (g.enabled === false) problems.push('enabled 为 false，用户看不到该商品');
    if (!g.productId) problems.push('缺少 productId（无法与后台道具对应）');
    if (priceFen === null) problems.push('price 不合法：' + describeValue(g.price) + '（必须是正整数分）');
    if (mode === 'static' && !(g.link || '').trim()) {
      problems.push('发货方式为 static，但 link 为空，付款后没有内容可发');
    }

    return {
      productId: g.productId || '(空)',
      title: g.title || '(无标题)',
      price: priceFen,
      priceRaw: g.price === undefined ? null : g.price,
      priceType: typeName(g.price),
      // 记录里实际存在的字段名。价格不合法时这个清单最有用：
      // 一眼就能看出是「字段名叫别的」（如 priceYuan / 价格）还是「压根没填 price」。
      // 只回传字段名、不回传值，且滤掉可能敏感的键名（发货内容相关的键不对外回显）。
      fields: Object.keys(g).filter(
        (k) => k !== '_id' && k !== '_openid' && !/pwd|link|secret|key|token/i.test(k)
      ),
      enabled: g.enabled !== false,
      deliveryMode: mode,
      hasLink: !!(g.link || '').trim(),
      problems,
      sellable: problems.length === 0
    };
  });

  // 示例商品的 price 由 initdb 写入；被手工改动过时可以用 fixDemoGoods 一键还原
  const fixable = records.filter(
    (r) => ['goods_001', 'goods_002'].includes(r.productId) && r.problems.some((p) => p.startsWith('price'))
  ).length;

  return {
    ok: true,
    source: 'server',
    total: records.length,
    sellable: records.filter((r) => r.sellable).length,
    records,
    fixableDemoGoods: fixable,
    envMissing: missing,
    envHint: missing.length
      ? '缺少环境变量：' + missing.join('、') + '（下单必需，不配则无法拉起支付）'
      : ''
  };
}

/* ------------------------------------------------------------------ */
/* 兜底查单                                                            */
/* 前端 success 回调可能丢失，发货以「发货推送」为主、本接口查单为辅        */
/* ------------------------------------------------------------------ */
async function recheck({ outTradeNo }, openid) {
  const res = await db.collection('xpay_orders').where({ outTradeNo, openid }).limit(1).get();
  const order = res.data[0];
  if (!order) return { ok: true, delivered: false, order: null };
  if (order.delivered) return { ok: true, delivered: true, order };

  // 本地仍是未发货 → 主动向微信查单
  try {
    const q = await wx.queryOrder({
      openid,
      outTradeNo,
      appid: MP_APPID,
      secret: MP_APP_SECRET,
      appKey: APP_KEY
    });
    console.log('[vpay] query_order raw =', JSON.stringify(q));
    if (isPaidResult(q)) {
      // 确认已支付 → 交给 deliver 统一发货（幂等）
      await cloud.callFunction({
        name: 'deliver',
        data: { openid, outTradeNo, productId: order.productId, quantity: order.quantity }
      });
      const after = await db.collection('xpay_orders').doc(order._id).get();
      return { ok: true, delivered: !!after.data.delivered, order: after.data };
    }
  } catch (e) {
    console.error('[vpay] 查单失败', e);
  }

  return { ok: true, delivered: false, order };
}

/** 宽松判定官方查单结果是否「已支付」：字段名以官方返回为准，这里做多路径兼容 */
const PAID_FLAGS = ['PAID', 'SUCCESS', 'SUCC', 'DELIVERED', 'FINISHED', 'DONE', '1', '2'];
function isPaidResult(resp) {
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

/* ------------------------------------------------------------------ */
/* 数值归一化（与 miniprogram/utils/format.js 保持同一套判定标准）        */
/* ------------------------------------------------------------------ */
function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return '缺失';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 归一化为「整数分」；不合法返回 null。
 * 数值型字符串（"990"）等价于 990，可以安全地当作同一个值使用；
 * 小数、负数、非数字文本一律判为不合法 —— 价格宁可拦住，也不能猜。
 */
function toFen(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    return null;
  }
  return null;
}

/** 把非法的 price 值描述成一句人话，便于写进错误提示与体检结果 */
function describeValue(v) {
  const t = typeName(v);
  if (t === '缺失' || t === 'null') return '字段缺失（null）';
  if (v === '') return '空字符串';
  if (t === 'number') {
    if (!isFinite(v)) return String(v) + '（不是有效数字）';
    return '数字 ' + v + (Number.isInteger(v) ? '' : '（小数，分必须是整数）');
  }
  if (t === 'string') return '文本「' + String(v) + '」';
  return '类型为 ' + t + ' 的值';
}
