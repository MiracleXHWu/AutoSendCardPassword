/**
 * 统一网络层
 * ---------------------------------------------------------------
 * 面向 acg-faka 的 /user/api/* 接口，只做四件事：
 *   1. 拼 baseUrl、序列化表单（faka 的 $request->post() 读的是 urlencoded 表单）；
 *   2. 维护登录 Cookie（faka 用 USER_SESSION 这个 Cookie 承载会话，不是 PHP session）；
 *   3. 把 {code,msg,data} 归一化成 Promise 或 ApiError；
 *   4. 把网络异常翻译成用户能看懂的中文。
 *
 * 为什么不用 cookie 自动托管：
 *   小程序的 wx.request 确实会在运行期内保存 Set-Cookie，但不保证跨启动保留，
 *   而「我的订单」要在下次打开时仍能查。这里手动把 USER_SESSION 落到 storage。
 */
const config = require('../config.js');

const COOKIE_KEY = 'faka.cookie';

/** 记录 Cookie 属于哪个站点，换域名时用于自动作废旧会话 */
const COOKIE_HOST_KEY = 'faka.cookie.host';

/**
 * 关于 User-Agent
 * faka 的 /user/api/index/pay 会按 UA 判定终端类型（Client::isMobile / isWeChat），
 * 但小程序的 wx.request **禁止**设置 user-agent，控制台会报
 * "Refused to set unsafe header user-agent"。
 * 好消息是微信自己会带上含 MicroMessenger 的 UA，正好命中
 * Client::isMobile() 的关键词表，equipment=3 仍然稳定。
 */

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */
function makeError(message, code, data) {
  const err = new Error(message || '请求失败');
  err.code = code == null ? -1 : code;
  err.data = data;
  err.api = true;
  return err;
}

/** 该错误是否属于「未登录」——用于触发一次静默重登 */
function isAuthError(err) {
  const msg = (err && err.message) || '';
  return /登录|登陆|未授权|无权限/.test(msg) && !/验证码/.test(msg);
}

/* ------------------------------------------------------------------ */
/* Cookie 管理                                                         */
/* ------------------------------------------------------------------ */
function readCookie() {
  try {
    const host = currentHost();
    const savedHost = wx.getStorageSync(COOKIE_HOST_KEY) || '';
    // 换域名后旧会话对新站点毫无意义，带着发出去只会污染服务端会话表
    if (host && savedHost && savedHost !== host) return '';
    return wx.getStorageSync(COOKIE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function writeCookie(value) {
  try {
    if (value) {
      wx.setStorageSync(COOKIE_KEY, value);
      wx.setStorageSync(COOKIE_HOST_KEY, currentHost());
    } else {
      wx.removeStorageSync(COOKIE_KEY);
      wx.removeStorageSync(COOKIE_HOST_KEY);
    }
  } catch (e) {
    /* storage 写失败不影响主流程 */
  }
}

/** 当前 apiBase 的主机名（含端口），用于把会话 Cookie 绑定到具体站点 */
function currentHost() {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(config.apiBase || ''));
  return m ? m[1].toLowerCase() : '';
}

function parseCookieJar(str) {
  const jar = {};
  String(str || '')
    .split(';')
    .forEach((pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) return;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (name) jar[name] = value;
    });
  return jar;
}

function stringifyJar(jar) {
  return Object.keys(jar)
    .map((k) => k + '=' + jar[k])
    .join('; ');
}

/**
 * 把响应头里的 Set-Cookie 合并进本地 jar
 * 注意：多个 Set-Cookie 可能被合并成一行，用逗号分隔，但 Expires 里也有逗号，
 * 所以只在「逗号后面紧跟 name=」处切分。
 */
function absorbSetCookie(header) {
  if (!header) return;
  let raw = null;
  Object.keys(header).forEach((k) => {
    if (k.toLowerCase() === 'set-cookie') raw = header[k];
  });
  if (!raw) return;

  const lines = Array.isArray(raw) ? raw : [raw];
  const jar = parseCookieJar(readCookie());

  lines.forEach((line) => {
    String(line)
      .split(/,(?=\s*[^;,=\s]+=)/)
      .forEach((one) => {
        const first = String(one).split(';')[0];
        const i = first.indexOf('=');
        if (i <= 0) return;
        const name = first.slice(0, i).trim();
        const value = first.slice(i + 1).trim();
        if (!name) return;
        const expired = value === '' || /expires=Thu,\s*01\s*Jan\s*1970/i.test(one);
        if (expired) delete jar[name];
        else jar[name] = value;
      });
  });

  writeCookie(stringifyJar(jar));
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */
/** faka 兼容的表单序列化：sku[名称]=值、sku[名称][]=值 */
function encodeForm(obj, prefix, out) {
  const parts = out || [];
  if (obj == null) return parts;
  Object.keys(obj).forEach((key) => {
    const value = obj[key];
    const name = prefix ? prefix + '[' + key + ']' : key;
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') encodeForm(v, name + '[' + i + ']', parts);
        else parts.push(encodeURIComponent(name + '[' + i + ']') + '=' + encodeURIComponent(String(v)));
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, parts);
    } else {
      parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(value)));
    }
  });
  return parts;
}

