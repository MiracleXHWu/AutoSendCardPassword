// pages/help/help.js —— 帮助中心：常见问题、按手机号/订单号查单、联系客服
const api = require('../../services/api.js');
const orders = require('../../services/orders.js');
const auth = require('../../services/auth.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

const FAQ = [
  {
    q: '付款后多久发货？',
    a: '自动发货商品在支付成功后立即生成发货内容，页面会自动跳转展示。若长时间未显示，请下拉刷新订单详情或点击「重新获取」。'
  },
  {
    q: '发货内容在哪里查看？',
    a: '打开「订单」→ 选择已支付的订单 → 在「发货内容」区域查看，可一键复制。卡密不会保存在手机本地，每次查看都会向平台实时获取。'
  },
  {
    q: '支付二维码怎么付款？',
    a: '在支付页长按二维码图片，选择「识别二维码」即可在微信内打开收银台完成付款。若识别失败，可点「复制支付链接」后粘贴到浏览器打开。'
  },
  {
    q: '订单超时未支付怎么办？',
    a: '每笔订单的支付时间 5 分钟。超时后订单仍保持「待支付」，在支付页或订单列表点「继续支付」即可重新发起，不需要重复下单。'
  },
  {
    q: '换了手机 / 清了缓存，订单还在吗？',
    a: '订单记录保存在平台侧。在本页用下单时填写的手机号或完整订单号查询即可找回。建议下单时填写常用手机号。'
  },
  {
    q: '可以退款吗？',
    a: '虚拟商品一经发货不支持无理由退款。若遇到卡密无效、链接失效等质量问题，请联系客服并提供订单号，我们会核实后补发或退款。'
  },
  {
    q: '忘记查单密码了怎么办？',
    a: '查单密码由你在下单时自行设置，平台不保存明文。忘记后请联系客服，提供订单号与支付凭证核实后协助处理。'
  }
];

Page({
  data: {
    faq: FAQ,
    openIndex: -1,
    mode: '',
    keyword: '',
    searching: false,
    searched: false,
    result: [],
    error: '',
    phone: '',
    supportWechat: config.support.wechat,
    supportQq: config.support.qq
  },

  onLoad(query) {
    const phone = auth.getPhone();
    this.setData({ phone: phone });
    if (query && query.mode === 'query') {
      this.setData({ mode: 'query', keyword: phone || '' });
    }
    if (query && query.tradeNo) {
      this.setData({ mode: 'query', keyword: query.tradeNo });
    }
  },

  toggleFaq(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ openIndex: this.data.openIndex === i ? -1 : i });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  usePhone() {
    if (!this.data.phone) {
      wx.showToast({ title: '还没有填写手机号', icon: 'none' });
      return;
    }
    this.setData({ keyword: this.data.phone });
    this.search();
  },

  async search() {
    const kw = String(this.data.keyword || '').trim();
    if (!kw) {
      wx.showToast({ title: '请输入手机号或订单号', icon: 'none' });
      return;
    }
    this.setData({ searching: true, error: '', searched: true });
    try {
      const res = await api.queryOrders(kw, 1);
      const list = res.list.map(function (o) {
        return Object.assign({}, o, {
          timeText: format.formatTime(o.createTime),
          statusText: o.paid ? '已支付' : '待支付'
        });
      });
      // 查到的订单写入本地簿，方便后续在「订单」页直接看到
      list.forEach(function (o) {
        orders.upsert({
          tradeNo: o.tradeNo,
          itemId: o.commodityId,
          name: o.name,
          cover: o.cover,
          amount: o.amount,
          amountText: o.amountText,
          num: 1,
          contact: o.contact,
          status: o.status,
          paid: o.paid
        });
      });
      this.setData({ searching: false, result: list });
    } catch (e) {
      this.setData({ searching: false, result: [], error: e.message || '查询失败' });
    }
  },

  gotoDetail(e) {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?tradeNo=' + e.currentTarget.dataset.no });
  },

  /**
   * 联系客服
   * 优先用微信原生客服（需在 MP 后台配置客服），不可用时回退到复制客服联系方式。
   */
  contact() {
    if (wx.openCustomerServiceChat) {
      wx.showModal({
        title: '联系客服',
        content: '将在微信内打开客服会话，请提供订单号以便快速核实。',
        confirmText: '打开',
        success: (r) => {
          if (!r.confirm) return;
          wx.openCustomerServiceChat({
            extInfo: { url: '' },
            corpId: '',
            fail: () => this.fallbackContact()
          });
        }
      });
      return;
    }
    this.fallbackContact();
  },

  fallbackContact() {
    const info = [this.data.supportWechat ? '微信：' + this.data.supportWechat : '', this.data.supportQq ? 'QQ：' + this.data.supportQq : '']
      .filter(Boolean)
      .join('\n');
    if (!info) {
      wx.showModal({
        title: '客服联系方式',
        content: '商家尚未配置客服信息。可在「我的 → 关于本店」联系店铺管理员，或通过发卡平台首页的客服入口联系我们。',
        showCancel: false
      });
      return;
    }
    wx.setClipboardData({
      data: info,
      success: () => wx.showModal({ title: '客服信息已复制', content: info, showCancel: false })
    });
  },

  gotoOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  }
});
