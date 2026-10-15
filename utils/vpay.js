/**
 * 虚拟支付前端服务层
 * 只做四件事：校验环境 → 请求云函数拿签名 payData → 拉起支付 → 轮询发货状态
 * 注意：签名（paySig / signature）必须在云函数里算，前端一行都不能算。
 *
 * 所有云调用统一经过 utils/cloud.js 的环境守卫：
 *   - 环境不可用会「熔断」，不再反复发请求刷屏；
 *   - 报错文案会被翻译成可操作的中文提示，并带 e.envIssue 标记。
 */
const cloud = require('./cloud.js');

const FN_VPAY = 'vpay';
const FN_INITDB = 'initdb';

/**
 * 云函数返回的「配置类」错误码。
 * 它们的共同点是：文案长、且用户必须照着改配置才能继续，
 * 所以不走 toast（会被截断），由页面用弹窗完整展示并给出跳转指引。
 */
const CONFIG_CODES = ['ENV_MISSING', 'PRICE_INVALID', 'PRODUCT_NOT_FOUND'];

/* ------------------------------------------------------------------ */
/* 统一错误处理                                                        */
/* ------------------------------------------------------------------ */
/** 环境已熔断时抛出，避免无谓的网络请求 */
function envError() {
  return Object.assign(new Error(cloud.getState().message || '云开发环境未就绪'), {
    envIssue: true
  });
}

/** 把原始异常转成带 envIssue 标记的业务异常 */
function normalize(e, fallback) {
  const envIssue = cloud.isEnvError(e);
  const err = new Error(cloud.friendly(e, fallback));
  err.envIssue = envIssue;
  if (!envIssue) console.error('[vpay]', fallback, e);
  return err;
}

/* ------------------------------------------------------------------ */
/* 通用云函数调用                                                      */
/* ------------------------------------------------------------------ */
function callFn(name, data) {
  if (cloud.isBlocked()) return Promise.reject(envError());

  return wx.cloud
    .callFunction({ name, data })
    .then((res) => {
      const r = (res && res.result) || {};
      if (r.ok === false) {
        // 云函数返回的业务错误带上 code / missing / hint。
        // 这些字段必须挂到 Error 上：toast 只能显示十来个字，长文案会被截断，
        // 真正可操作的提示（缺哪个环境变量、去哪填）只能靠弹窗展示。
        const detail = [r.msg || '服务异常', r.hint].filter(Boolean).join('\n');
        const err = new Error(detail);
        err.fromFn = true; // 标记来源，避免下面的 catch 把它当成网络异常重新包装
        err.code = r.code || 'FN_ERROR';
        err.missing = r.missing || [];
        err.fnHint = r.hint || '';
        err.priceRaw = r.priceRaw;
        throw err;
      }
      cloud.clearBlocked(); // 能跑通说明环境已恢复
      return r;
    })
    .catch((e) => {
      // 已经带上 code 的业务错误原样抛出，别再被 normalize 覆盖掉文案
      if (e && e.fromFn) throw e;
      throw normalize(e, '网络异常，请重试');
    });
}

/* ------------------------------------------------------------------ */
/* 商品查询（走同一个守卫，页面无需重复处理 -501000）                     */
/* ------------------------------------------------------------------ */
/**
 * 商品读取为什么有两条路径
 * ------------------------------------------------------------------
 *   新建集合的默认权限是「仅创建者可读写」。initdb 是用云函数写入的，记录里
 *   没有 _openid；小程序端查询时权限规则会自动追加 _openid == 当前用户，
 *   结果就是**返回空数组、还不报错** —— 首页永远停在「还没有上架的商品」。
 *
 *   所以：先客户端直连（权限配好后最快），一旦读不到（空数组或权限报错），
 *   就改用 vpay 云函数以管理端权限代读。两条路径的差异本身就是一个精准的
 *   诊断信号：服务端读得到、客户端读不到 ⇒ 就是 goods 集合读权限没开放。
 */

/** 客户端直连读 goods；异常不外抛，交给调用方决定是否降级 */
async function clientGoods(where, limit) {
  try {
    let q = wx.cloud.database().collection('goods').where(where);
    if (limit) q = q.limit(limit);
    const res = await q.orderBy('sort', 'asc').get();
    return { ok: true, list: res.data || [] };
  } catch (e) {
    return { ok: false, list: [], error: e };
  }
}

/**
 * 商品列表
 * @returns {Promise<{list:Array, source:'client'|'server', needFixPermission:boolean, serverFallback:boolean}>}
 *   source            本次数据实际来自哪条路径
 *   needFixPermission 服务端读得到、客户端读不到 ⇒ goods 读权限未开放
 *   serverFallback    云函数兜底是否可用（vpay 未部署/未更新时为 false）
 */
