/**
 * utils/app.js —— App 实例的安全访问层
 * ---------------------------------------------------------------
 * 为什么不在页面顶部写 `const app = getApp()`：
 *   1. 开启「独立上下文（useIsolateContext）」后，页面模块可能在 App 实例
 *      就绪之前被注入，模块顶层拿到的 getApp() 会是 undefined；
 *   2. 开发者工具热重载（compileHotReLoad）时，页面逻辑层会被替换，
 *      旧模块里缓存下来的 app 引用同样可能失效。
 *   两种情况下 `app.prefetchCategories()` 都会抛 TypeError，且发生在
 *   `onLoad` 的最前面 —— 后续请求一个都发不出去，页面就停在空白状态。
 *
 * 这里改成「每次调用时取一次」，拿不到就退化为本地兜底对象，
 * 页面因此永远不会因为 App 未就绪而中断。
 */
const FALLBACK = { globalData: {} };

/** 取当前 App 实例；不可用时返回稳定的兜底对象 */
function instance() {
  try {
    const a = getApp();
    if (a && a.globalData) return a;
  } catch (e) {
    /* getApp 在某些时序下会直接抛错，忽略 */
  }
  return FALLBACK;
}

/** 分类树：App 上有缓存方法就走缓存，否则直接请求，失败给空结果 */
function prefetchCategories(force) {
  const a = instance();
  if (typeof a.prefetchCategories === 'function') {
    try {
      return Promise.resolve(a.prefetchCategories(force));
    } catch (e) {
      return fallbackCategories();
    }
  }
  return fallbackCategories();
}

function fallbackCategories() {
  const api = require('../services/api.js');
  return api.getCategories().catch(function () {
    return { tree: [], flat: [] };
  });
}

module.exports = {
  /** 跨页传递的临时数据容器（等同 app.globalData） */
  get globalData() {
    return instance().globalData;
  },
  /** 需要原始 App 时使用 */
  get app() {
    return instance();
  },
  prefetchCategories
};
