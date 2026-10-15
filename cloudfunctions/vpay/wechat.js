/**
 * 微信侧工具：access_token 缓存 + 双签名 + 官方接口调用
 * 说明：getAccessToken 接口「不支持云调用」，只能走 HTTPS + AppSecret
 */
const crypto = require('crypto');
const https = require('https');

/* ------------------------------------------------------------------
 * wx-server-sdk 的加载与初始化 —— 这两步都在「模块加载期」执行
 *
 * ⚠️ 模块加载期抛出的异常没有任何上层 try/catch 能兜住，它会直接终止
 *    Node 进程，前端只能看到：
 *      -504002 functions execute fail | 145 code exit unexpected
 *
 * 因此必须同时满足两点，缺一即崩：
 *   ① 依赖已安装：部署时必须选「上传并部署：云端安装依赖」
 *   ② 在调用 cloud.database() 之前先完成 cloud.init()
 *       —— SDK 的 database() 被 wrapCommonAPICheck 包装，未初始化时会抛
 *          「Cloud API isn't enabled, please call init first」。
 * ------------------------------------------------------------------ */
let cloud = null;
let sdkReady = false;
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }); // 重复 init 安全，SDK 内部有 inited 短路
  sdkReady = true;
} catch (e) {
  console.error('[wechat] wx-server-sdk 加载/初始化失败：', (e && e.message) || e);
}

/** 依赖不可用时为 null。切勿在模块顶层直接写 cloud.database() */
const db = sdkReady ? cloud.database() : null;

/** 取数据库句柄；未就绪时抛可读错误，而不是 TypeError */
function getDb() {
  if (!db) {
    throw new Error(
      '云函数依赖未就绪（wx-server-sdk 未安装或未初始化）：' +
        '请右键该函数目录，选择「上传并部署：云端安装依赖」重新部署。'
    );
  }
  return db;
}

/** 极简 HTTPS 请求（避免为一个请求引入第三方依赖） */
function httpsRequest({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求微信接口超时')));
    if (body) req.write(body);
    req.end();
  });
}

/** access_token 用数据库缓存，避免频繁刷新触发限频 */
async function getAccessToken({ appid, secret }) {
  const col = getDb().collection('sys_cache');
  const cached = await col.where({ key: 'access_token' }).limit(1).get();
  const doc = cached.data[0];
  if (doc && doc.token && doc.expireAt && new Date(doc.expireAt).getTime() > Date.now() + 60000) {
    return doc.token;
  }

  const res = await httpsRequest({
    url: `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  });
  let data = {};
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('获取 access_token 响应异常：' + res.body);
  }
  if (!data.access_token) {
    throw new Error(
      `获取 access_token 失败：${res.body}（若报 IP 白名单错误，请在 MP 后台「开发管理-开发设置-IP 白名单」中处理）`
    );
  }
  const expireAt = new Date(Date.now() + (data.expires_in - 600) * 1000);
  const payload = { token: data.access_token, expireAt, updatedAt: new Date() };
  if (doc) await col.doc(doc._id).update({ data: payload });
  else await col.add({ data: Object.assign({ key: 'access_token' }, payload) });
  return data.access_token;
}

/** paySig = HMAC-SHA256(AppKey, uri + '&' + postBody)，postBody 必须与真实发出字节完全一致 */
function calcPaySig(uri, postBody, appKey) {
  return crypto.createHmac('sha256', appKey).update(uri + '&' + postBody, 'utf8').digest('hex');
}

/** signature = HMAC-SHA256(sessionKey, signData) 用户态签名 */
function calcSignature(postBody, sessionKey) {
  return crypto.createHmac('sha256', sessionKey).update(postBody, 'utf8').digest('hex');
}

/** 用 wx.login 的 code 换 session_key（云开发云函数不直接下发 session_key） */
async function code2Session({ appid, secret, code }) {
  const res = await httpsRequest({
    url: `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${encodeURIComponent(
      code
    )}&grant_type=authorization_code`
  });
  let data = {};
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('code2Session 响应异常：' + res.body);
  }
  if (!data.openid || !data.session_key) {
    throw new Error('登录态换取失败：' + res.body);
  }
  return data;
}

/** 官方查单（兜底发货用）：POST /xpay/query_order */
async function queryOrder({ openid, outTradeNo, appid, secret, appKey }) {
  const token = await getAccessToken({ appid, secret });
  const uri = '/xpay/query_order';
  const bodyStr = JSON.stringify({ openid, env: 0, order_id: outTradeNo });
  const paySig = calcPaySig(uri, bodyStr, appKey);
  const url = `https://api.weixin.qq.com${uri}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`;
  const res = await httpsRequest({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body: bodyStr
  });
  let data = {};
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('查单响应异常：' + res.body);
  }
  return data;
}

module.exports = {
  httpsRequest,
  getAccessToken,
  calcPaySig,
  calcSignature,
  code2Session,
  queryOrder
};
