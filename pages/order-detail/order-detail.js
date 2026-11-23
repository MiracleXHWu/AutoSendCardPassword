// pages/order-detail/order-detail.js —— 订单详情：发货内容、复制、补发
const api = require('../../services/api.js');
const orders = require('../../services/orders.js');
const format = require('../../utils/format.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

Page({
  data: {
    tradeNo: '',
    order: null,
    loading: true,
    error: '',
    secret: '',
    leaveMessage: '',
    needPassword: false,
    passwordInput: '',
    secretError: '',
    secretLoading: false,
    timeText: ''
  },

  onLoad(query) {
    const tradeNo = query.tradeNo || '';
    this.setData({ tradeNo: tradeNo });
    if (!tradeNo) {
      this.setData({ loading: false, error: '缺少订单号' });
      return;
    }
    this.load(query.fresh === '1');
  },

  async load(fresh) {
    const local = orders.get(this.data.tradeNo);
    const cached = app.globalData.lastSecret;

    if (local) {
      this.setData({
        order: Object.assign({}, local, {
          statusText: local.paid ? '已支付' : '待支付',
          noCover: !local.cover || local.cover.indexOf('favicon') >= 0,
          initial: (local.name || '?').slice(0, 1),
          timeText: format.fullTime(local.createdAt)
        }),
        loading: false,
        needPassword: !!local.password
      });
    } else {
      // 本地没有（换了设备/清了缓存）：只回查状态，至少让用户看到订单是否已支付
      try {
        const state = await api.getOrderState(this.data.tradeNo);
        this.setData({
          loading: false,
          order: {
            tradeNo: this.data.tradeNo,
            paid: state.paid,
            statusText: state.paid ? '已支付' : '待支付',
            amountText: state.amountText,
            name: '订单 ' + this.data.tradeNo,
            num: 1,
            skuText: ''
          }
        });
      } catch (e) {
        this.setData({ loading: false, error: e.message || '订单查询失败' });
        return;
      }
    }

    // 从确认页直接跳来（0 元单/余额支付）时，卡密已在内存里
    if (fresh && cached && cached.tradeNo === this.data.tradeNo && cached.secret) {
      this.setData({ secret: cached.secret, leaveMessage: cached.leaveMessage || '' });
      return;
    }

    if (this.data.order && this.data.order.paid) {
      this.loadSecret(this.data.order.password || '');
    }
  },

  async loadSecret(password) {
    if (this.data.secretLoading) return;
    this.setData({ secretLoading: true, secretError: '' });
    try {
      const res = await api.getSecret(this.data.tradeNo, password);
      this.setData({
        secretLoading: false,
        secret: res.secret || '',
        leaveMessage: res.leaveMessage || ''
      });
    } catch (e) {
      const msg = e.message || '发货内容获取失败';
      this.setData({
        secretLoading: false,
        secretError: /密码/.test(msg) ? '查单密码不正确' : msg,
        needPassword: /密码/.test(msg) ? true : this.data.needPassword
      });
    }
  },

  onPasswordInput(e) {
    this.setData({ passwordInput: e.detail.value });
  },

  submitPassword() {
    const pwd = String(this.data.passwordInput || '').trim();
    if (pwd.length < 6) {
      wx.showToast({ title: '密码至少 6 位', icon: 'none' });
      return;
    }
    this.loadSecret(pwd);
  },

  copySecret() {
    if (!this.data.secret) return;
    wx.setClipboardData({
      data: this.data.secret,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    });
  },

  copyTradeNo() {
    wx.setClipboardData({
      data: this.data.tradeNo,
      success: () => wx.showToast({ title: '订单号已复制', icon: 'none' })
    });
  },

  refresh() {
    this.load(false);
  },

  gotoHelp() {
    wx.navigateTo({ url: '/pages/help/help?tradeNo=' + this.data.tradeNo });
  },

  gotoGoods() {
    const id = this.data.order && this.data.order.itemId;
    if (id) wx.navigateTo({ url: '/pages/goods/goods?id=' + id });
    else wx.switchTab({ url: '/pages/index/index' });
  },

  /** 未支付：直接回到支付页，由支付页按订单号恢复收银台链接 */
  gotoPay() {
    const tradeNo = this.data.tradeNo;
    if (!tradeNo) return;
    wx.navigateTo({ url: '/pages/pay/pay?tradeNo=' + tradeNo });
  },

  gotoOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  }
});
