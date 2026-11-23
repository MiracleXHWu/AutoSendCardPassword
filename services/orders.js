/**
 * 本地订单簿
 * ---------------------------------------------------------------
 * 没有云数据库，订单列表靠「本机保存的订单号 + 实时回查状态」：
 *   · 下单成功 → 把 tradeNo 与商品快照写进 storage；
 *   · 打开列表 → 对每个 tradeNo 调 /user/api/order/state 取真实状态；
 *   · 卡密不进本地，永远是点开详情时向 /user/api/index/secret 现取，
 *     避免明文卡密长期躺在手机里。
 *
 * 换设备/清缓存后本地簿会丢，此时用「手机号查单」从服务端找回。
 */
const api = require('./api.js');

const KEY = 'orders.local';
const MAX = 200;

function read() {
  try {
    const rows = wx.getStorageSync(KEY);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function write(rows) {
  const list = (rows || []).slice(0, MAX);
  try {
    wx.setStorageSync(KEY, list);
  } catch (e) {
    /* 存储满时静默失败，不影响主流程 */
  }
  return list;
}

/** 按时间倒序 */
function list() {
  return read().sort(function (a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function get(tradeNo) {
  return (
    read().filter(function (o) {
      return String(o.tradeNo) === String(tradeNo);
    })[0] || null
  );
}

/** 新增或更新一条；返回写入后的订单 */
function upsert(order) {
  if (!order || !order.tradeNo) return null;
  const rows = read();
  const idx = rows.findIndex(function (o) {
    return String(o.tradeNo) === String(order.tradeNo);
  });
  const merged =
    idx >= 0
      ? Object.assign({}, rows[idx], order)
      : Object.assign({ createdAt: Date.now(), status: 0, paid: false }, order);

  if (idx >= 0) rows[idx] = merged;
  else rows.unshift(merged);

  write(rows);
  return merged;
}

function patch(tradeNo, fields) {
  const rows = read();
  const idx = rows.findIndex(function (o) {
    return String(o.tradeNo) === String(tradeNo);
  });
  if (idx < 0) return null;
  rows[idx] = Object.assign({}, rows[idx], fields);
  write(rows);
  return rows[idx];
}

function remove(tradeNo) {
  const rows = read().filter(function (o) {
    return String(o.tradeNo) !== String(tradeNo);
  });
  write(rows);
  return rows;
}

/** 回查单个订单状态，失败时保留原状态不抛错 */
function refresh(tradeNo) {
  return api
    .getOrderState(tradeNo)
    .then(function (state) {
      const cur = get(tradeNo) || {};
      return patch(tradeNo, {
        status: state.status,
        paid: state.paid,
        amount: state.amount || cur.amount || 0,
        amountText: state.amountText || cur.amountText || '',
        // payTime 只记第一次变为已支付的时间，后续回查不再覆盖
        payTime: state.paid ? cur.payTime || Date.now() : 0,
        syncedAt: Date.now()
      });
    })
    .catch(function () {
      return get(tradeNo);
    });
}

/**
 * 批量回查（并发 3）
 * @returns {Promise<Array>} 更新后的本地订单
 */
function refreshAll() {
  const rows = list();
  if (!rows.length) return Promise.resolve([]);

  const queue = rows.slice();
  const concurrency = 3;

  function worker() {
    const task = queue.shift();
    if (!task) return Promise.resolve();
    return refresh(task.tradeNo).then(worker);
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, rows.length); i++) workers.push(worker());
  return Promise.all(workers).then(function () {
    return list();
  });
}

/** 统计：待支付 / 已支付（含已发货） */
function stats() {
  const rows = read();
  return rows.reduce(
    function (acc, o) {
      if (o.paid) acc.paid += 1;
      else acc.unpaid += 1;
      return acc;
    },
    { paid: 0, unpaid: 0, total: rows.length }
  );
}

function clear() {
  return write([]);
}

module.exports = {
  list,
  get,
  upsert,
  patch,
  remove,
  refresh,
  refreshAll,
  stats,
  clear,
  KEY
};
