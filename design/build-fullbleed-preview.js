/**
 * build-fullbleed-preview.js —— 用真实 WXSS 渲染四个 Tab 页的静态预览
 * ---------------------------------------------------------------
 * 生成 design/tabs-fullbleed.html：把 app.wxss + 各页 wxss 原样注入，
 * 页面结构按 wxml 手抄一份（数据写死），用来核对「顶部是否真的铺满」。
 * 改了样式后重跑：node design/build-fullbleed-preview.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');

function wxss(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* page{} 里的 CSS 变量搬到 .device 上（预览容器），其余选择器不动 */
const global = wxss('app.wxss').replace(/(^|\n)page\s*\{/g, '$1.device {');
const pageCss = [
  wxss('pages/index/index.wxss'),
  wxss('pages/category/category.wxss'),
  wxss('pages/orders/orders.wxss'),
  wxss('pages/mine/mine.wxss')
].join('\n\n');

const SHELL = `
* { margin:0; padding:0; }
html, body { background:#eceff3; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; }
view { display:block; }
text { display:inline; }
image { display:block; }
.scroll-x { overflow:hidden; }
.rowwrap { display:flex; gap:24px; padding:24px; flex-wrap:wrap; justify-content:center; align-items:flex-start; }
.item { width:375px; }
.device { width:375px; height:812px; border-radius:30px; overflow:hidden; position:relative;
  border:1px solid rgba(16,24,40,.12); box-shadow:0 12px 32px -20px rgba(16,24,40,.45); background:#faf6f0; }
.caption { text-align:center; font-size:12px; color:#66707d; margin-top:10px; }
/* 状态栏 + 胶囊按钮（真机安全区模拟） */
.status { position:absolute; top:0; left:0; right:0; height:44px; display:flex; align-items:center;
  justify-content:space-between; padding:0 18px; font-size:12.5px; font-weight:600; color:#3a2c1c; z-index:9; pointer-events:none; }
.capsule { position:absolute; top:48px; right:7px; width:87px; height:32px; border-radius:16px;
  border:1px solid rgba(58,44,28,.14); background:rgba(255,255,255,.55); z-index:9;
  display:flex; align-items:center; justify-content:space-around; color:#5a4a36; font-size:13px; }
.capsule i { width:4px; height:4px; border-radius:50%; background:#5a4a36; display:block; }
.capsule .dotwrap { display:flex; gap:3px; }
.capsule .ring { width:13px; height:13px; border:1.6px solid #5a4a36; border-radius:50%; }
`;

const phone = (title, body) => `
<div class="item">
  <div class="device">
    <div class="status"><span>9:41</span><span>&#9679;&#9679;&#9679; &#9660;</span></div>
    <div class="capsule">
      <span class="dotwrap"><i></i><i></i><i></i></span>
      <span class="ring"></span>
    </div>
    ${body}
  </div>
  <div class="caption">${title}</div>
</div>`;

/* ---------------- 1. 首页 ---------------- */
const INDEX = `
<view class="page index">
  <view class="screen-hero" style="padding-top:44px">
    <view class="hero-top" style="padding-right:100px">
      <view class="hero-title">
        <view class="brand">影软小铺</view>
        <view class="slogan">付款即刻自动发货 · 全程自助</view>
      </view>
    </view>
    <view class="search-pill">
      <view class="search-pill-ico"></view>
      <text class="search-pill-txt">搜索商品名称 / 关键词</text>
    </view>
    <view class="hero-stats glass">
      <view class="hs"><text class="hs-n">36</text><text class="hs-l">在售商品</text></view>
      <view class="hs-line"></view>
      <view class="hs"><text class="hs-n">6</text><text class="hs-l">商品分类</text></view>
      <view class="hs-line"></view>
      <view class="hs"><text class="hs-n">7×24</text><text class="hs-l">自动发货</text></view>
    </view>
  </view>

  <view class="cat-scroll scroll-x">
    <view class="cat-row">
      <view class="cat on">全部</view>
      <view class="cat">会员卡</view>
      <view class="cat">游戏点卡</view>
      <view class="cat">软件授权</view>
      <view class="cat">教程资源</view>
    </view>
  </view>

  <view class="body">
    <view class="grid">
      <view class="gcard">
        <view class="gcover" style="background:linear-gradient(135deg,#fdeedd,#fbd9bc)">
          <text class="ginitial">会</text>
          <view class="badge">推荐</view>
        </view>
        <view class="gbody">
          <view class="gname clamp2">腾讯视频会员月卡 直充秒到</view>
          <view class="gtags"><text class="tag">自动发货</text><text class="tag">秒到账</text></view>
          <view class="gfoot">
            <view class="price"><text class="unit">¥</text>18.80</view>
            <text class="price-origin">¥25.00</text>
            <text class="gsold">已售 1.2万</text>
          </view>
        </view>
      </view>
      <view class="gcard">
        <view class="gcover" style="background:linear-gradient(135deg,#e6e9ff,#cdd4fb)">
          <text class="ginitial">游</text>
        </view>
        <view class="gbody">
          <view class="gname clamp2">王者荣耀 100 点券 官方直充</view>
          <view class="gtags"><text class="tag gray">游戏点卡</text></view>
          <view class="gfoot">
            <view class="price"><text class="unit">¥</text>9.90</view>
            <text class="gsold">已售 8623</text>
          </view>
        </view>
      </view>
      <view class="gcard">
        <view class="gcover" style="background:linear-gradient(135deg,#d9f2e5,#b7e8cf)">
          <text class="ginitial">软</text>
          <view class="soldout">已售罄</view>
        </view>
        <view class="gbody">
          <view class="gname clamp2">Office 365 家庭版 一年订阅</view>
          <view class="gtags"><text class="tag">官方授权</text></view>
          <view class="gfoot">
            <view class="price"><text class="unit">¥</text>199.00</view>
            <text class="gsold">已售 326</text>
          </view>
        </view>
      </view>
      <view class="gcard">
        <view class="gcover" style="background:linear-gradient(135deg,#e4f4fb,#c4e6f5)">
          <text class="ginitial">教</text>
        </view>
        <view class="gbody">
          <view class="gname clamp2">Python 全栈实战课 永久回看</view>
          <view class="gtags"><text class="tag">网盘发货</text></view>
          <view class="gfoot">
            <view class="price"><text class="unit">¥</text>29.90</view>
            <text class="gsold">已售 2041</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</view>`;

/* ---------------- 2. 分类 ---------------- */
const CATEGORY = `
<view class="catpage" style="height:812px">
  <view class="screen-hero cat-hero" style="padding-top:44px">
    <view class="nav-row" style="height:44px;padding-right:100px">
      <text class="nav-title">商品分类</text>
    </view>
    <view class="search-pill">
      <view class="search-pill-ico"></view>
      <text class="search-pill-txt">搜索商品 / 关键词</text>
    </view>
  </view>

  <view class="split">
    <view class="side">
      <view class="side-item on"><text>会员卡</text></view>
      <view class="side-item"><text>游戏点卡</text></view>
      <view class="side-item"><text>软件授权</text></view>
      <view class="side-item"><text>教程资源</text></view>
      <view class="side-item"><text>话费流量</text></view>
      <view class="side-item"><text>其它</text></view>
    </view>

    <view class="main" style="overflow:hidden">
      <view class="main-head">
        <text class="main-title">会员卡</text>
        <text class="main-count">8 件商品</text>
      </view>
      <view class="sub-scroll scroll-x">
        <view class="sub-row">
          <view class="sub on">全部</view>
          <view class="sub">视频会员</view>
          <view class="sub">音乐会员</view>
          <view class="sub">网盘会员</view>
        </view>
      </view>
      <view class="grid">
        <view class="gcard">
          <view class="gcover" style="background:linear-gradient(135deg,#fdeedd,#fbd9bc)"><text class="ginitial">腾</text></view>
          <view class="gbody">
            <view class="gname clamp2">腾讯视频会员月卡 直充秒到</view>
            <view class="gfoot"><view class="price"><text class="unit">¥</text>18.80</view><text class="gsold">已售 1.2万</text></view>
          </view>
        </view>
        <view class="gcard">
          <view class="gcover" style="background:linear-gradient(135deg,#e6e9ff,#cdd4fb)"><text class="ginitial">爱</text></view>
          <view class="gbody">
            <view class="gname clamp2">爱奇艺黄金会员季卡 官方直充</view>
            <view class="gfoot"><view class="price"><text class="unit">¥</text>42.00</view><text class="gsold">已售 5321</text></view>
          </view>
        </view>
        <view class="gcard">
          <view class="gcover" style="background:linear-gradient(135deg,#d9f2e5,#b7e8cf)"><text class="ginitial">网</text><view class="soldout">已售罄</view></view>
          <view class="gbody">
            <view class="gname clamp2">百度网盘超级会员月卡</view>
            <view class="gfoot"><view class="price"><text class="unit">¥</text>15.50</view><text class="gsold">已售 987</text></view>
          </view>
        </view>
        <view class="gcard">
          <view class="gcover" style="background:linear-gradient(135deg,#fbe6ef,#f6ccdd)"><text class="ginitial">网</text></view>
          <view class="gbody">
            <view class="gname clamp2">网易云音乐黑胶 VIP 月卡</view>
            <view class="gfoot"><view class="price"><text class="unit">¥</text>8.80</view><text class="gsold">已售 4120</text></view>
          </view>
        </view>
      </view>
    </view>
  </view>
</view>`;

/* ---------------- 3. 订单 ---------------- */
const ORDERS = `
<view class="orderspage">
  <view class="screen-hero" style="padding-top:44px">
    <view class="nav-row" style="height:44px;padding-right:100px">
      <text class="nav-title">我的订单</text>
      <text class="nav-sub">共 3 单</text>
    </view>
    <view class="stats glass">
      <view class="stat"><text class="n">3</text><text class="l">全部订单</text></view>
      <view class="stat"><text class="n amber">1</text><text class="l">待支付</text></view>
      <view class="stat"><text class="n green">2</text><text class="l">已支付</text></view>
    </view>
    <view class="query-entry">换设备了？手机号查单 ›</view>
  </view>

  <view class="tabs">
    <view class="tab on">全部</view>
    <view class="tab">待支付</view>
    <view class="tab">已支付</view>
  </view>

  <view class="list">
    <view class="ocard">
      <view class="ocard-head"><text class="mono muted">20261124113802123456</text><text class="status ok">已支付</text></view>
      <view class="ocard-body">
        <view class="thumb"><text class="thumb-initial">腾</text></view>
        <view class="flex1">
          <view class="oname clamp2">腾讯视频会员月卡 直充秒到</view>
          <view class="ometa">月卡 · 1 件</view>
        </view>
        <view class="price"><text class="unit">¥</text>18.80</view>
      </view>
      <view class="ocard-foot"><text class="muted">11-24 11:38</text>
        <view class="actions"><view class="btn small ghost">查看卡密</view></view>
      </view>
    </view>

    <view class="ocard">
      <view class="ocard-head"><text class="mono muted">20261124112209987654</text><text class="status wait">待支付</text></view>
      <view class="ocard-body">
        <view class="thumb"><text class="thumb-initial">王</text></view>
        <view class="flex1">
          <view class="oname clamp2">王者荣耀 100 点券 官方直充</view>
          <view class="ometa">100 点券 · 2 件</view>
        </view>
        <view class="price"><text class="unit">¥</text>19.80</view>
      </view>
      <view class="ocard-foot"><text class="muted">11-24 11:22</text>
        <view class="actions"><view class="btn small">继续支付</view></view>
      </view>
    </view>

    <view class="ocard">
      <view class="ocard-head"><text class="mono muted">20261123201105654321</text><text class="status ok">已支付</text></view>
      <view class="ocard-body">
        <view class="thumb"><text class="thumb-initial">P</text></view>
        <view class="flex1">
          <view class="oname clamp2">Python 全栈实战课 永久回看</view>
          <view class="ometa">默认规格 · 1 件</view>
        </view>
        <view class="price"><text class="unit">¥</text>29.90</view>
      </view>
      <view class="ocard-foot"><text class="muted">11-23 20:11</text>
        <view class="actions"><view class="btn small ghost">查看卡密</view></view>
      </view>
    </view>
  </view>
</view>`;

/* ---------------- 4. 我的 ---------------- */
const MINE = `
<view class="minepage">
  <view class="screen-hero" style="padding-top:44px">
    <view class="nav-row" style="height:44px;padding-right:100px">
      <text class="nav-title">我的</text>
    </view>
    <view class="user">
      <view class="avatar"><text class="avatar-text">影</text></view>
      <view class="flex1">
        <view class="uname">微信用户</view>
        <view class="ustatus"><text>已登录 · openid 已绑定</text></view>
      </view>
      <view class="login-btn">刷新</view>
    </view>
    <view class="phone-row glass">
      <text class="phone-label">手机号</text>
      <text class="phone-val">138****8888</text>
      <text class="phone-arrow">›</text>
    </view>
  </view>

  <view class="stats-card">
    <view class="stat"><text class="n">3</text><text class="l">全部订单</text></view>
    <view class="stat"><text class="n amber">1</text><text class="l">待支付</text></view>
    <view class="stat"><text class="n green">2</text><text class="l">已支付</text></view>
    <view class="stat"><text class="n">12</text><text class="l">商品分类</text></view>
  </view>

  <view class="menu">
    <view class="menu-item"><view class="mi-ico mi-order"></view><text class="mi-text">我的订单</text><text class="mi-arrow">›</text></view>
    <view class="menu-item"><view class="mi-ico mi-search"></view><text class="mi-text">手机号 / 订单号查单</text><text class="mi-arrow">›</text></view>
    <view class="menu-item"><view class="mi-ico mi-help"></view><text class="mi-text">帮助与客服</text><text class="mi-arrow">›</text></view>
    <view class="menu-item"><view class="mi-ico mi-info"></view><text class="mi-text">关于本店</text><text class="mi-arrow">›</text></view>
  </view>

  <view class="foot">
    <view>影软小铺</view>
    <view class="muted" style="margin-top:4px">商品与卡密由发卡平台实时提供</view>
  </view>
</view>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>四页全铺满顶部 · 实样式预览</title>
<style>
${SHELL}
${global}
${pageCss}
</style>
</head>
<body>
<div class="rowwrap">
${phone('首页', INDEX)}
${phone('分类', CATEGORY)}
${phone('订单', ORDERS)}
${phone('我的', MINE)}
</div>
</body>
</html>
`;

const out = path.join(__dirname, 'tabs-fullbleed.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 ' + path.relative(path.resolve(__dirname, '..'), out) + '（' + html.length + ' 字节）');
