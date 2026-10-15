// pages/order/order.js —— 订单详情 / 自动发货结果
const vpay = require('../../utils/vpay.js');
const cloud = require('../../utils/cloud.js');

const MAX_AUTO_RETRY = 5; // 支付后自动补齐次数
const RETRY_INTERVAL = 1500; // 间隔（毫秒）

Page({
  data: {
    loading: true,
    outTradeNo: '',
    order: null,
    priceText: '',
    timeText: '',
    delivered: false,
    refunded: false,
    retrying: false,
    statusTitle: '',
    statusDesc: ''
  },

  onLoad(query) {
    const outTradeNo = query.outTradeNo || getApp().globalData.lastOutTradeNo || '';
    this.stopped = false;
    this.setData({ outTradeNo });
    this.fetch();
  },

  onUnload() {
    this.stopped = true;
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    if (!this.data.outTradeNo) {
      this.setData({ loading: false, statusTitle: '订单不存在', statusDesc: '请返回「我的订单」重新选择' });
      return;
    }
    this.setData({ loading: true });
    await this.reload();
    this.setData({ loading: false });

    // 尚未发货：自动轮询几次。发货推送正常 1~2 秒内到达，用户几乎无感
    if (!this.data.delivered && !this.data.refunded) this.autoRetry();
  },

  /** 调 recheck：先查本地，未发货则顺带做一次官方查单兜底 */
  async reload(quiet) {
    try {
      const r = await vpay.callFn(vpay.FN_VPAY, {
        action: 'recheck',
        outTradeNo: this.data.outTradeNo
      });
      const order = r.order || null;
      const delivered = !!(order && order.delivered);
      const refunded = !!(order && order.status === 'refunded');
      const stamp = order && (order.deliveredAt || order.createdAt);

      this.setData({
        order,
        delivered,
        refunded,
        priceText: order ? (order.amount / 100).toFixed(2) : '',
        timeText: formatTime(stamp),
        ...statusText(delivered, refunded, order)
      });
      return order;
    } catch (e) {
      console.error('[order] reload', e);
      // 环境类错误：引导一次即可，不做重复弹窗（重试也必然失败）
      if (e.envIssue && !this.envGuided) {
        this.envGuided = true;
        cloud.showGuide(true);
      }
      if (!quiet) wx.showToast({ title: e.message || '查询失败', icon: 'none' });
      return null;
    }
  },

  async autoRetry() {
    if (this.data.retrying) return;
    this.setData({ retrying: true });
    for (let i = 0; i < MAX_AUTO_RETRY; i++) {
      if (this.stopped || this.data.delivered || this.data.refunded) break;
      await sleep(RETRY_INTERVAL);
      if (this.stopped) break;
      const order = await this.reload(true);
      if (!order) break;
      if (order.delivered || order.status === 'refunded') break;
    }
    if (!this.stopped) this.setData({ retrying: false });
  },

  /* ---------------- 交互 ---------------- */
  copy(e) {
    const { text } = e.currentTarget.dataset;
    if (!text) return;
    wx.setClipboardData({
      data: String(text),
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  copyAll() {
    const order = this.data.order;
    if (!order || !order.content) return;
    const items = order.content.items || [];
    const lines = [`【${order.goodsTitle || '已购内容'}】`];
    items.forEach((it, i) => {
      if (items.length > 1) lines.push(`—— 第 ${i + 1} 份 ——`);
      if (it.link) lines.push(`链接：${it.link}`);
      if (it.pwd) lines.push(`提取码：${it.pwd}`);
      if (!it.link && it.raw) lines.push(it.raw);
    });
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '全部内容已复制', icon: 'success' })
    });
  },

  openLink(e) {
    const { url } = e.currentTarget.dataset;
    if (!url) return;
    wx.setClipboardData({
      data: String(url),
      success: () => {
        wx.showModal({
          title: '链接已复制',
          content: '微信内不能直接打开网盘链接，请粘贴到浏览器或对应网盘 App 中打开。',
          confirmText: '知道了',
          showCancel: false
        });
      }
    });
  }
});

/* ---------------- 工具函数 ---------------- */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusText(delivered, refunded, order) {
  if (refunded) {
    return { statusTitle: '已退款', statusDesc: '该订单已发起退款，发货内容不再提供' };
  }
  if (delivered) {
    return { statusTitle: '支付成功 · 已自动发货', statusDesc: '以下内容由系统自动发送，建议立即复制保存' };
  }
  if (!order) {
    return { statusTitle: '订单信息加载中', statusDesc: '若长时间无响应，请下拉刷新重试' };
  }
  return { statusTitle: '正在确认支付结果', statusDesc: '若已完成付款，系统会在数秒内自动补发内容' };
}

function formatTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
