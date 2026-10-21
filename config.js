/**
 * ============================================================
 *  全局配置 —— 部署前唯一需要手动修改的文件
 * ============================================================
 */
module.exports = {
  /**
   * 【必填】云开发环境 ID
   *
   * 从哪拿：微信开发者工具 → 顶部工具栏「云开发」 → 设置 → 环境 ID
   * 形如：cloud1-9gxxxxxxxxxxxxx
   *
   * 为什么必须填：
   *   env 留空时，SDK 会去查找账号下的「默认环境」。若该环境下不存在
   *   （AppID 还是游客号 touristappid、或从未创建过云环境），就会报：
   *     errCode: -501000  INVALID_ENV
   *     Environment not found, there is no default environment exists
   *   显式填写环境 ID 可以从根上避免这个问题。
   */
  cloudEnv: 'cloud1-xxxxxxx',

  /**
   * 检测到云环境不可用时，是否自动弹出配置指引
   * （首页本身也会展示引导卡片，弹窗只是多一次提醒，建议保持 true）
   */
  autoShowEnvGuide: true,

  /** 打开小程序时在控制台打印环境自检信息（联调期建议 true） */
  debugEnv: true
};
