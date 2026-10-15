// custom-tab-bar/index.js —— 自定义 tabBar（图标用内联 SVG，无需图片资源）
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '商品', icon: 'shop' },
      { pagePath: '/pages/orders/orders', text: '我的订单', icon: 'order' }
    ]
  },

  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      const i = Number(index);
      if (this.data.selected === i) return;
      this.setData({ selected: i });
      wx.switchTab({ url: path });
    }
  }
});
