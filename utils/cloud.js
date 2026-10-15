/**
 * utils/cloud.js —— 云开发环境守卫
 *
 * 解决三个问题：
 *   1) env 留空时 SDK 落到不存在的「默认环境」，报 -501000 INVALID_ENV；
 *   2) 原始报错是英文栈信息，用户既看不懂也不知道该改哪里；
 *   3) 页面 onShow / 下拉刷新反复发请求，环境不通时把控制台刷爆。
 *
 * 用法：
 *   const cloud = require('../../utils/cloud.js');
 *   if (cloud.isBlocked()) { ...展示引导卡片，不再发请求... }
 *   catch (e) { const msg = cloud.friendly(e); }   // 归一化文案 + 自动熔断
 */

const config = require('../config.js');

/* ------------------------------------------------------------------ */
/* 错误特征                                                            */
/* ------------------------------------------------------------------ */
/** -501000 = INVALID_ENV，已在本项目实测确认 */
const ENV_ERR_RE = /-501000|INVALID_ENV|Environment not found|no default environment|环境不存在/i;
/** 云函数未部署 */
const FN_ERR_RE = /FUNCTION_NOT_FOUND|FunctionName|函数不存在|function\s+not\s+found/i;
/** 数据集合未创建 */
const COLL_ERR_RE = /DATABASE_COLLECTION_NOT_EXIST|集合不存在|collection[^.]{0,30}not\s*exist/i;
/** 官方说明：AppID 首次开通云环境后约 10 分钟内云 API 尚不可用，报 invalid scope */
const SCOPE_ERR_RE = /invalid scope|invalid_scope/i;
// 云函数进程「启动即崩溃」（依赖缺失 / 未 init）。与「函数不存在」是两回事，
// 必须先于 FN_ERR_RE 判定，否则会被误判成"没部署"。
const CRASH_ERR_RE = /-504002|FUNCTIONS_EXECUTE_FAIL|code exit unexpected|145\s*code/i;

