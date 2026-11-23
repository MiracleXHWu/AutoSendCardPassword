// pages/pay/pay.js —— 支付：本地二维码 / 虚拟支付 + 轮询到账
const api = require('../../services/api.js');
const orders = require('../../services/orders.js');
const pay = require('../../services/pay.js');
const qrcode = require('../../services/qrcode.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

// 用安全访问层替代模块顶层 getApp()：热重载/独立上下文下 App 可能尚未就绪
const app = require('../../utils/app.js');

/** 配置缺失时的兜底支付有效期（分钟） */
const DEFAULT_WINDOW_MINUTES = 5;

Page({
  data: {
    tradeNo: '',
    name: '',
    amountText: '',
    linkLabel: '在线支付',
    qrImage: '',
    qrError: '',
    checking: false,
    paid: false,
    leftText: '05:00',
    expired: false,
    canContinue: false,
    orderUrl: '',
    tip: ''
  },

  onLoad(query) {
    const pending = app.globalData.pendingOrder;
    const tradeNo = query.tradeNo || (pending && pending.tradeNo) || '';
    if (!tradeNo) {
      this.setData({ qrError: '缺少订单号，请到「订单」里查看' });
      return;
    }

    // 已支付过的订单不必再展示二维码
    const local = orders.get(tradeNo);
    if (local && local.paid) {
      wx.redirectTo({ url: '/pages/order-detail/order-detail?tradeNo=' + tradeNo });
      return;
    }

    const info = this.resolvePayInfo(tradeNo);
    this.payInfo = info;

    this.setData({
      tradeNo: tradeNo,
      name: info.name || '',
      amountText: info.amountText || '',
      orderUrl: info.url || '',
      linkLabel: pay.describeLink(info.url).label,
      tip: info.leaveMessage || ''
    });

    if (info.type === 'vpay') {
      this.useVpay();
    } else {
      this.renderQrcode(info.url);
    }
    this.startCountdown();
    this.startPolling();
  },

  /**
   * 取回支付信息（继续支付的关键）
   * 优先级：本次下单的内存对象 → 本地订单里存的收银台链接 → 按 faka 规则重建链接。
   * faka 的收银台地址是确定性的：/user/pay/order.{tradeNo}.1（本地渲染）/ .2（表单提交），
   * 所以即使用户杀掉小程序再回来，也能凭订单号重新拉起支付。
   */
  resolvePayInfo(tradeNo) {
    const pending = app.globalData.pendingOrder;
    if (pending && String(pending.tradeNo) === String(tradeNo) && pending.url) {
      return pending;
    }

    const local = orders.get(tradeNo);
    if (local) {
      return {
        tradeNo: tradeNo,
        url: local.payUrl || pay.buildCashierUrl(tradeNo, local.payType),
        name: local.name || '',
        amountText: local.amountText || '',
        type: 'qrcode',
        leaveMessage: ''
      };
    }

    // 换设备后用「手机号查单」进来：本地没有记录，按规则重建收银台链接
    return {
      tradeNo: tradeNo,
      url: pay.buildCashierUrl(tradeNo),
      name: '',
      amountText: '',
      type: 'qrcode',
      leaveMessage: ''
    };
  },

  onUnload() {
    this.alive = false;
    if (this.timer) clearInterval(this.timer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
  },

  /* -------------------- 二维码 -------------------- */
  renderQrcode(url) {
    if (!url) {
      this.setData({ qrError: '未获取到支付链接' });
      return;
    }

    let matrix;
    try {
      matrix = qrcode.encode(url, { ecl: 'M' });
    } catch (e) {
      this.setData({ qrError: e.message || '二维码生成失败，可复制链接后付款' });
      return;
    }

    // canvas 2d 需要基础库 2.9.0+；失败时降级为复制链接
    wx.createSelectorQuery()
      .in(this)
      .select('#qr')
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0];
        if (!item || !item.node) {
          this.setData({ qrError: '当前微信版本不支持本地生成二维码，请复制链接后在浏览器付款' });
          return;
        }
        try {
          const canvas = item.node;
          const cssSize = item.width || 220;
          const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
          const pixel = Math.floor(cssSize * dpr);
          canvas.width = pixel;
          canvas.height = pixel;

          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, pixel, pixel);
          ctx.fillStyle = '#101828';

          const count = matrix.size;
          const quiet = 2; // 静区
          const cell = Math.floor(pixel / (count + quiet * 2));
          const offset = Math.floor((pixel - cell * count) / 2);

          for (let y = 0; y < count; y++) {
            for (let x = 0; x < count; x++) {
              if (matrix.modules[y][x]) {
                ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell);
              }
            }
          }

          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (r) => this.setData({ qrImage: r.tempFilePath, qrError: '' }),
            fail: () => this.setData({ qrError: '二维码导出失败，请复制链接后付款' })
          });
        } catch (e) {
          this.setData({ qrError: '二维码绘制失败，请复制链接后付款' });
        }
      });
  },

  /** 虚拟支付通道 */
  useVpay() {
    pay
      .requestVpay({ tradeNo: this.data.tradeNo, amount: 0 })
      .then(() => {
        this.checkNow();
      })
      .catch((e) => {
        if (e.canceled) {
          this.setData({ tip: '已取消支付，可点「继续支付」重新发起' });
          return;
        }
        // 虚拟支付不可用时回退到二维码
        wx.showToast({ title: e.message || '虚拟支付不可用', icon: 'none' });
        if (this.data.orderUrl) this.renderQrcode(this.data.orderUrl);
      });
  },

  /* -------------------- 倒计时 -------------------- */
  /** 支付有效期：默认 5 分钟，到点后展示「继续支付」 */
  startCountdown() {
    if (this.timer) clearInterval(this.timer);
    const minutes = Number(config.payWindowMinutes) > 0 ? Number(config.payWindowMinutes) : DEFAULT_WINDOW_MINUTES;
    const total = minutes * 60 * 1000;

    this.expireAt = Date.now() + total;
    this.setData({ leftText: format.countdown(total), expired: false, canContinue: false });

    this.timer = setInterval(() => {
      const left = (this.expireAt || 0) - Date.now();
      if (left <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.setData({ leftText: '00:00', expired: true, canContinue: true });
        return;
      }
      this.setData({ leftText: format.countdown(left) });
    }, 1000);
  },

  /**
   * 继续支付：重开一轮有效期、重绘二维码、恢复轮询。
   * 收银台链接由订单号决定，超时不会让链接失效，所以无需重新下单。
   */
  continuePay() {
    const url = this.data.orderUrl;
    if (!url) {
      wx.showModal({
        title: '无法继续支付',
        content: '没有取到该订单的支付链接，请回到商品页重新下单，或联系客服核实订单状态。',
        showCancel: false
      });
      return;
    }

    this.setData({ expired: false, canContinue: false, qrError: '', qrImage: '' });
    this.renderQrcode(url);
    this.startCountdown();
    this.startPolling();
    wx.showToast({ title: '已重新发起支付', icon: 'none' });
  },

  /* -------------------- 轮询 -------------------- */
  startPolling() {
    // 重复进入（继续支付）时先清掉旧定时器，避免同时跑两条轮询
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.alive = true;

    const interval = (config.payPoll && config.payPoll.interval) || 3000;
    // 倒计时结束后降频，既不会漏掉「最后时刻付款」，也不会打满服务端限流
    const slow = Math.max(interval, 8000);

    const step = () => {
      if (!this.alive || this.data.paid) return;
      api
        .getOrderState(this.data.tradeNo)
        .then((state) => {
          if (state.paid) {
            this.onPaid();
            return;
          }
          if (this.alive) this.pollTimer = setTimeout(step, this.data.expired ? slow : interval);
        })
        .catch(() => {
          if (this.alive) this.pollTimer = setTimeout(step, interval + 2000);
        });
    };
    this.pollTimer = setTimeout(step, interval);
  },

  /** 手动「我已完成支付」 */
  checkNow() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    api
      .getOrderState(this.data.tradeNo)
      .then((state) => {
        this.setData({ checking: false });
        if (state.paid) {
          this.onPaid();
        } else {
          wx.showToast({ title: '尚未收到支付结果', icon: 'none' });
        }
      })
      .catch((e) => {
        this.setData({ checking: false });
        wx.showToast({ title: e.message || '查询失败', icon: 'none' });
      });
  },

  async onPaid() {
    if (this.data.paid) return;
    this.alive = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.timer) clearInterval(this.timer);

    this.setData({ paid: true });
    orders.patch(this.data.tradeNo, { paid: true, status: 1, payTime: Date.now() });
    wx.showToast({ title: '支付成功', icon: 'success' });

    setTimeout(() => {
      wx.redirectTo({ url: '/pages/order-detail/order-detail?tradeNo=' + this.data.tradeNo });
    }, 700);
  },

  copyLink() {
    const url = this.data.orderUrl;
    if (!url) {
      wx.showToast({ title: '没有可复制的链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' })
    });
  },

  gotoOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  gotoHelp() {
    wx.navigateTo({ url: '/pages/help/help?tradeNo=' + this.data.tradeNo });
  }
});
