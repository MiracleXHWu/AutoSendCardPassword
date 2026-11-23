// custom-tab-bar/index.js —— 自定义 tabBar
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/category/category', text: '分类', icon: 'grid' },
      { pagePath: '/pages/orders/orders', text: '订单', icon: 'order' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: 'user' }
    ]
  },

  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      const i = Number(index);
      if (this.data.selected === i) return;
      this.setData({ selected: i });
      wx.switchTab({ url: path });
    },

    /** 由页面在 onShow 时调用，保证进入任意 tab 后高亮正确 */
    setSelected(index) {
      if (this.data.selected !== index) this.setData({ selected: index });
    }
  }
});
