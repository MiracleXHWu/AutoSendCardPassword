// app.js
const config = require('./config.js');
const cloud = require('./utils/cloud.js');

App({
  globalData: {
    // 云开发环境 ID（启动时由 cloud.init() 回填，仅供展示）
    cloudEnv: '',
    // 最近一次下单的订单号，供发货成功后跳转
    lastOutTradeNo: ''
  },

  onLaunch() {
    // 云环境自检：显式指定 env，避免落到不存在的「默认环境」而报 -501000
    const st = cloud.init();
    this.globalData.cloudEnv = st.env;
		
		wx.cloud.init({
			traceUser: true,
			env: "cloud1-d3glwdarv1c16282d",
		})

    if (config.debugEnv) {
      console.log(
        '[app] 云环境自检 →',
        `AppID=${st.appId || '未获取到'}`,
        `基础库=${st.libVersion || '未知'}`,
        `env=${st.env || '(未指定)'}`,
        `状态=${st.code}`
      );
    }

    if (!st.blocked) return;

    console.warn('[app] ' + st.title + '：' + st.message);
    if (config.autoShowEnvGuide) {
      // 延后一点，等首页渲染完成再弹，避免首屏就被弹窗遮挡
      setTimeout(() => cloud.showGuide(), 800);
    }
  }
});
