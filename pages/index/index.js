// pages/index/index.js —— 商品列表（店铺首页）
const vpay = require('../../utils/vpay.js');
const cloud = require('../../utils/cloud.js');
const format = require('../../utils/format.js');

Page({
  data: {
    loading: true,
    failed: false,
    envIssue: null,
    goods: [],
    // 开发者提示：goods 读权限未开放（数据已由云函数代读，功能正常）
    permWarn: false,
    // 开发者提示：有商品价格不合法（页面会显示「¥—」且不可购买）
    cfgWarn: false,
    cfgWarnIds: '',
    // 空态文案：按「真没数据」/「读取通道没打通」分别给不同指引
    emptyTitle: '',
    emptyDesc: '',
    emptyBtn: '刷新一下'
  },

  onLoad(query) {
    // 兼容「把首页配成扫码落地页」的情况：带参时直接转发到商品详情页
    const productId = (query && (query.productId || query.pid)) || '';
    const scene = query && query.scene ? decodeURIComponent(query.scene) : '';
    if (productId || scene) {
      const qs = productId
        ? `productId=${encodeURIComponent(productId)}`
        : `scene=${encodeURIComponent(scene)}`;
      wx.navigateTo({ url: `/pages/goods/goods?${qs}` });
      return;
    }
    this.loadGoods();
  },

  onShow() {
    // 同步自定义 tabBar 的选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    // 首次加载由 onLoad 负责；返回本页时做一次静默刷新，避免闪烁骨架屏
    if (this.loadedOnce) this.loadGoods(true);
  },

  onPullDownRefresh() {
    this.loadGoods().then(() => wx.stopPullDownRefresh());
  },

  async loadGoods(silent) {
    // 环境已熔断：直接展示引导卡片，不再反复发请求（此前会持续刷屏 -501000）
    if (cloud.isBlocked()) {
      this.loadedOnce = true;
      this.setData({ loading: false, failed: false, envIssue: cloud.getState(), goods: [] });
      return;
    }

    if (!silent) this.setData({ loading: true, failed: false, envIssue: null });

    try {
      const res = await vpay.fetchGoodsList();
      // 价格一律经 format.priceOf 归一化：直接写 (it.price / 100).toFixed(2)，
      // price 缺失或类型不对时会渲染成「¥NaN」，既不报错也看不出是哪条记录的问题。
      const badIds = [];
      const goods = res.list.map((it) => {
        const p = format.priceOf(it.price);
        if (!p.valid) badIds.push(it.productId || it._id || '(未知)');
        return {
          ...it,
          icon: it.icon || '📦',
          priceText: p.text,
          priceBad: !p.valid
        };
      });
      if (badIds.length) {
        console.warn('[index] 以下商品价格不合法，页面显示为「¥—」且不可购买：', badIds.join('、'));
      }

      this.loadedOnce = true;
      this.setData({
        loading: false,
        failed: false,
        envIssue: null,
        goods,
        // 只在开发者工具/体验版提示后台配置问题，正式版顾客看不到这些字
        permWarn: res.needFixPermission && cloud.showDevHints(),
        cfgWarn: badIds.length > 0 && cloud.showDevHints(),
        cfgWarnIds: badIds.join('、'),
        ...this.emptyCopy(res)
      });
    } catch (e) {
      this.loadedOnce = true;

      // 环境类错误：用可操作的引导卡片替代「加载失败」，并给出下一步
      if (e.envIssue) {
        this.setData({ loading: false, failed: false, envIssue: cloud.getState(), goods: [] });
        return;
      }
      if (!silent) {
        this.setData({ loading: false, failed: true });
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    }
  },

  /**
   * 空态文案。
   * 两种情况的处理方式完全不同，必须分开说，否则用户会一直重复「刷新一下」：
   *   ① 兜底通道可用且返回 0 条 → 数据库真的是空的，去跑 initdb；
   *   ② 兜底通道不可用（vpay 未重新部署）→ 无法判断是空还是权限被拦，
   *      把「重新部署 vpay」和「开放 goods 读权限」两条路都摆出来。
   */
  emptyCopy(res) {
    if (res.list.length) return { emptyTitle: '', emptyDesc: '', emptyBtn: '刷新一下' };

    if (!res.serverFallback) {
      return {
        emptyTitle: '商品读取通道还没打通',
        emptyDesc:
          (res.serverReason ? '云函数代读失败：' + res.serverReason + '。\n' : '') +
          '请任选其一：\n' +
          '① 右键 cloudfunctions/vpay →「上传并部署：云端安装依赖」，让云函数代读生效（推荐）；\n' +
          '② 或在云开发控制台把 goods 集合权限设为「所有用户可读，仅管理端可写」。',
        emptyBtn: '重新检测'
      };
    }

    return {
      emptyTitle: '还没有上架的商品',
      emptyDesc:
        'goods 集合已能正常读取，但里面没有已上架的商品。请到「运行环境自检」页点一次「一键初始化数据库」写入示例商品，或自行往 goods 集合添加记录。',
      emptyBtn: '刷新一下'
    };
  },

  /** 配置改完后无需重启工具，点一下即可重新自检 */
  retryEnv() {
    cloud.init();
    cloud.resetWarn();
    if (cloud.isBlocked()) {
      this.setData({ envIssue: cloud.getState() });
      wx.showToast({ title: '环境仍不可用', icon: 'none' });
      return;
    }
    this.setData({ envIssue: null, loading: true });
    this.loadGoods();
  },

  goSetup() {
    cloud.goSetup();
  },

  goDetail(e) {
    const { pid } = e.currentTarget.dataset;
    if (!pid) return;
    wx.navigateTo({ url: `/pages/goods/goods?productId=${encodeURIComponent(pid)}` });
  }
});
