// pages/login/login.js —— 登录页：静默 openid 登录 + 手机号选填
const auth = require('../../services/auth.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

Page({
  data: {
    appName: config.appName,
    status: 'loading', // loading | ok | guest | error
    message: '',
    profile: null,
    phone: '',
    phoneMasked: ''
  },

  onLoad() {
    this.setData({
      phone: auth.getPhone(),
      phoneMasked: format.maskPhone(auth.getPhone())
    });
    this.login(false);
  },

  async login(force) {
    this.setData({ status: 'loading', message: '' });
    const r = await auth.silentLogin({ force: !!force });
    if (r.loggedIn) {
      this.setData({
        status: 'ok',
        profile: r.profile,
        message: '已通过微信身份静默登录'
      });
      return;
    }
    const err = r.error;
    // 服务端没部署 /user/api/wx/* 时是 404，属于「功能未开通」而不是「登录失败」，
    // 不该把 HTTP 404 原文甩给用户，直接按游客模式继续用。
    const notDeployed = err && err.code === 404;
    this.setData({
      status: notDeployed ? 'guest' : err && !err.api ? 'error' : 'guest',
      message: notDeployed
        ? '登录服务尚未开通，可直接下单；后台部署 Wx 接口后即可自动登录'
        : (err && err.message) || '登录服务暂不可用',
      profile: r.profile
    });
  },

  retry() {
    this.login(true);
  },

  editPhone() {
    wx.showModal({
      title: '手机号（选填）',
      editable: true,
      placeholderText: '请输入 11 位手机号',
      content: this.data.phone || '',
      success: (r) => {
        if (!r.confirm) return;
        const value = String(r.content || '').trim();
        if (value && !auth.isValidPhone(value)) {
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

  continueAsGuest() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  done() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  }
});