/**
 * GET 查询串
 * faka 的 commodity 接口读的是 $_GET['categoryId'] 这类扁平键，
 * 但 valuation / stock 需要 sku[尺寸]=值 这种 PHP 数组语法：
 * 方括号必须保持原样，否则 PHP 会把它当成一个名为 "sku[尺寸]" 的普通字段。
 */
function toQuery(data) {
  return encodeForm(data || {})
    .join('&')
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']');
}

/** POST 表单体，同样保留方括号 */
function toFormBody(data) {
  return toQuery(data);
}

/* ------------------------------------------------------------------ */
/* 网络异常文案                                                        */
/* ------------------------------------------------------------------ */
function friendlyFail(e) {
  const msg = (e && e.errMsg) || '';
  if (/timeout/i.test(msg)) return '网络超时，请检查网络后重试';
  if (/domain list|not in domain|合法域名/i.test(msg)) return '接口域名未配置，请在 MP 后台添加 request 合法域名';
  if (/ssl|certificate/i.test(msg)) return '证书校验失败，站点需使用有效的 HTTPS 证书';
  if (/err_empty_response|empty response/i.test(msg)) return '服务器未返回内容（连接被重置），请检查站点是否正常、PHP 是否报错';
  if (/connection refused|econnrefused|err_connection/i.test(msg)) return '无法连接服务器，请确认 apiBase 域名可访问';
  if (/abort/i.test(msg)) return '请求已取消';
  return '网络异常，请稍后重试';
}

/* ------------------------------------------------------------------ */
/* 核心请求                                                            */
/* ------------------------------------------------------------------ */
/**
 * @param {object} opts
 * @param {string} opts.path      以 / 开头的接口路径
 * @param {string} [opts.method]  GET | POST
 * @param {object} [opts.data]
 * @param {number} [opts.timeout]
 * @returns {Promise<any>} resolve 为接口的 data 字段
 */
function request(opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  let url = /^https?:/i.test(opts.path) ? opts.path : base + opts.path;

  const header = {
    'content-type': 'application/x-www-form-urlencoded'
  };
  const cookie = readCookie();
  if (cookie) header.Cookie = cookie;

  let payload;
  if (method === 'GET') {
    const qs = toQuery(opts.data);
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    payload = undefined;
  } else {
    payload = toFormBody(opts.data || {});
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      header,
      data: payload,
      timeout: opts.timeout || config.requestTimeout,
      success(res) {
        absorbSetCookie(res.header);

        const raw = typeof res.data === 'string' ? res.data : '';
        const isHtml = /^\s*</.test(raw);

        let body = res.data;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (e) {
            body = null;
          }
        }

        if (res.statusCode === 404) {
          // 最常见的两种成因：apiBase 指错站点、服务端未部署 Wx 补丁
          reject(makeError('接口不存在（HTTP 404），请确认服务端已部署该接口：' + opts.path, 404));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(makeError(
            '服务异常（HTTP ' + res.statusCode + (isHtml ? '，服务端返回了 HTML 错误页' : '') + '）：' + opts.path,
            res.statusCode
          ));
          return;
        }
        if (!body || typeof body !== 'object') {
          // 带上路径与响应形态，否则线上只能看到一句通用提示，无法定位
          const kind = isHtml ? 'HTML 页面' : (raw ? '非 JSON 文本' : '空响应');
          const brief = isHtml ? '' : ('：' + raw.replace(/\s+/g, ' ').slice(0, 40));
          reject(makeError('接口返回格式异常（' + opts.path + '，HTTP ' + res.statusCode + '，' + kind + brief + '）', -3));
          return;
        }
        if (Number(body.code) !== 200) {
          reject(makeError(body.msg || '请求失败', Number(body.code) || 400, body.data));
          return;
        }
        // 分页接口把 total 放在最外层（{code,msg,data,total}），需要整体返回时用 raw
        resolve(opts.raw ? body : body.data);
      },
      fail(e) {
        reject(makeError(friendlyFail(e), -2));
      }
    });
  });
}

const get = (path, data, timeout) => request({ path, method: 'GET', data, timeout });
const post = (path, data, timeout) => request({ path, method: 'POST', data, timeout });

module.exports = {
  request,
  get,
  post,
  encodeForm,
  toQuery,
  toFormBody,
  readCookie,
  writeCookie,
  absorbSetCookie,
  clearCookie: () => writeCookie(''),
  isAuthError,
  makeError,
  friendlyFail,
  COOKIE_KEY
};
