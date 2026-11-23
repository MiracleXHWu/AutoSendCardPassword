// pages/mine/mine.js —— 我的：身份、订单统计、常用入口
const auth = require('../../services/auth.js');
const orders = require('../../services/orders.js');
const api = require('../../services/api.js');
const config = require('../../config.js');
const format = require('../../utils/format.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

Page({
  data: {
    appName: config.appName,
    profile: null,
    guest: true,
    phone: '',
    stats: { total: 0, paid: 0, unpaid: 0 },
    catCount: 0,
    goodsCount: 0
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(3);
    }
    this.refresh();
  },

  refresh() {
    const profile = auth.readProfile();
    const stats = orders.stats();
    const cat = app.globalData.categories;
    this.setData({
      profile: profile,
      guest: !profile || profile.guest === true || !profile.loggedIn,
      phone: auth.getPhone(),
      phoneMasked: format.maskPhone(auth.getPhone()),
      stats: stats,
      catCount: cat ? (cat.flat || []).length : 0
    });
  },

  /** 手机号：选填，用于换设备查单 */
  editPhone() {
    wx.showModal({
      title: this.data.phone ? '修改手机号' : '填写手机号',
      editable: true,
      placeholderText: '请输入 11 位手机号',
      content: this.data.phone || '',
      success: (r) => {
        if (!r.confirm) return;
        const value = String(r.content || '').trim();
        if (!value) {
          auth.bindPhone('');
          this.setData({ phone: '', phoneMasked: '' });
          return;
        }
        if (!auth.isValidPhone(value)) {
          wx.showToast({ title: '手机号格式不正确', icon: 'none' });
          return;
        }
        auth.bindPhone(value).then(() => {
          this.setData({ phone: value, phoneMasked: format.maskPhone(value) });
          wx.showToast({ title: '已保存', icon: 'success' });
        });
      }
    });
  },

  gotoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  gotoOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  gotoUnpaid() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  gotoQuery() {
    wx.navigateTo({ url: '/pages/help/help?mode=query' });
  },

  gotoHelp() {
    wx.navigateTo({ url: '/pages/help/help' });
  },

  gotoCategory() {
    wx.switchTab({ url: '/pages/category/category' });
  },

  reLogin() {
    wx.showLoading({ title: '登录中' });
    auth.silentLogin({ force: true }).then((r) => {
      wx.hideLoading();
      this.refresh();
      wx.showToast({
        title: r.loggedIn ? '登录成功' : '当前为游客模式',
        icon: r.loggedIn ? 'success' : 'none'
      });
    });
  },

  about() {
    wx.showModal({
      title: config.appName,
      content:
        '本小程序商品、库存与卡密均由发卡平台实时提供，付款后自动发货。\n\n虚拟商品一经售出不支持无理由退款，如有发货问题请联系客服补发。',
      showCancel: false
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将清除登录状态，但本地订单记录会保留。',
      success: (r) => {
        if (!r.confirm) return;
        auth.logout();
        this.refresh();
      }
    });
  }
});
