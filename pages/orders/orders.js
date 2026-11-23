// pages/orders/orders.js —— 订单列表：本地订单号 + 实时状态回查
const orders = require('../../services/orders.js');
const format = require('../../utils/format.js');

Page({
  data: {
    tab: 'all',
    list: [],
    filtered: [],
    loading: true,
    stats: { total: 0, paid: 0, unpaid: 0 },
    error: ''
  },

  onLoad() {
    this.load(false);
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(2);
    }
    // 从支付页/详情页返回时刷新状态
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  async load(withRemote) {
    const local = orders.list();
    this.setData({
      list: this.decorate(local),
      stats: orders.stats(),
      loading: false
    });
    this.applyFilter();

    if (!withRemote || !local.length) return;

    try {
      const updated = await orders.refreshAll();
      this.setData({
        list: this.decorate(updated),
        stats: orders.stats(),
        error: ''
      });
      this.applyFilter();
    } catch (e) {
      this.setData({ error: e.message || '' });
    }
  },

  decorate(list) {
    return (list || []).map(function (o) {
      return Object.assign({}, o, {
        timeText: format.formatTime(o.createdAt),
        statusText: o.paid ? '已支付' : '待支付',
        noCover: !o.cover || o.cover.indexOf('favicon') >= 0,
        initial: (o.name || '?').slice(0, 1)
      });
    });
  },

  applyFilter() {
    const tab = this.data.tab;
    const list = this.data.list;
    const filtered = list.filter(function (o) {
      if (tab === 'unpaid') return !o.paid;
      if (tab === 'paid') return !!o.paid;
      return true;
    });
    this.setData({ filtered: filtered });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab: tab });
    this.applyFilter();
  },

  gotoDetail(e) {
    const tradeNo = e.currentTarget.dataset.no;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?tradeNo=' + tradeNo });
  },

  /** 待支付订单回到支付页继续支付（支付页会按订单号恢复收银台链接） */
  gotoPay(e) {
    const tradeNo = e.currentTarget.dataset.no;
    if (!tradeNo) return;
    wx.navigateTo({ url: '/pages/pay/pay?tradeNo=' + tradeNo });
  },

  gotoQuery() {
    wx.navigateTo({ url: '/pages/help/help?mode=query' });
  },

  gotoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
