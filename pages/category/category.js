// pages/category/category.js —— 分类：左侧一级类目 + 右侧商品网格
const api = require('../../services/api.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

const COVER_COLORS = [
  'linear-gradient(135deg,#d9f2e5,#b7e8cf)',
  'linear-gradient(135deg,#e6e9ff,#cdd4fb)',
  'linear-gradient(135deg,#fdeedd,#fbd9bc)',
  'linear-gradient(135deg,#e4f4fb,#c4e6f5)',
  'linear-gradient(135deg,#fbe6ef,#f6ccdd)'
];

Page({
  data: {
    loading: true,
    error: '',
    tree: [],
    flat: [],
    roots: [],
    activeRoot: 0,
    subs: [],
    activeSub: 0,
    goods: [],
    rootName: ''
  },

  onLoad() {
    this.loadCategories();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(1);
    }
  },

  onPullDownRefresh() {
    this.loadCategories(true).then(() => wx.stopPullDownRefresh());
  },

  async loadCategories(force) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await app.prefetchCategories(force);
      const roots = (res.tree || []).map((n) => ({ id: n.id, name: n.name, count: (n.children || []).length }));
      this.setData({ tree: res.tree || [], flat: res.flat || [], roots: roots, loading: false });
      if (roots.length) this.selectRoot({ currentTarget: { dataset: { id: roots[0].id } } });
      else this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '分类加载失败' });
    }
  },

  /** 取某个一级分类的直接子类 */
  subsOf(rootId) {
    return (this.data.flat || [])
      .filter((c) => String(c.parentId) === String(rootId))
      .map((c) => ({ id: c.id, name: c.name }));
  },

  selectRoot(e) {
    const id = e.currentTarget.dataset.id;
    const root = (this.data.tree || []).filter((n) => String(n.id) === String(id))[0];
    const subs = this.subsOf(id);
    this.setData({
      activeRoot: id,
      activeSub: 0,
      subs: subs,
      rootName: root ? root.name : '',
      goods: [],
      loading: true
    });
    this.loadGoods(id);
  },

  selectSub(e) {
    const id = e.currentTarget.dataset.id;
    if (String(id) === String(this.data.activeSub)) return;
    this.setData({ activeSub: id, goods: [], loading: true });
    this.loadGoods(id || this.data.activeRoot);
  },

  async loadGoods(categoryId) {
    try {
      const res = await api.getCommoditiesByCategory(categoryId, {
        page: 1,
        limit: 0,
        flat: this.data.flat || []
      });
      this.setData({ goods: this.decorate(res.list), loading: false, error: '' });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '商品加载失败' });
    }
  },

  decorate(list) {
    return (list || []).map((g, i) => {
      const noCover = !g.cover || g.cover.indexOf('favicon') >= 0;
      return Object.assign({}, g, {
        bg: COVER_COLORS[(g.id || i) % COVER_COLORS.length],
        noCover: noCover,
        initial: (g.name || '?').slice(0, 1),
        soldText: format.sold(g.sold)
      });
    });
  },

  retry() {
    this.loadCategories(true);
  },

  gotoGoods(e) {
    wx.navigateTo({ url: '/pages/goods/goods?id=' + e.currentTarget.dataset.id });
  },

  gotoSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  }
});