/* ------------------------------------------------------------------ */
/* 配置指引（自检页与弹窗共用）                                          */
/* ------------------------------------------------------------------ */
const GUIDE_STEPS = [
  {
    title: '换成你自己的小程序 AppID',
    detail:
      '本项目 project.config.json 里的 appid 目前是 touristappid（游客号）。官方明确：云开发「无游客模式、也不可以使用测试号」。请在开发者工具「详情 → 基本信息」改成你注册的小程序 AppID，然后重新编译。',
    hint: '没有 AppID？到 mp.weixin.qq.com 注册个人主体小程序即可，免费。'
  },
  {
    title: '开通云开发并新建环境',
    detail:
      '点击开发者工具工具栏左侧的「云开发」按钮 → 同意协议 → 「新建环境」。环境名称随意填，例如 shop。新账号通常有免费额度。',
    hint: '若工具栏没有「云开发」按钮，说明当前项目用的还是游客号或测试号，先完成第 1 步。'
  },
  {
    title: '把环境 ID 填进 config.js',
    detail:
      '在云开发控制台「设置 → 环境 ID」复制那串 ID（形如 cloud1-9gxxxxxxxxxxxxx），粘贴到 miniprogram/config.js 的 cloudEnv 字段并保存。',
    hint: '首次开通环境后约 10 分钟内云 API 才可用，这期间自检会提示「正在初始化」，等一会儿再试即可。'
  },
  {
    title: '上传部署 6 个云函数',
    detail:
      '在开发者工具里右键 cloudfunctions 下的每个目录 → 「上传并部署：云端安装依赖」。共 6 个：vpay、qrcode、deliver、vpaynotify、timercheck、initdb。',
    hint: '必须用「云端安装依赖」，否则 wx-server-sdk 不会被装上。之后只要改过某个函数的代码，都要对它重新执行一次「上传并部署」以覆盖云端旧版本（例如首页商品读取依赖 vpay 的 listGoods 接口）。'
  },
  {
    title: '开通虚拟支付并配置 4 个环境变量',
    detail:
      '先到 MP 后台（mp.weixin.qq.com）→「功能 → 虚拟支付」开通，并在「道具管理」新建道具：道具 ID 必须与 goods 集合里的 productId 一致，道具价格必须与 goods 里的 price 一致（单位都是「分」）。' +
      '然后到云开发控制台 →「云函数」→ 选中 vpay →「配置」→「环境变量」，添加 4 个变量：MP_APPID、MP_APP_SECRET（MP 后台「开发管理 → 开发设置」获取）、OFFER_ID、APP_KEY（虚拟支付页面获取）。' +
      '另外建议给 timercheck、qrcode 也配上前两个（兜底查单与生成小程序码要用）。',
    hint:
      '这 4 个变量不配，点「立即购买」会提示「云函数环境变量未配置完整 / 未配置完整」——那是叫你来补这一步，不是代码故障。保存后立即生效，不需要重新部署。'
  },
  {
    title: '初始化数据库（跑一次 initdb）',
    detail:
      '最简单的方式：直接点本页上方的「一键初始化数据库」按钮。也可以走控制台——云开发控制台 →「云函数」→ 找到 initdb 那一行 → 点行尾的「云端测试」→ 参数保持 {} → 点「运行测试」。',
    hint:
      '注意：列表里叫「云端测试」，不叫「测试运行」；且必须先部署 initdb，它才会出现在列表里。'
  },
  {
    title: '（可选）开放 goods 集合的读权限',
    detail:
      '云开发控制台 →「数据库」→ 选中 goods →「权限设置」→ 选「所有用户可读，仅管理端可写」。' +
      '其余集合（cards / xpay_orders / sys_cache / xpay_complaints / qr_alias）保持「仅管理端可读写」不动。',
    hint:
      '不配也能用：小程序端读不到时会自动改用 vpay 云函数以管理端权限代读商品（首页/自检页都会提示）。' +
      '配上这一步只是让首页少一次云函数调用、加载更快。'
  }
];

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
const state = {
  sdk: false, // wx.cloud 是否存在（基础库是否够新）
  appId: '', // 当前小程序 AppID
  libVersion: '', // 调试基础库版本
  env: '', // config.js 中配置的环境 ID
  ready: false, // 是否可正常发起云调用
  blocked: false, // 是否已被「环境不可用」熔断
  code: '', // 诊断码：OK / TOURIST / NO_ENV_ID / ENV_INVALID / NO_CLOUD / INIT_FAIL
  title: '', // 诊断标题（面向用户）
  message: '' // 诊断说明（面向用户）
};

let warned = false; // 环境错误只完整打印一次，避免刷屏
let guided = false; // 自动弹窗每个会话只弹一次
let sdkInited = false; // wx.cloud.init 是否已调用
let sdkInitedEnv = ''; // 上次初始化使用的 env，用于判断是否需要重新初始化

/* ------------------------------------------------------------------ */
/* 状态读写                                                            */
/* ------------------------------------------------------------------ */
function getState() {
  return Object.assign({}, state);
}

/** 当前是否可以安全地发起云调用 */
function ok() {
  return state.ready && !state.blocked;
}

function isBlocked() {
  return state.blocked;
}

function setIssue(code, title, message, blocked) {
  state.code = code;
  state.title = title;
  state.message = message;
  state.blocked = !!blocked;
  state.ready = !state.blocked;
  return state;
}

function clearIssue() {
  state.code = 'OK';
  state.title = '';
  state.message = '';
  state.blocked = false;
  state.ready = true;
  return state;
}

function resetWarn() {
  warned = false;
}

/* ------------------------------------------------------------------ */
/* 环境信息                                                            */
/* ------------------------------------------------------------------ */
function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function getAppId() {
  const info = safeCall(() => wx.getAccountInfoSync(), null);
  return (info && info.miniProgram && info.miniProgram.appId) || '';
}

