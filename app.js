/**
 * app.js
 * ---------------------------------------------------------------
 * 启动只做两件事，且都不阻塞首屏：
 *   1. 静默 openid 登录（失败自动降级为游客，不弹窗、不阻断）；
 *   2. 预取一次分类树（内存缓存 5 分钟，供首页/分类页秒开）。
 *
 * 本版本不使用云开发：没有 wx.cloud.init，没有云函数调用，
 * 所有业务数据来自 config.apiBase 指向的发卡平台。
 */
const config = require('./config.js');
const auth = require('./services/auth.js');
const api = require('./services/api.js');

App({
  globalData: {
    appName: config.appName,
    // 分类树内存缓存（不落盘：商品与分类必须以平台为准）
    categories: null,
    categoriesAt: 0,
    // 最近一次下单成功的信息，供支付页/订单详情页衔接
    lastOrder: null,
    // 启动阶段的登录结果
    authReady: null
  },

  onLaunch() {
    this.checkApiBase();

    this.globalData.authReady = auth
      .silentLogin()
      .then((r) => {
        if (config.debugEnv) {
          console.log(
            '[auth]',
            r.loggedIn ? '已登录 openid=' + (r.profile && r.profile.openid) : '游客模式',
            r.error ? r.error.message : ''
          );
        }
        return r;
      })
      .catch((e) => {
        // silentLogin 内部已降级，这里只兜住极端情况，保证 authReady 永不 reject
        console.error('[auth] 静默登录异常：', e && e.message);
        return { loggedIn: false, guest: true, profile: null, error: e };
      });

    this.prefetchCategories();
  },

  /* ------------------------------------------------------------------ */
  /* 启动自检：真机只接受 HTTPS 的 request 合法域名                        */
  /* ------------------------------------------------------------------ */
  checkApiBase() {
    const base = config.apiBase || '';
    if (/^http:\/\//i.test(base)) {
      console.warn(
        '[config] apiBase 为 HTTP：' + base +
          '\n微信真机不允许访问 HTTP 接口，即使已在后台添加域名也会失败；' +
          '请为站点配置有效 HTTPS 证书后改为 https://'
      );
    }
  },

  /* ------------------------------------------------------------------ */
  /* 全局异常出口                                                        */
  /* 页面白屏时，控制台必须能看到原始堆栈，否则只能靠猜                     */
  /* ------------------------------------------------------------------ */
  onError(err) {
    console.error('[app error]', err);
  },

  onUnhandledRejection(res) {
    console.error('[app unhandledRejection]', (res && res.reason) || res);
  },

  onPageNotFound(res) {
    console.error('[app pageNotFound]', res && res.path);
    wx.switchTab({ url: '/pages/index/index' });
  },

  /** 预取分类树；force 为 true 时忽略缓存 */
  async prefetchCategories(force) {
    const ttl = 5 * 60 * 1000;
    if (!force && this.globalData.categories && Date.now() - this.globalData.categoriesAt < ttl) {
      return this.globalData.categories;
    }
    try {
      const res = await api.getCategories();
      this.globalData.categories = res;
      this.globalData.categoriesAt = Date.now();
      return res;
    } catch (e) {
      // 预取失败不抛：页面各自有重试入口
      return this.globalData.categories || { tree: [], flat: [] };
    }
  }
});
