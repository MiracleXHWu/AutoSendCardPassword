/**
 * 支付编排
 * ---------------------------------------------------------------
 * 通道策略（由 config.payChannel 决定）：
 *
 *   qrcode（默认）
 *     走 faka 自己的收银台：POST /user/api/order/trade 返回 url，本端把 url
 *     渲染成二维码，用户长按识别在微信内置浏览器完成支付。支付宝、微信、
 *     V免签等具体用什么，取决于发卡后台启用了哪个支付插件，小程序端不用改。
 *     这是唯一「不申请任何资质就能跑通」的方案，也是支付宝的实际落地路径。
 *
 *   vpay（预留）
 *     微信虚拟支付：小程序内原生拉起。签名必须在服务端算（OfferID + AppKey），
 *     由 acg-faka 的 Wx::vpaySign 提供。未配置 OfferID 时自动回退 qrcode。
 *
 * 无论哪种通道，发货都只认服务端状态：
 *   前端支付 success 回调不能作为发货依据（用户付款后直接杀进程就丢了），
 *   所以这里一律轮询 /user/api/order/state，status=1 才算成功。
 */
const config = require('../config.js');
const api = require('./api.js');
const http = require('./request.js');

/** 余额 / 系统支付通道的 handle */
const SYSTEM_HANDLE = '#system';

/**
 * 挑选默认支付通道
 * 优先按 config.preferPayHandle 顺序匹配 handle，其次取第一个非余额通道。
 */
/** 同一家聚合支付插件（如 V免签）可能给多个通道同一个 handle，靠名称区分 */
const CHANNEL_ALIAS = {
  alipay: ['alipay', '支付宝'],
  wxpay: ['wxpay', 'wechat', '微信'],
  wechat: ['wechat', 'wxpay', '微信']
};

function matchChannel(channel, keyword) {
  const hay = ((channel.handle || '') + ' ' + (channel.name || '')).toLowerCase();
  const words = CHANNEL_ALIAS[keyword] || [keyword];
  return words.some(function (w) {
    return hay.indexOf(String(w).toLowerCase()) >= 0;
  });
}

function pickChannel(channels) {
  const list = Array.isArray(channels) ? channels : [];
  if (!list.length) return null;

  const prefers = config.preferPayHandle || [];
  for (let i = 0; i < prefers.length; i++) {
    const hit = list.filter(function (c) {
      return matchChannel(c, prefers[i]);
    })[0];
    if (hit) return hit;
  }
  return list.filter(function (c) {
    return c.handle !== SYSTEM_HANDLE;
  })[0] || list[0];
}

/** 实际生效的支付通道类型 */
function channelType() {
  if (config.payChannel === 'vpay' && config.vpay && config.vpay.offerId) return 'vpay';
  return 'qrcode';
}

/**
 * 提交订单
 * @param {object} payload faka trade 的原始参数（item_id/num/contact/pay_id/...）
 * @returns {Promise<{trade:object, type:'qrcode'|'vpay'|'free'}>}
 */
async function submit(payload) {
  const trade = await api.trade(payload);

  if (trade.paid) {
    // 0 元单、优惠券全抵扣、余额支付：平台已直接发货，没有收银台
    return { trade: trade, type: 'free' };
  }
  if (!trade.url) {
    throw http.makeError('下单成功但未返回支付地址，请到「我的订单」查看或联系客服', -20);
  }

  const type = channelType();
  if (type === 'vpay') return { trade: trade, type: 'vpay' };
  return { trade: trade, type: 'qrcode' };
}

/**
 * 微信虚拟支付：向服务端要签名后拉起
 * 服务端返回 { signData, paySig, signature, mode }，字段原样透传给 wx.requestVirtualPayment。
 */
function requestVpay(trade) {
  return api
    .vpaySign({
      tradeNo: trade.tradeNo,
      amount: trade.amount,
      offerId: config.vpay.offerId,
      env: config.vpay.env,
      mode: config.vpay.mode
    })
    .then(function (res) {
      return new Promise(function (resolve, reject) {
        if (!wx.requestVirtualPayment) {
          reject(http.makeError('当前微信版本不支持虚拟支付，请升级微信', -21));
          return;
        }
        wx.requestVirtualPayment({
          signData: res.signData,
          paySig: res.paySig,
          signature: res.signature,
          mode: res.mode || config.vpay.mode,
          success: function () {
            resolve(true);
          },
          fail: function (e) {
            const canceled = /cancel/i.test((e && e.errMsg) || '');
            reject(
              Object.assign(http.makeError(canceled ? '已取消支付' : '支付未完成', canceled ? -22 : -23), {
                canceled: canceled
              })
            );
          }
        });
      });
    });
}

/**
 * 轮询支付状态
 * @param {string} tradeNo
 * @param {(n:number)=>void} [onTick]
 * @returns {Promise<{paid:boolean, state:object|null}>}
 */
async function watch(tradeNo, onTick) {
  const times = (config.payPoll && config.payPoll.times) || 30;
  const interval = (config.payPoll && config.payPoll.interval) || 2000;

  for (let i = 0; i < times; i++) {
    try {
      const state = await api.getOrderState(tradeNo);
      if (typeof onTick === 'function') onTick(i + 1);
      if (state.paid) return { paid: true, state: state };
    } catch (e) {
      // 网络抖动不应中断等待，继续下一轮
      if (typeof onTick === 'function') onTick(i + 1);
    }
    await new Promise(function (r) {
      setTimeout(r, interval);
    });
  }
  return { paid: false, state: null };
}

/** 取发货内容 */
async function fetchSecret(tradeNo, password) {
  return api.getSecret(tradeNo, password);
}

/**
 * 重建 faka 收银台链接
 * faka 下单时返回的 url 有两种：
 *   1. 平台自建收银台：/user/pay/order.{tradeNo}.1（本地渲染）或 .2（表单提交）
 *   2. 第三方网关跳转：直接是外部地址，必须用原样保存的值
 * 因此「继续支付」优先用保存的 url，取不到时才按规则重建；重建只对第 1 种有效。
 */
function buildCashierUrl(tradeNo, type) {
  const no = String(tradeNo == null ? '' : tradeNo).trim();
  if (!no) return '';
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  return base + '/user/pay/order.' + no + '.' + (Number(type) === 2 ? 2 : 1);
}

/** 从收银台链接里取出提交类型（1 本地渲染 / 2 表单提交），非自建链接返回 0 */
function cashierType(url) {
  const m = /\/user\/pay\/order\.[^./]+\.([12])$/.exec(String(url || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * 解析收银台链接里的通道特征，用于页面文案（不是必须，缺省也能跑）
 */
function describeLink(url) {
  const u = String(url || '').toLowerCase();
  if (u.indexOf('alipay') >= 0 || u.indexOf('alipayqr') >= 0) return { label: '支付宝', icon: 'alipay' };
  if (u.indexOf('weixin') >= 0 || u.indexOf('wxpay') >= 0) return { label: '微信支付', icon: 'wechat' };
  return { label: '在线支付', icon: 'pay' };
}

module.exports = {
  pickChannel,
  channelType,
  submit,
  requestVpay,
  watch,
  fetchSecret,
  describeLink,
  buildCashierUrl,
  cashierType,
  SYSTEM_HANDLE
};
