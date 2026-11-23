// pages/confirm/confirm.js —— 确认订单：联系方式、支付通道、验证码、提交
const api = require('../../services/api.js');
const auth = require('../../services/auth.js');
const orders = require('../../services/orders.js');
const pay = require('../../services/pay.js');
const format = require('../../utils/format.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

function requestNo() {
  return 'wx' + Date.now() + Math.floor(Math.random() * 1000);
}

Page({
  data: {
    loading: true,
    error: '',
    detail: null,
    num: 1,
    race: '',
    sku: {},
    skuText: '',
    totalText: '',
    contact: '',
    contactLabel: '联系方式',
    contactPlaceholder: '手机号 / 邮箱 / QQ',
    password: '',
    needPassword: false,
    channels: [],
    payId: 0,
    payName: '',
    captchaImg: '',
    captcha: '',
    needCaptcha: false,
    widget: [],
    widgetValues: {},
    submitting: false,
    phoneTip: ''
  },

  onLoad(query) {
    this.id = Number(query.id);
    const draft = app.globalData.draft;
    if (draft && String(draft.detail.id) === String(query.id)) {
      this.applyDraft(draft);
    } else {
      this.loadFresh();
    }
  },

  onShow() {
    // 从登录页返回后刷新手机号
    const phone = auth.getPhone();
    if (phone && !this.data.contact) this.setData({ contact: phone });
  },

  applyDraft(draft) {
    const d = draft.detail;
    this.setData({
      loading: false,
      detail: d,
      num: draft.num,
      race: draft.race,
      sku: draft.sku,
      skuText: this.describeSku(draft.race, draft.sku),
      contact: auth.getPhone() || '',
      contactLabel: format.contactLabel(d.contactType),
      contactPlaceholder: format.contactPlaceholder(d.contactType),
      needPassword: d.passwordStatus,
      needCaptcha: d.tradeCaptcha,
      widget: d.widget || [],
      widgetValues: this.initWidget(d.widget || [])
    });
    this.afterInit();
  },

  async loadFresh() {
    try {
      const d = await api.getCommodityDetail(this.id);
      const race = d.races.length ? d.races[0].name : '';
      const sku = {};
      d.skuGroups.forEach(function (g) {
        if (g.values.length) sku[g.name] = g.values[0];
      });
      this.setData({
        loading: false,
        detail: d,
        num: d.minimum > 0 ? d.minimum : 1,
        race: race,
        sku: sku,
        skuText: this.describeSku(race, sku),
        contact: auth.getPhone() || '',
        contactLabel: format.contactLabel(d.contactType),
        contactPlaceholder: format.contactPlaceholder(d.contactType),
        needPassword: d.passwordStatus,
        needCaptcha: d.tradeCaptcha,
        widget: d.widget || [],
        widgetValues: this.initWidget(d.widget || [])
      });
      this.afterInit();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '订单信息加载失败' });
    }
  },

  /** 初始化自定义字段默认值 */
  initWidget(list) {
    const values = {};
    list.forEach(function (w) {
      values[w.name] = '';
    });
    return values;
  },

  describeSku(race, sku) {
    const parts = [];
    if (race) parts.push(race);
    Object.keys(sku || {}).forEach(function (k) {
      parts.push(sku[k]);
    });
    return parts.join(' / ');
  },

  async afterInit() {
    this.loadTotal();
    this.loadChannels();
    if (this.data.needCaptcha) this.refreshCaptcha();
  },

  async loadTotal() {
    try {
      const payload = { item_id: this.id, num: this.data.num };
      if (this.data.race) payload.race = this.data.race;
      if (Object.keys(this.data.sku || {}).length) payload.sku = this.data.sku;
      const res = await api.valuate(payload);
      this.setData({ totalText: res.priceText });
    } catch (e) {
      const d = this.data.detail;
      this.setData({ totalText: d ? d.userPriceText : '' });
    }
  },

  async loadChannels() {
    try {
      const list = await api.getPayChannels(this.id);
      const chosen = pay.pickChannel(list);
      this.setData({
        channels: list,
        payId: chosen ? chosen.id : 0,
        payName: chosen ? chosen.name : ''
      });
    } catch (e) {
      this.setData({ channels: [] });
    }
  },

  selectPay(e) {
    const id = Number(e.currentTarget.dataset.id);
    const item = this.data.channels.filter(function (c) {
      return c.id === id;
    })[0];
    this.setData({ payId: id, payName: item ? item.name : '' });
  },

  onContactInput(e) {
    this.setData({ contact: e.detail.value, phoneTip: '' });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  onCaptchaInput(e) {
    this.setData({ captcha: e.detail.value });
  },

  onWidgetInput(e) {
    const name = e.currentTarget.dataset.name;
    const values = Object.assign({}, this.data.widgetValues);
    values[name] = e.detail.value;
    this.setData({ widgetValues: values });
  },

  async refreshCaptcha() {
    try {
      const img = await api.getCaptcha('trade');
      this.setData({ captchaImg: img, captcha: '' });
    } catch (e) {
      this.setData({ captchaImg: '' });
    }
  },

  /** 提交前的本地校验，尽量把错误拦在发起请求之前 */
  validate() {
    const d = this.data.detail;
    const contact = String(this.data.contact || '').trim();

    if (contact.length < 3) {
      return '请填写联系方式，用于查询订单';
    }
    if (d.contactType === 1 && !auth.isValidPhone(contact)) {
      return '请输入正确的 11 位手机号';
    }
    if (d.contactType === 2 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
      return '请输入正确的邮箱地址';
    }
    if (d.contactType === 3 && !/^[1-9]\d{4,11}$/.test(contact)) {
      return '请输入正确的 QQ 号';
    }
    if (this.data.needPassword && String(this.data.password || '').length < 6) {
      return '查单密码不能少于 6 位';
    }
    if (this.data.needCaptcha && !String(this.data.captcha || '').trim()) {
      return '请输入图形验证码';
    }
    if (!this.data.payId) {
      return '暂无可用的支付方式，请联系客服';
    }
    for (let i = 0; i < (this.data.widget || []).length; i++) {
      const w = this.data.widget[i];
      if (w.required && !String(this.data.widgetValues[w.name] || '').trim()) {
        return '请填写' + w.label;
      }
      if (w.regex && String(this.data.widgetValues[w.name] || '').trim()) {
        try {
          if (!new RegExp(w.regex).test(this.data.widgetValues[w.name])) return w.error || w.label + '格式不正确';
        } catch (err) {
          /* 后台正则写错时不阻断下单 */
        }
      }
    }
    return '';
  },

  async submit() {
    if (this.data.submitting) return;
    const msg = this.validate();
    if (msg) {
      wx.showToast({ title: msg, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交订单', mask: true });

    const d = this.data.detail;
    const payload = {
      item_id: this.id,
      num: this.data.num,
      contact: String(this.data.contact).trim(),
      pay_id: this.data.payId,
      request_no: requestNo(),
      coupon: ''
    };
    if (this.data.race) payload.race = this.data.race;
    if (Object.keys(this.data.sku || {}).length) payload.sku = this.data.sku;
    if (this.data.needPassword) payload.password = this.data.password;
    if (this.data.needCaptcha) payload.captcha = String(this.data.captcha).trim();
    Object.keys(this.data.widgetValues || {}).forEach(function (k) {
      payload[k] = this.data.widgetValues[k];
    }, this);

    try {
      const result = await pay.submit(payload);
      wx.hideLoading();

      // 记入本地订单簿（卡密不落本地）
      // payUrl / payType 一并保存：用户退出小程序后再点「继续支付」也能恢复收银台
      orders.upsert({
        tradeNo: result.trade.tradeNo,
        itemId: d.id,
        name: d.name,
        cover: d.cover,
        amount: result.trade.amount,
        amountText: result.trade.amountText,
        num: this.data.num,
        contact: payload.contact,
        password: d.passwordStatus ? this.data.password : '',
        skuText: this.data.skuText,
        payUrl: result.trade.url || '',
        payType: pay.cashierType(result.trade.url),
        status: result.trade.paid ? 1 : 0,
        paid: !!result.trade.paid,
        payTime: result.trade.paid ? Date.now() : 0
      });

      if (result.type === 'free') {
        // 0 元单 / 余额支付：平台已直接发货
        app.globalData.lastSecret = { tradeNo: result.trade.tradeNo, secret: result.trade.secret, leaveMessage: result.trade.leaveMessage };
        wx.redirectTo({ url: '/pages/order-detail/order-detail?tradeNo=' + result.trade.tradeNo + '&fresh=1' });
        return;
      }

      app.globalData.pendingOrder = {
        tradeNo: result.trade.tradeNo,
        url: result.trade.url,
        amountText: result.trade.amountText,
        name: d.name,
        type: result.type,
        password: d.passwordStatus ? this.data.password : '',
        leaveMessage: result.trade.leaveMessage
      };
      wx.redirectTo({ url: '/pages/pay/pay?tradeNo=' + result.trade.tradeNo });
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      if (this.data.needCaptcha) this.refreshCaptcha();
      wx.showModal({
        title: '下单失败',
        content: e.message || '请稍后重试',
        showCancel: false
      });
    }
  },

  retry() {
    this.loadFresh();
  }
});
