/**
 * 微信侧工具（timercheck 内独立副本，云函数之间不共享目录）
 * 与 cloudfunctions/vpay/wechat.js 内容一致，修改时请同步。
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

function httpsRequest({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
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
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error('获取 access_token 失败：' + res.body);
  const expireAt = new Date(Date.now() + (data.expires_in - 600) * 1000);
  const payload = { token: data.access_token, expireAt, updatedAt: new Date() };
  if (doc) await col.doc(doc._id).update({ data: payload });
  else await col.add({ data: Object.assign({ key: 'access_token' }, payload) });
  return data.access_token;
}

function calcPaySig(uri, postBody, appKey) {
  return crypto.createHmac('sha256', appKey).update(uri + '&' + postBody, 'utf8').digest('hex');
}

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
  return JSON.parse(res.body);
}

module.exports = { httpsRequest, getAccessToken, calcPaySig, queryOrder };
