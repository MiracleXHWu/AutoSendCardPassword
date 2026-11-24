/**
 * utils/nav.js —— 自定义导航（全铺满头部）的尺寸配置
 * ---------------------------------------------------------------
 * 首页 / 分类 / 订单 / 我的 四个 Tab 页统一使用 navigationStyle: custom，
 * 页面顶部由 .screen-hero 渐变头铺满到状态栏，不再有原生白色导航条。
 *
 * 这里集中算三个数值，页面 onLoad 时调 nav.apply(this) 注入 data：
 *   statusBar  —— 状态栏高度（px），作为渐变头的 padding-top
 *   navH       —— 标题行高度（px），与右上角胶囊按钮垂直居中
 *   capsuleGap —— 标题行右侧需要让出的宽度（px），避免被胶囊压住
 *
 * 想统一调整顶部留白，只改这个文件和 app.wxss 里的 --hero-* 变量即可。
 */
const FALLBACK = { statusBar: 20, navH: 44, capsuleGap: 96 };

let cache = null;

function metrics() {
  if (cache) return cache;

  const out = Object.assign({}, FALLBACK);
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    out.statusBar = info.statusBarHeight || FALLBACK.statusBar;
    const width = info.windowWidth || 375;

    // 胶囊按钮位置：微信 7.0+ 才有，取不到就退回默认值
    const cap =
      typeof wx.getMenuButtonBoundingClientRect === 'function'
        ? wx.getMenuButtonBoundingClientRect()
        : null;
    if (cap && cap.width > 0 && cap.top > 0) {
      // 标题行上下留白对称，使文字与胶囊垂直居中
      out.navH = (cap.top - out.statusBar) * 2 + cap.height;
      // 右侧让位：屏幕右边缘到胶囊左边缘 + 8px 呼吸位
      out.capsuleGap = width - cap.left + 8;
    }
  } catch (e) {
    /* 取不到就用默认值，保证渲染不崩 */
  }

  cache = out;
  return cache;
}

/** 页面 onLoad 里调用：一次 setData 注入尺寸，WXML 直接绑定 */
function apply(page) {
  const m = metrics();
  if (page && typeof page.setData === 'function') {
    page.setData({ statusBar: m.statusBar, navH: m.navH, capsuleGap: m.capsuleGap });
  }
  return m;
}

module.exports = { metrics: metrics, apply: apply };
