// pages/search/search.js —— 搜索：历史 + 热门词 + 结果列表
const api = require('../../services/api.js');
const config = require('../../config.js');
const format = require('../../utils/format.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');
const HISTORY_KEY = 'search.history';
const MAX_HISTORY = 10;

Page({
  data: {
    keyword: '',
    focus: true,
    history: [],
    hot: [],
    searched: false,
    loading: false,
    error: '',
    list: [],
    total: 0
  },

  onLoad(query) {
    const history = this.readHistory();
    const cat = app.globalData.categories;
    const hot = cat
      ? (cat.flat || [])
          .filter((c) => c.level === 0)
          .slice(0, 8)
          .map((c) => c.name)
      : [];
    this.setData({ history: history, hot: hot });

    if (query && query.keyword) {
      this.setData({ keyword: query.keyword, focus: false });
      this.doSearch(query.keyword);
    }
  },

  readHistory() {
    try {
      const rows = wx.getStorageSync(HISTORY_KEY);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      return [];
    }
  },

  writeHistory(list) {
    try {
      wx.setStorageSync(HISTORY_KEY, list.slice(0, MAX_HISTORY));
    } catch (e) {
      /* ignore */
    }
  },

  onInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onConfirm(e) {
    const kw = (e.detail.value || this.data.keyword || '').trim();
    this.doSearch(kw);
  },

  tapHistory(e) {
    const kw = e.currentTarget.dataset.kw;
    this.setData({ keyword: kw, focus: false });
    this.doSearch(kw);
  },

  clearHistory() {
    this.writeHistory([]);
    this.setData({ history: [] });
  },

  async doSearch(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      wx.showToast({ title: '请输入关键词', icon: 'none' });
      return;
    }

    const history = [kw].concat(
      this.readHistory().filter(function (h) {
        return h !== kw;
      })
    );
    this.writeHistory(history);

    this.setData({ keyword: kw, loading: true, error: '', searched: true, history: history.slice(0, MAX_HISTORY) });
    try {
      const res = await api.getCommodities({ keywords: kw, page: 1, limit: config.pageSize });
      this.setData({
        list: (res.list || []).map(function (g) {
          return Object.assign({}, g, {
            noCover: !g.cover || g.cover.indexOf('favicon') >= 0,
            initial: (g.name || '?').slice(0, 1),
            soldText: format.sold(g.sold)
          });
        }),
        total: res.total,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '搜索失败', list: [] });
    }
  },

  clearKeyword() {
    this.setData({ keyword: '', searched: false, list: [], focus: true });
  },

  gotoGoods(e) {
    wx.navigateTo({ url: '/pages/goods/goods?id=' + e.currentTarget.dataset.id });
  }
});
