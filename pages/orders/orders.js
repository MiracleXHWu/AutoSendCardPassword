// pages/orders/orders.js —— 我的订单
const vpay = require('../../utils/vpay.js');
const cloud = require('../../utils/cloud.js');

Page({
  data: {
    loading: true,
    failed: false,
    envIssue: null,
    orders: []
  },

  onShow() {
    // 同步自定义 tabBar 的选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    // 首次进入走骨架屏；再次返回本页做静默刷新，避免闪烁
    this.fetch(this.loadedOnce === true);
  },

  onPullDownRefresh() {
    this.fetch(false).then(() => wx.stopPullDownRefresh());
  },

  async fetch(silent) {
    // 环境已熔断：直接展示引导卡片，不再反复发请求
    if (cloud.isBlocked()) {
      this.loadedOnce = true;
      this.setData({ loading: false, failed: false, envIssue: cloud.getState(), orders: [] });
      return;
    }

    if (!silent) this.setData({ loading: true, failed: false, envIssue: null });

    try {
      const r = await vpay.callFn(vpay.FN_VPAY, { action: 'listOrders' });
      const orders = (r.orders || []).map((o) => ({
        ...o,
        priceText: ((o.amount || 0) / 100).toFixed(2),
        timeText: formatTime(o.deliveredAt || o.createdAt),
        statusText: o.status === 'refunded' ? '已退款' : o.delivered ? '已发货' : '待支付',
        statusClass: o.status === 'refunded' ? 'tag-refund' : o.delivered ? 'tag-ok' : 'tag-wait'
      }));
      this.loadedOnce = true;
      this.setData({ loading: false, failed: false, envIssue: null, orders });
    } catch (e) {
      this.loadedOnce = true;

      if (e.envIssue) {
        this.setData({ loading: false, failed: false, envIssue: cloud.getState(), orders: [] });
        return;
      }
      if (!silent) {
        this.setData({ loading: false, failed: true });
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    }
  },

  /** 配置改完后重新自检 */
  retryEnv() {
    cloud.init();
    cloud.resetWarn();
    if (cloud.isBlocked()) {
      this.setData({ envIssue: cloud.getState() });
      wx.showToast({ title: '环境仍不可用', icon: 'none' });
      return;
    }
    this.setData({ envIssue: null, loading: true });
    this.fetch();
  },

  goSetup() {
    cloud.goSetup();
  },

  goDetail(e) {
    const { outtradeno } = e.currentTarget.dataset;
    if (!outtradeno) return;
    wx.navigateTo({ url: `/pages/order/order?outTradeNo=${encodeURIComponent(outtradeno)}` });
  },

  goShop() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});

function formatTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