async function fetchGoodsList() {
  if (cloud.isBlocked()) throw envError();

  const client = await clientGoods({ enabled: true });
  if (client.ok && client.list.length) {
    cloud.clearBlocked();
    return { list: client.list, source: 'client', needFixPermission: false, serverFallback: true };
  }
  // 环境类错误：再调云函数也一样失败，直接走引导卡片，不做无谓的第二次请求
  if (!client.ok && cloud.isEnvError(client.error)) throw normalize(client.error, '商品加载失败');

  const server = await serverGoods('listGoods', {});
  if (server.ok) {
    cloud.clearBlocked();
    return {
      list: server.list,
      source: 'server',
      needFixPermission: server.list.length > 0,
      serverFallback: true
    };
  }

  // 客户端本身没报错（拿到空数组）⇒ 环境是通的，只是数据库里确实没有商品，
  // 或者云函数兜底这条腿还没打通（vpay 未重新部署），把原因一并带回去展示
  if (client.ok) {
    cloud.clearBlocked();
    return {
      list: [],
      source: 'client',
      needFixPermission: false,
      serverFallback: false,
      serverReason: server.reason || ''
    };
  }

  const err = new Error(
    [
      '客户端直连失败：' + cloud.friendly(client.error, '未知原因'),
      server.reason ? '云函数代读失败：' + server.reason : ''
    ]
      .filter(Boolean)
      .join('；')
  );
  err.envIssue = !!server.envIssue;
  throw err;
}

/** 调 vpay 以管理端权限代读商品；失败时回传原因，不抛异常 */
async function serverGoods(action, payload) {
  try {
    const r = await callFn(FN_VPAY, Object.assign({ action }, payload));
    const g = r.goods;
    return { ok: true, list: Array.isArray(g) ? g : g ? [g] : [] };
  } catch (e) {
    return { ok: false, list: [], reason: e.message || '调用失败', envIssue: !!e.envIssue };
  }
}

/**
 * 单个商品
 * @returns {Promise<{goods:Object|null, source:'client'|'server', needFixPermission:boolean}>}
 */
async function fetchGoods(productId) {
  if (!productId) return { goods: null, source: 'client', needFixPermission: false };
  if (cloud.isBlocked()) throw envError();

  const client = await clientGoods({ productId, enabled: true }, 1);
  if (client.ok && client.list.length) {
    cloud.clearBlocked();
    return { goods: client.list[0], source: 'client', needFixPermission: false };
  }
  if (!client.ok && cloud.isEnvError(client.error)) throw normalize(client.error, '商品加载失败');

  const server = await serverGoods('getGoods', { productId });
  if (server.ok) {
    cloud.clearBlocked();
    return {
      goods: server.list[0] || null,
      source: 'server',
      needFixPermission: server.list.length > 0
    };
  }
  if (client.ok) {
    cloud.clearBlocked();
    return { goods: null, source: 'client', needFixPermission: false };
  }
  throw normalize(client.error, '商品加载失败');
}

/* ------------------------------------------------------------------ */
/* 商品配置体检 / 修复                                                  */
/* ------------------------------------------------------------------ */
/**
 * 逐条体检 goods 记录，返回 { total, sellable, records, envMissing, fixableDemoGoods }。
 * 商品是手工在控制台录入时，price 很容易漏填或存成文本，前端就显示「¥NaN」，
 * 且要到下单才暴露。这个接口把它变成一次可提前查看的检查。
 */
function diagnoseGoods() {
  return callFn(FN_VPAY, { action: 'diagnoseGoods' });
}

/**
 * 修复 initdb 写入的示例商品（goods_001 / goods_002）的价格字段。
 * 只碰这两个 productId —— 自建商品的价格必须由用户自己确认，猜价格等于收错钱。
 * @returns {Promise<string[]>} initdb 返回的执行日志
 */
function fixDemoGoods() {
  return callFn(FN_INITDB, { action: 'fixDemoGoods' });
}

