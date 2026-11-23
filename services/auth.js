/**
 * 登录与身份
 * ---------------------------------------------------------------
 * 静默 openid 登录 + 手机号选填。
 *
 * 为什么需要服务端：
 *   wx.login 只给一个 code，换 openid 必须用 AppSecret 调 jscode2session。
 *   AppSecret 绝不能放在小程序里，所以这一步落在你自己的发卡平台后端
 *   （见 acg-faka-3.8.4/app/Controller/User/Api/Wx.php 的 login 方法）。
 *   这不是云函数，也不依赖云数据库，就是站点上的一个普通 PHP 接口。
 *
 * 接口不可用时（未上传补丁 / 站点还没配 AppID）：
 *   自动降级为「游客模式」，下单照常可用 —— faka 本身支持未登录下单，
 *   只是换设备后无法凭 openid 找回订单，需要靠手机号查单。
 */
const api = require('./api.js');
const http = require('./request.js');

const PROFILE_KEY = 'auth.profile';
const PHONE_KEY = 'auth.phone';

let profile = null;
let logging = false;
let pending = null;
const listeners = [];

function readProfile() {
  if (profile) return profile;
  try {
    profile = wx.getStorageSync(PROFILE_KEY) || null;
  } catch (e) {
    profile = null;
  }
  return profile;
}

function saveProfile(next) {
  profile = next || null;
  try {
    if (profile) wx.setStorageSync(PROFILE_KEY, profile);
    else wx.removeStorageSync(PROFILE_KEY);
  } catch (e) {
    /* ignore */
  }
  listeners.forEach(function (fn) {
    try {
      fn(profile);
    } catch (e) {
      /* 单个订阅者异常不影响其他人 */
    }
  });
  return profile;
}

/** 唤醒 wx.login 拿 code */
function getLoginCode() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (r) {
        if (r && r.code) resolve(r.code);
        else reject(http.makeError('获取微信登录凭证失败', -10));
      },
      fail: function () {
        reject(http.makeError('获取微信登录凭证失败', -10));
      }
    });
  });
}

/** 订阅登录态变化，返回取消订阅函数 */
function onChange(fn) {
  if (typeof fn !== 'function') return function () {};
  listeners.push(fn);
  return function () {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * 静默登录
 * @param {{force?:boolean}} opts force=true 时忽略缓存重新换一次 code
 * @returns {Promise<{loggedIn:boolean, guest:boolean, profile:object|null}>}
 */
function silentLogin(opts) {
  const o = opts || {};
  const cached = readProfile();
  if (!o.force && cached && cached.loggedIn) {
    return Promise.resolve({ loggedIn: true, guest: false, profile: cached });
  }
  if (logging && pending) return pending;

  logging = true;
  pending = getLoginCode()
    .then(function (code) {
      return api.wxLogin(code);
    })
    .then(function (res) {
      const next = {
        loggedIn: true,
        guest: false,
        openid: res.openid || '',
        userId: res.user && res.user.id ? res.user.id : 0,
        nickname: (res.user && (res.user.nicename || res.user.username)) || '',
        avatar: (res.user && res.user.avatar) || '',
        phone: getPhone() || (res.user && res.user.phone) || '',
        loginAt: Date.now()
      };
      return { loggedIn: true, guest: false, profile: saveProfile(next) };
    })
    .catch(function (err) {
      // 后端补丁未上传时接口 404，属于预期内的可降级场景，不弹错
      const next = {
        loggedIn: false,
        guest: true,
        openid: '',
        userId: 0,
        nickname: '',
        avatar: '',
        phone: getPhone() || '',
        loginAt: Date.now(),
        reason: err && err.message
      };
      return { loggedIn: false, guest: true, profile: saveProfile(next), error: err };
    })
    .then(function (r) {
      logging = false;
      pending = null;
      return r;
    });

  return pending;
}

/** 已登录（含会话失效后自动重登一次） */
function isLoggedIn() {
  const p = readProfile();
  return !!(p && p.loggedIn);
}

/** 是否游客模式（登录接口不可用） */
function isGuest() {
  const p = readProfile();
  return !p || p.guest === true;
}

/**
 * 包装一个需要登录才更稳的调用：失败且疑似会话失效时重新登录并重试一次
 */
function withAuth(fn) {
  return Promise.resolve()
    .then(fn)
    .catch(function (err) {
      if (!http.isAuthError(err)) throw err;
      return silentLogin({ force: true }).then(function () {
        return fn();
      });
    });
}

/** 手机号（选填）：作为下单联系方式默认值与换设备查单凭据 */
function getPhone() {
  try {
    return wx.getStorageSync(PHONE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setPhone(phone) {
  const value = String(phone || '').trim();
  try {
    if (value) wx.setStorageSync(PHONE_KEY, value);
    else wx.removeStorageSync(PHONE_KEY);
  } catch (e) {
    /* ignore */
  }
  const p = readProfile();
  if (p) saveProfile(Object.assign({}, p, { phone: value }));
  return value;
}

/** 校验手机号格式（与 faka 下单校验一致：1 开头的 11 位） */
function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || '').trim());
}

/** 登录后把手机号写回站点，便于后台按手机号核对订单 */
function bindPhone(phone) {
  const value = setPhone(phone);
  if (!isLoggedIn()) return Promise.resolve({ ok: false, local: true });
  return api
    .wxBindPhone(value)
    .then(function () {
      return { ok: true };
    })
    .catch(function (err) {
      // 后端补丁未提供该方法时只保留本地值，不打断流程
      return { ok: false, error: err };
    });
}

function logout() {
  http.clearCookie();
  saveProfile(null);
}

module.exports = {
  silentLogin,
  onChange,
  isLoggedIn,
  isGuest,
  withAuth,
  getPhone,
  setPhone,
  isValidPhone,
  bindPhone,
  logout,
  readProfile
};
