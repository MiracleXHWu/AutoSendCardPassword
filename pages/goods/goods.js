// pages/goods/goods.js —— 商品详情：规格、实时库存与价格、立即购买
const api = require('../../services/api.js');
const auth = require('../../services/auth.js');
const format = require('../../utils/format.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');
Page({
  data: {
    loading: true,
    error: '',
    detail: null,
    descHtml: '',
    num: 1,
    min: 1,
    max: 0,
    race: '',
    sku: {},
    priceText: '',
    stock: 0,
    stockText: '',
    noCover: true,
    canBuy: false,
    priceLoading: false
  },

  onLoad(query) {
    this.id = query.id;
    if (!this.id) {
      this.setData({ loading: false, error: '缺少商品参数' });
      return;
    }
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.getCommodityDetail(this.id);
      const race = detail.races.length ? detail.races[0].name : '';
      const sku = {};
      detail.skuGroups.forEach(function (g) {
        if (g.values.length) sku[g.name] = g.values[0];
      });

      const min = detail.minimum > 0 ? detail.minimum : 1;
      const max = detail.maximum > 0 ? detail.maximum : 0;

      this.setData({
        loading: false,
        detail: detail,
        descHtml: format.richText(detail.description),
        race: race,
        sku: sku,
        num: min,
        min: min,
        max: max,
        noCover: !detail.cover || detail.cover.indexOf('favicon') >= 0,
        priceText: detail.userPriceText,
        stock: detail.stock,
        stockText: detail.stockText,
        canBuy: detail.stock > 0
      });

      wx.setNavigationBarTitle({ title: detail.name.slice(0, 16) });
      this.refreshPrice();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '商品加载失败' });
    }
  },

  /** 组装估价/库存参数（faka 的 sku 是嵌套对象） */
  buildPayload() {
    const payload = {
      item_id: Number(this.id),
      num: this.data.num
    };
    if (this.data.race) payload.race = this.data.race;
    const sku = this.data.sku || {};
    if (Object.keys(sku).length) payload.sku = sku;
    return payload;
  },

  /** 改数量或规格后重新取价与库存（价格一律以服务端为准） */
  async refreshPrice() {
    this.setData({ priceLoading: true });
    const payload = this.buildPayload();
    try {
      const results = await Promise.all([api.valuate(payload), api.getStock(payload)]);
      const price = results[0];
      const stock = results[1];
      this.setData({
        priceLoading: false,
        priceText: price.priceText,
        stock: stock.stock,
        stockText: stock.stockText,
        canBuy: !(stock.stockText ? stock.stockText === '已售罄' : stock.stock <= 0)
      });
    } catch (e) {
      // 估价失败时保留商品默认价，但阻断明显无库存的下单
      this.setData({
        priceLoading: false,
        priceText: this.data.priceText,
        canBuy: false
      });
      wx.showToast({ title: e.message || '价格获取失败', icon: 'none' });
    }
  },

  selectRace(e) {
    const name = e.currentTarget.dataset.name;
    if (name === this.data.race) return;
    this.setData({ race: name });
    this.refreshPrice();
  },

  selectSku(e) {
    const group = e.currentTarget.dataset.group;
    const value = e.currentTarget.dataset.value;
    const sku = Object.assign({}, this.data.sku);
    if (sku[group] === value) return;
    sku[group] = value;
    this.setData({ sku: sku });
    this.refreshPrice();
  },

  minus() {
    const next = Math.max(this.data.min, this.data.num - 1);
    if (next === this.data.num) return;
    this.setData({ num: next });
    this.refreshPrice();
  },

  plus() {
    const limit = this.data.max > 0 ? this.data.max : 999;
    const stockLimit = this.data.stock > 0 ? this.data.stock : limit;
    const next = Math.min(limit, stockLimit, this.data.num + 1);
    if (next === this.data.num) {
      wx.showToast({ title: this.data.max > 0 ? '单次最多 ' + this.data.max + ' 件' : '库存不足', icon: 'none' });
      return;
    }
    this.setData({ num: next });
    this.refreshPrice();
  },

  onNumInput(e) {
    const raw = Number(e.detail.value);
    if (!Number.isFinite(raw) || raw <= 0) return;
    const limit = this.data.max > 0 ? this.data.max : 999;
    const stockLimit = this.data.stock > 0 ? this.data.stock : limit;
    const next = Math.min(Math.max(this.data.min, Math.floor(raw)), Math.min(limit, stockLimit));
    this.setData({ num: next });
    this.refreshPrice();
  },

  buy() {
    const d = this.data.detail;
    if (!d) return;
    if (!this.data.canBuy) {
      wx.showToast({ title: '该规格已售罄', icon: 'none' });
      return;
    }
    if (d.onlyUser && !auth.isLoggedIn()) {
      wx.showModal({
        title: '需要登录',
        content: '该商品仅限登录用户购买，请先完成微信登录。',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/login/login' });
        }
      });
      return;
    }
    // 规格与数量通过 globalData 传递，避免把嵌套对象塞进 URL
    app.globalData.draft = {
      detail: d,
      num: this.data.num,
      race: this.data.race,
      sku: this.data.sku,
      priceText: this.data.priceText
    };
    wx.navigateTo({ url: '/pages/confirm/confirm?id=' + d.id });
  },

  gotoHelp() {
    wx.navigateTo({ url: '/pages/help/help?id=' + this.id });
  },

  gotoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  retry() {
    this.load();
  },

  onShareAppMessage() {
    const d = this.data.detail;
    return {
      title: d ? d.name : '商品详情',
      path: '/pages/goods/goods?id=' + this.id
    };
  }
});
