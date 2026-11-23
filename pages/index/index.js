// pages/index/index.js —— 首页：搜索入口 + 分类快捷 + 商品流
const api = require('../../services/api.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

/** 无封面时按商品 id 取一个稳定的渐变色，避免列表一片空白 */
const COVER_COLORS = [
  'linear-gradient(135deg,#d9f2e5,#b7e8cf)',
  'linear-gradient(135deg,#e6e9ff,#cdd4fb)',
  'linear-gradient(135deg,#fdeedd,#fbd9bc)',
  'linear-gradient(135deg,#e4f4fb,#c4e6f5)',
  'linear-gradient(135deg,#fbe6ef,#f6ccdd)'
];

Page({
  data: {
    appName: config.appName,
    statusBar: 20,
    loading: true,
    error: '',
    categories: [],
    // 当前选中的分类：统一用字符串比较（'0' = 全部，'recommend' = 推荐）
    activeKey: '0',
    goods: [],
    page: 1,
    hasMore: true,
    loadingMore: false
  },

  onLoad() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData({ statusBar: info.statusBarHeight || 20 });
    } catch (e) {
      /* 取不到就用默认值 */
    }
    this.loadAll();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(0);
    }
  },

  onPullDownRefresh() {
    this.loadAll(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  /** 分类与首屏商品并行加载（互不阻塞：任一失败都不影响另一块渲染） */
  async loadAll(force) {
    this.setData({ loading: true, error: '' });

    const settled = await Promise.all([
      app.prefetchCategories(force).then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e })
      ),
      this.fetchGoods(1).then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e })
      )
    ]);

    const catRes = settled[0];
    const goodsRes = settled[1];

    // 分类失败时沿用上一次的展平表，至少保留「全部」入口
    const flat = catRes.ok && catRes.v && Array.isArray(catRes.v.flat) ? catRes.v.flat : this.catFlat || [];
    this.catFlat = flat;
    const categories = flat
      .filter((c) => c.level === 0)
      .slice(0, 10)
      .map((c) => ({ id: c.id, key: String(c.id), name: c.name }));

    if (!goodsRes.ok) {
      const msg = (goodsRes.e && goodsRes.e.message) || '商品加载失败，请下拉刷新';
      this.setData({ loading: false, categories, error: msg });
      return;
    }

    const res = goodsRes.v || { list: [], hasMore: false };
    this.setData({
      categories: categories,
      goods: this.decorate(res.list),
      page: 1,
      hasMore: !!res.hasMore,
      loading: false,
      error: ''
    });
  },

  fetchGoods(page) {
    const key = String(this.data.activeKey || '0');
    const opts = { page: page, limit: config.pageSize, flat: this.catFlat || [] };
    // '0' 表示全部；其余按分类取（含 'recommend' 这种虚拟分类）
    if (key === '0') return api.getCommodities(opts);
    return api.getCommoditiesByCategory(key, opts);
  },

  /** 补上渐变底色、封面是否可用等展示字段 */
  decorate(list) {
    return (list || []).map((g, i) => {
      const noCover = !g.cover || g.cover.indexOf('favicon') >= 0;
      return Object.assign({}, g, {
        bg: COVER_COLORS[(g.id || i) % COVER_COLORS.length],
        noCover: noCover,
        initial: (g.name || '?').slice(0, 1),
        stockLabel: g.stockText || (g.stock > 0 ? '库存 ' + g.stock : '已售罄'),
        soldText: format.sold(g.sold)
      });
    });
  },

  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    try {
      const next = this.data.page + 1;
      const res = await this.fetchGoods(next);
      this.setData({
        goods: this.data.goods.concat(this.decorate(res.list)),
        page: next,
        hasMore: res.hasMore,
        loadingMore: false
      });
    } catch (e) {
      this.setData({ loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  switchCat(e) {
    const raw = e.currentTarget.dataset.key;
    const key = raw == null || raw === '' ? '0' : String(raw);
    if (key === String(this.data.activeKey)) return;
    this.setData({ activeKey: key, loading: true, goods: [], error: '', page: 1, hasMore: true });
    this.fetchGoods(1)
      .then((res) => {
        this.setData({
          goods: this.decorate(res.list),
          page: 1,
          hasMore: res.hasMore,
          loading: false
        });
      })
      .catch((e) => {
        this.setData({ loading: false, error: e.message || '加载失败' });
      });
  },

  retry() {
    this.loadAll(true);
  },

  gotoSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  gotoCategory() {
    wx.switchTab({ url: '/pages/category/category' });
  },

  gotoGoods(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/goods/goods?id=' + id });
  },

  onShareAppMessage() {
    return { title: config.appName, path: '/pages/index/index' };
  }
});