/* ------------------------------------------------------------------ */
/* 环境校验                                                            */
/* ------------------------------------------------------------------ */
/** 版本号比较：v1 > v2 返回 1 */
function compareVersion(v1, v2) {
  const a = String(v1).split('.').map(Number);
  const b = String(v2).split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const n1 = a[i] || 0;
    const n2 = b[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/** 基础库是否支持虚拟支付（2.19.2+） */
function checkBaseLib() {
  const sys = wx.getSystemInfoSync();
  const ok = compareVersion(sys.SDKVersion, '2.19.2') >= 0 || wx.canIUse('requestVirtualPayment');
  if (!ok) {
    wx.showModal({ title: '版本过低', content: '请升级微信后再购买', showCancel: false });
  }
  return ok;
}

/** iOS 端要求微信客户端 >= 8.0.68 */
function checkIosVersion() {
  const sys = wx.getSystemInfoSync();
  if (sys.platform !== 'ios') return true;
  const cur = String(sys.version).split('.').map(Number);
  const base = [8, 0, 68];
  for (let i = 0; i < 3; i++) {
    if ((cur[i] || 0) > base[i]) return true;
    if ((cur[i] || 0) < base[i]) break;
  }
  wx.showModal({
    title: '提示',
    content: '请先将微信更新至最新版，再进行支付',
    showCancel: false
  });
  return false;
}

/** 取 wx.login 的 code，用于云函数换取 session_key 计算 signature */
function getLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('获取登录凭证失败'))),
      fail: () => reject(new Error('获取登录凭证失败'))
    });
  });
}

/** 发起支付：返回 { outTradeNo, payData } */
async function requestPay(productId) {
  const code = await getLoginCode();
  return callFn(FN_VPAY, { action: 'createOrder', productId, code });
}

/** 拉起虚拟支付 */
function launchPay(payData) {
  return new Promise((resolve, reject) => {
    wx.requestVirtualPayment({
      ...payData,
      success: () => resolve(true),
      // 用户取消不算失败，单独标识，避免误报
      fail: (err) =>
        reject(
          Object.assign(new Error(err.errMsg || '支付未完成'), {
            errCode: err.errCode,
            canceled: /cancel/i.test(err.errMsg || '')
          })
        )
    });
  });
}

/**
 * 轮询自己的服务器，等待发货推送落库
 * 前端 success 回调不作为发货依据，必须回服务端确认
 */
async function waitDelivered(outTradeNo, { times = 8, interval = 1500, onTick } = {}) {
  for (let i = 0; i < times; i++) {
    const r = await callFn(FN_VPAY, { action: 'recheck', outTradeNo });
    if (typeof onTick === 'function') onTick(i);
    if (r.delivered) return r.order;
    await new Promise((res) => setTimeout(res, interval));
  }
  return null;
}

/** 完整购买流程 */
async function buy(productId) {
  if (cloud.isBlocked()) {
    const st = cloud.getState();
    wx.showModal({
      title: st.title || '云环境未就绪',
      content: st.message || '请先完成云开发环境配置后再购买。',
      confirmText: '查看指引',
      cancelText: '取消',
      confirmColor: '#059a57',
      success: (r) => {
        if (r.confirm) cloud.goSetup();
      }
    });
    return { ok: false, reason: 'env' };
  }

  if (!checkBaseLib()) return { ok: false, reason: 'baselib' };
  if (!checkIosVersion()) return { ok: false, reason: 'ios_version' };

  wx.showLoading({ title: '下单中', mask: true });
  let outTradeNo = '';
  try {
    const r = await requestPay(productId);
    outTradeNo = r.outTradeNo;
    wx.hideLoading();
    await launchPay(r.payData);
  } catch (e) {
    wx.hideLoading();
    if (e.canceled) {
      wx.showToast({ title: '已取消支付', icon: 'none' });
      return { ok: false, reason: 'canceled', outTradeNo };
    }
    if (e.envIssue) {
      cloud.showGuide(true);
      return { ok: false, reason: 'env' };
    }
    // 配置类错误（缺环境变量 / 价格不合法 / 商品不存在）一律交回页面用弹窗说明。
    // 这类错误文案长且必须可照做，toast 只显示十来个字，等于没说。
    if (CONFIG_CODES.includes(e.code)) {
      return {
        ok: false,
        reason: 'config',
        code: e.code,
        missing: e.missing || [],
        message: e.message,
        hint: e.fnHint || '',
        outTradeNo
      };
    }
    wx.showToast({ title: e.message || '支付失败', icon: 'none' });
    return { ok: false, reason: 'error', message: e.message, outTradeNo };
  }

  wx.hideLoading();
  wx.showLoading({ title: '发货中', mask: true });
  let order = null;
  try {
    order = await waitDelivered(outTradeNo);
  } catch (e) {
    console.warn('[buy] 轮询发货中断', e.message);
  }
  wx.hideLoading();
  return { ok: true, outTradeNo, order };
}

module.exports = {
  callFn,
  fetchGoodsList,
  fetchGoods,
  diagnoseGoods,
  fixDemoGoods,
  buy,
  waitDelivered,
  compareVersion,
  CONFIG_CODES,
  FN_VPAY
};