function getLibVersion() {
  const sys = safeCall(() => wx.getSystemInfoSync(), null);
  return (sys && sys.SDKVersion) || '';
}

/** develop（开发者工具）/ trial（体验版）/ release（正式版） */
function getEnvVersion() {
  const info = safeCall(() => wx.getAccountInfoSync(), null);
  return (info && info.miniProgram && info.miniProgram.envVersion) || '';
}

/**
 * 是否展示「面向开发者」的排错提示（集合权限、控制台路径之类）。
 * 正式版里一律不展示——顾客不需要看到后台配置信息。
 */
function showDevHints() {
  return !!config.debugEnv && getEnvVersion() !== 'release';
}

function isTourist() {
  return !state.appId || state.appId === 'touristappid';
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
/**
 * 初始化云开发。必须在任何云调用之前执行（app.js onLaunch 已调用）。
 * 返回当前状态快照。
 */
function init() {
  state.appId = getAppId();
  state.libVersion = getLibVersion();
  state.env = String(config.cloudEnv || '').trim();
  state.sdk = !!wx.cloud;

  if (!state.sdk) {
    return setIssue(
      'NO_CLOUD',
      '当前基础库不支持云开发',
      '请在开发者工具「详情 → 本地设置 → 调试基础库」中选择 2.2.3 以上版本，然后重新编译。',
      true
    );
  }

  try {
    // 关键修复点：显式传入 env，避免 SDK 落到不存在的「默认环境」
    // 同一 env 只初始化一次，重复调用无意义；改了 config.js 会自动重新初始化
    if (!sdkInited || sdkInitedEnv !== state.env) {
      wx.cloud.init({
        env: state.env || undefined,
        traceUser: true
      });
      sdkInited = true;
      sdkInitedEnv = state.env;
    }
  } catch (e) {
    return setIssue(
      'INIT_FAIL',
      '云开发初始化失败',
      rawMsg(e) || '请确认当前 AppID 是有效的小程序 AppID（不能是游客号）。',
      true
    );
  }

  if (isTourist()) {
    return setIssue(
      'TOURIST',
      '当前是游客模式，云开发不可用',
      '项目 AppID 仍是 touristappid（或未能读取到 AppID）。云开发不支持游客号与测试号，必须换成你自己的小程序 AppID。',
      true
    );
  }

  if (!state.env) {
    // 尚未显式配置：先放行试一次（个别账号确实存在默认环境），真报错再熔断
    state.code = 'NO_ENV_ID';
    state.title = '未指定云开发环境';
    state.message =
      'config.js 的 cloudEnv 为空，SDK 会去查找账号下的「默认环境」。若不存在就会报 -501000，建议显式填写环境 ID。';
    state.blocked = false;
    state.ready = true;
    return state;
  }

  return clearIssue();
}

/* ------------------------------------------------------------------ */
/* 错误归一化                                                          */
/* ------------------------------------------------------------------ */
function rawMsg(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return String(e.errMsg || e.message || e.errorMessage || e);
}

function isEnvError(e) {
  return ENV_ERR_RE.test(rawMsg(e));
}

/** 标记环境不可用，并按当前掌握的信息给出最贴近的诊断 */
function markBlocked() {
  state.blocked = true;
  state.ready = false;

  if (isTourist()) {
    state.code = 'TOURIST';
    state.title = '当前是游客模式，云开发不可用';
    state.message = 'AppID 仍是 touristappid，请换成你自己的小程序 AppID 后重新编译。';
  } else if (!state.env) {
    state.code = 'NO_ENV_ID';
    state.title = '没有找到云开发环境';
    state.message = 'config.js 的 cloudEnv 为空，且当前账号下没有「默认环境」，请填写环境 ID。';
  } else {
    state.code = 'ENV_INVALID';
    state.title = '云开发环境不可用';
    state.message =
      '环境 ID「' +
      state.env +
      '」访问失败：可能是 ID 拼写有误、环境已被删除，或该环境不属于当前 AppID。';
  }
  return state;
}

/**
 * 把任意错误翻译成可直接展示给用户的文案。
 * 命中环境类错误时会自动熔断，后续页面不再发起云请求。
 */
function friendly(e, fallback) {
  const msg = rawMsg(e);

  if (isEnvError(e)) {
    markBlocked();
    if (!warned) {
      warned = true;
      console.warn('[cloud] 云开发环境未就绪，已熔断后续请求。原始报错：', msg);
    }
    return state.message || '云开发环境未就绪，请先完成环境配置。';
  }
  if (CRASH_ERR_RE.test(msg)) {
    return '云函数启动失败（-504002 / 145）：最常见原因是依赖没装上。请右键对应函数目录，选择「上传并部署：云端安装依赖」重新部署；若仍失败，在云开发控制台把该函数运行时改为 Nodejs16.13。';
  }
  if (FN_ERR_RE.test(msg)) {
    return '云函数尚未部署：请右键 cloudfunctions 下的函数目录，选择「上传并部署：云端安装依赖」。';
  }
  if (COLL_ERR_RE.test(msg)) {
    return '数据集合尚未初始化：请先运行一次 initdb 云函数。';
  }
  if (SCOPE_ERR_RE.test(msg)) {
    return '云环境刚开通，微信侧仍在初始化（官方说明约需 10 分钟）。请稍后再点「重新自检」，期间不需要改任何代码。';
  }
  if (/timeout|ETIMEDOUT|网络超时/i.test(msg)) {
    return '网络超时，请稍后重试。';
  }
  return msg || fallback || '操作失败，请重试。';
}

/** 探针成功后解除熔断（环境修好后无需重启小程序） */
function clearBlocked() {
  if (state.blocked) clearIssue();
  return state;
}

/* ------------------------------------------------------------------ */
/* 引导                                                                */
/* ------------------------------------------------------------------ */
function goSetup() {
  wx.navigateTo({ url: '/pages/setup/setup' });
}

/** 弹出配置指引；同一会话内只自动弹一次，force = true 可强制弹出 */
function showGuide(force) {
  if (guided && !force) return;
  guided = true;

  const st = getState();
  wx.showModal({
    title: st.title || '云环境未就绪',
    content:
      (st.message ? st.message + '\n\n' : '') +
      '点「查看指引」按 5 步完成云开发配置，完成后可重新自检。',
    confirmText: '查看指引',
    cancelText: '稍后',
    confirmColor: '#059a57',
    success: (r) => {
      if (r.confirm) goSetup();
    }
  });
}

/** 生成可复制的诊断文本，便于排查或对外求助 */
function diagnostic() {
  const st = getState();
  return [
    '【wx-auto-deliver 云环境自检】',
    '小程序 AppID：' + (st.appId || '(未获取到)') + (isTourist() ? '  ← 游客号，必须替换' : ''),
    '版本环境：' + (getEnvVersion() || '(未获取到)'),
    '调试基础库：' + (st.libVersion || '(未知)'),
    'wx.cloud：' + (st.sdk ? '可用' : '不可用'),
    '已配置环境 ID：' + (st.env || '(空，强烈建议显式填写)'),
    '诊断结果：' + (st.code || 'UNKNOWN') + '  ' + (st.title || '正常'),
    '说明：' + (st.message || '云环境可用，无需处理。')
  ].join('\n');
}

function copyDiagnostic() {
  wx.setClipboardData({
    data: diagnostic(),
    success: () => wx.showToast({ title: '诊断信息已复制', icon: 'none' })
  });
}

module.exports = {
  // 生命周期
  init,
  // 查询
  ok,
  isBlocked,
  getState,
  isEnvError,
  rawMsg,
  getEnvVersion,
  showDevHints,
  // 错误处理
  friendly,
  markBlocked,
  clearBlocked,
  resetWarn,
  // 引导
  showGuide,
  goSetup,
  diagnostic,
  copyDiagnostic,
  GUIDE_STEPS
};
