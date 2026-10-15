// pages/goods/goods.js —— 商品详情页（小程序码扫码落地页）
const vpay = require('../../utils/vpay.js');
const cloud = require('../../utils/cloud.js');
const format = require('../../utils/format.js');

const DEFAULT_NOTICE = [
  '付款成功后系统会立即自动发货，无需人工等待。',
  '发货内容永久保存在「我的订单」中，随时可重新查看。',
  '虚拟内容一经发出不支持无理由退款；若链接失效，请联系客服补发。'
].join('\n');

Page({
  data: {
    loading: true,
    notFound: false,
    envIssue: null,
    goods: null,
    priceText: '',
    // 价格不合法：不显示金额、不允许下单，改为提示去修配置
    priceInvalid: false,
    priceReason: '',
    // 只有开发者工具/体验版展示「原因 + 修法」，正式版顾客看不到
    devHints: false,
    buying: false,
    fromScan: false,
    perks: [],
    notice: ''
  },

  onLoad(query) {
    const productId = query.productId || query.pid || '';
    const rawScene = query.scene ? decodeURIComponent(query.scene) : '';
    this.productId = productId;
    this.rawScene = rawScene;
    this.setData({ fromScan: !!rawScene, devHints: cloud.showDevHints() });
    this.init();
  },

  /** 扫码进入时，先把 scene 解成 productId，再加载商品 */
  async init() {
    let pid = this.productId;
    if (!pid && this.rawScene) pid = await this.resolveScene(this.rawScene);
    if (!pid) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.productId = pid;
    await this.loadGoods(pid);
  },

  async resolveScene(scene) {
    // 'g_xxx' 这种格式可以在本地直接解出，无需请求
    if (scene.indexOf('g_') === 0) return scene.slice(2);
    try {
      const r = await vpay.callFn('qrcode', { action: 'resolve', scene });
      return r.productId || '';
    } catch (e) {
      console.error('[goods] resolveScene', e);
      return '';
    }
  },

  async loadGoods(productId) {
    // 环境未就绪时直接展示引导卡，避免落地页变成一句「商品不存在」
    if (cloud.isBlocked()) {
      this.setData({ loading: false, notFound: false, envIssue: cloud.getState() });
      return;
    }

    this.setData({ loading: true });
    try {
      // fetchGoods 返回 { goods, source, needFixPermission }：
      // 客户端直连读不到时会自动改由 vpay 云函数以管理端权限代读
      const res = await vpay.fetchGoods(productId);
      const g = res.goods;
      if (!g) {
        this.setData({ loading: false, notFound: true, envIssue: null });
        return;
      }

      // 价格统一走 format.priceOf 归一化：
      // 直接写 (g.price / 100).toFixed(2) 时，price 缺失或类型不对会渲染成「¥NaN」，
      // 既不报错也看不出原因。这里改成 —— 无效就不显示金额、并禁止下单。
      const p = format.priceOf(g.price);
      if (!p.valid) {
        console.warn('[goods] price 不合法，原始值 =', p.raw, '类型 =', p.rawType, '原因 =', p.reason);
      }

      this.setData({
        loading: false,
        notFound: false,
        envIssue: null,
        goods: g,
        priceText: p.text,
        priceInvalid: !p.valid,
        priceReason: p.valid ? '' : p.reason,
        perks: buildPerks(g),
        notice: g.notice || DEFAULT_NOTICE
      });
    } catch (e) {
      if (e.envIssue) {
        this.setData({ loading: false, notFound: false, envIssue: cloud.getState() });
        return;
      }
      console.error('[goods] loadGoods', e);
      this.setData({ loading: false, notFound: true });
      wx.showToast({ title: e.message || '商品加载失败，请稍后重试', icon: 'none' });
    }
  },

  retryEnv() {
    cloud.init();
    cloud.resetWarn();
    if (cloud.isBlocked()) {
      this.setData({ envIssue: cloud.getState() });
      wx.showToast({ title: '环境仍不可用', icon: 'none' });
      return;
    }
    this.setData({ envIssue: null, loading: true });
    if (this.productId) this.loadGoods(this.productId);
    else this.init();
  },

  goSetup() {
    cloud.goSetup();
  },

  async onBuy() {
    if (this.data.buying || !this.data.goods) return;

    // 价格不合法时坚决不放行：拿错误的金额去拉起支付，用户就会按错价付款
    if (this.data.priceInvalid) {
      if (!this.data.devHints) {
        // 顾客视角：只说结论，不暴露后台配置细节
        wx.showModal({
          title: '该商品暂不可购买',
          content: '商品信息正在维护中，请稍后再试；如有疑问可点本页底部的「联系客服」。',
          showCancel: false,
          confirmText: '知道了'
        });
        return;
      }
      wx.showModal({
        title: '商品价格未正确配置',
        content:
          '已暂停购买，避免按错误金额扣款。\n\n原因：' +
          (this.data.priceReason || 'price 字段不合法') +
          '\n\n请在「数据库 → goods」里把该商品的 price 改成数字类型的整数分（如 990），或在「运行环境自检」页让系统帮你检查一遍。',
        confirmText: '去自检',
        cancelText: '知道了',
        confirmColor: '#059a57',
        success: (r) => {
          if (r.confirm) cloud.goSetup();
        }
      });
      return;
    }

    this.setData({ buying: true });

    // 订阅消息授权（可选）：用户拒绝也不影响发货
    const tplId = this.data.goods.templateId;
    if (tplId) {
      await new Promise((resolve) => wx.requestSubscribeMessage({ tmplIds: [tplId], complete: resolve }));
    }

    try {
      const r = await vpay.buy(this.data.goods.productId);
      if (!r.ok) {
        if (r.reason === 'env') this.setData({ envIssue: cloud.getState() });
        if (r.reason === 'config') this.showConfigDialog(r);
        return;
      }
      getApp().globalData.lastOutTradeNo = r.outTradeNo;
      wx.showToast({ title: '支付成功', icon: 'success' });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/order/order?outTradeNo=${r.outTradeNo}` });
      }, 600);
    } catch (e) {
      wx.showToast({ title: e.message || '购买失败', icon: 'none' });
    } finally {
      this.setData({ buying: false });
    }
  },

  /**
   * 配置类失败的完整说明。
   * 用弹窗而不是 toast：这类文案（缺哪个环境变量、去哪儿填）远超 toast 的可显示长度，
   * 之前正是因为被截断，才只看到「云函数变量未配置完整」而不知道下一步做什么。
   */
  showConfigDialog(r) {
    const title =
      r.code === 'ENV_MISSING'
        ? '云函数环境变量未配置'
        : r.code === 'PRICE_INVALID'
          ? '商品价格未正确配置'
          : '无法下单';

    const content =
      (r.message || '') + (r.hint ? '\n\n' + r.hint : '') + '\n\n点「查看指引」可看到完整的配置步骤。';

    wx.showModal({
      title,
      content: content.slice(0, 500),
      confirmText: '查看指引',
      cancelText: '知道了',
      confirmColor: '#059a57',
      success: (res) => {
        if (res.confirm) cloud.goSetup();
      }
    });
  },

  onShareAppMessage() {
    const g = this.data.goods;
    return {
      title: g ? g.title : '资料小铺',
      path: `/pages/goods/goods?productId=${encodeURIComponent(this.productId || '')}`
    };
  },

  onShareTimeline() {
    const g = this.data.goods;
    return {
      title: g ? g.title : '资料小铺',
      query: `productId=${encodeURIComponent(this.productId || '')}`
    };
  }
});

/** 把商品配置翻译成用户看得懂的「你将获得」清单 */
function buildPerks(g) {
  if (g.deliveryMode === 'pool') {
    return [
      { icon: '🎟️', text: '专属兑换码，一人一份，不会与他人重复' },
      { icon: '🔒', text: '付款后立即分配并锁定，发完即止' },
      { icon: '🔁', text: '内容永久保存，可随时回小程序重新查看' }
    ];
  }
  return [
    { icon: '📦', text: '云盘分享链接（长期有效，建议及时转存）' },
    { icon: '🔑', text: '提取码同步展示，一键复制' },
    { icon: '🔁', text: '内容永久保存，可随时回小程序重新查看' }
  ];
}
