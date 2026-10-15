/**
 * qrcode —— 生成「扫码进入指定商品」的小程序码（云函数）
 *
 * 为什么需要它：
 *   用户扫码后要直达某个商品的购买页，靠的是小程序码里的 scene 参数。
 *   scene 会被微信作为 query 传给落地页 onLoad，落地页据此定位商品。
 *
 * action:
 *   getQrcode   为某个商品生成（或复用）小程序码，返回云存储 fileID
 *   listQrcodes 列出所有在售商品及其小程序码
 *   resolve     把落地页拿到的 scene 反解成 productId（哈希别名场景需要）
 *
 * 环境变量：
 *   MP_APPID / MP_APP_SECRET  仅 HTTPS 兜底通路需要；云调用可省略
 *
 * 生成策略：
 *   优先走云调用 cloud.openapi.wxacode.getUnlimited（免 access_token、免 IP 白名单）；
 *   云调用不可用时自动降级为 HTTPS + access_token。
 *
 * scene 规则（官方限制：最大 32 个可见字符）：
 *   productId 仅含数字/字母/_.- 且长度 ≤ 30  →  scene = 'g_' + productId（无需查库，落地页直接解析）
 *   其余情况                                  →  scene = 'h_' + md5 前 10 位，映射存入 qr_alias 集合
 */
const crypto = require('crypto');

/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    前端只会看到 -504002 functions execute fail | 145 code exit unexpected。
 *    两个顺序要求，缺一即崩：
 *      ① require('wx-server-sdk') 必须成功
 *         —— 部署时必须选「上传并部署：云端安装依赖」
 *      ② cloud.init() 必须早于任何 cloud.database() 调用，**包括**
 *         require('./wechat.js')：wechat.js 在自身模块顶层就会取 db。
 * ------------------------------------------------------------------ */
let cloud = null;
let BOOT_ERROR = '';
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (e) {
  BOOT_ERROR = (e && e.message) || String(e);
}

// 必须在 init 之后再加载 wechat.js（它在模块顶层即调用 cloud.database()）
const wx = require('./wechat.js');

let db = null;
if (!BOOT_ERROR) {
  try {
    db = cloud.database();
  } catch (e) {
    BOOT_ERROR = (e && e.message) || String(e);
  }
}

/** 启动失败时返回可操作的错误，而不是让进程崩溃 */
function bootFailure() {
  return {
    ok: false,
    code: 'FUNCTION_BOOT_FAIL',
    error: BOOT_ERROR,
    msg: '云函数启动失败：' + BOOT_ERROR,
    hint:
      '常见原因：① 依赖未安装 —— 右键 cloudfunctions/qrcode 选「上传并部署：云端安装依赖」重新部署；' +
      '② 云函数运行时版本过低 —— 在云开发控制台把运行时改为 Nodejs16.13。'
  };
}

const MP_APPID = process.env.MP_APPID || '';
const MP_APP_SECRET = process.env.MP_APP_SECRET || '';

/** 扫码落地页（必须是 app.json 里已注册的页面；非 tabBar 页体验最好） */
const LANDING_PAGE = 'pages/goods/goods';

const SAFE_PID = /^[A-Za-z0-9_.-]{1,30}$/;

exports.main = async (event = {}) => {
  // 启动期失败时给出可读原因，避免只看到 145
  if (BOOT_ERROR) return bootFailure();

  const { action = 'getQrcode' } = event;
  try {
    switch (action) {
      case 'getQrcode':
        return await getQrcode(event);
      case 'listQrcodes':
        return await listQrcodes();
      case 'resolve':
        return await resolveScene(event);
      default:
        return { ok: false, msg: '不支持的操作：' + action };
    }
  } catch (e) {
    console.error('[qrcode]', action, e);
    return { ok: false, msg: e.message || '生成失败' };
  }
};

/* ------------------------------------------------------------------ */
/* 生成 / 复用小程序码                                                  */
/* ------------------------------------------------------------------ */
async function getQrcode({ productId, envVersion = 'release', width, force = false }) {
  if (!productId) return { ok: false, msg: '缺少 productId' };
  if (!['release', 'trial', 'develop'].includes(envVersion)) {
    return { ok: false, msg: 'envVersion 只能是 release / trial / develop' };
  }

  const goodsRes = await db.collection('goods').where({ productId }).limit(1).get();
  const goods = goodsRes.data[0];
  if (!goods) return { ok: false, msg: '商品不存在：' + productId };

  const scene = await buildScene(productId);

  // 命中缓存：同一商品 + 同一版本 + 同一 scene 直接复用，避免重复调用被限频
  if (!force && goods.qrFileID && goods.qrScene === scene && goods.qrEnvVersion === envVersion) {
    return { ok: true, cached: true, fileID: goods.qrFileID, scene, page: LANDING_PAGE, envVersion };
  }

  const buffer = await generateBuffer({ scene, page: LANDING_PAGE, envVersion, width });
  const cloudPath = `qrcode/${envVersion}/${scene}.png`;
  const up = await cloud.uploadFile({ cloudPath, fileContent: buffer });

  await db.collection('goods').doc(goods._id).update({
    data: {
      qrFileID: up.fileID,
      qrScene: scene,
      qrEnvVersion: envVersion,
      qrUpdatedAt: new Date()
    }
  });

  return { ok: true, cached: false, fileID: up.fileID, scene, page: LANDING_PAGE, envVersion };
}

/* ------------------------------------------------------------------ */
/* 图片生成：云调用优先，HTTPS 兜底                                      */
/* ------------------------------------------------------------------ */
async function generateBuffer({ scene, page, envVersion, width }) {
  const args = {
    scene,
    page,
    // checkPath=false：允许小程序尚未发布、或落地页尚未在现网存在时先联调
    checkPath: false,
    envVersion,
    width: width || 430
  };

  try {
    const res = await cloud.openapi.wxacode.getUnlimited(args);
    if (res && res.buffer && res.buffer.length) return res.buffer;
    console.warn('[qrcode] 云调用返回为空，转 HTTPS 兜底', res && res.errCode, res && res.errMsg);
  } catch (e) {
    console.warn('[qrcode] 云调用异常，转 HTTPS 兜底：', e.message);
  }
  return await generateByHttps(args);
}

async function generateByHttps({ scene, page, envVersion, width }) {
  if (!MP_APPID || !MP_APP_SECRET) {
    throw new Error(
      '生成失败：云调用不可用，且未配置 MP_APPID / MP_APP_SECRET 环境变量，无法使用 HTTPS 兜底'
    );
  }
  const token = await wx.getAccessToken({ appid: MP_APPID, secret: MP_APP_SECRET });
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`;
  const body = JSON.stringify({
    scene,
    page,
    check_path: false,
    env_version: envVersion,
    width: width || 430
  });

  const res = await wx.httpsRequestRaw({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body
  });

  // 失败时微信返回的是 JSON，成功时才是图片二进制
  const head = (res.text || '').trim().slice(0, 1);
  if (head === '{') {
    let err = {};
    try {
      err = JSON.parse(res.text);
    } catch (e) {
      /* 忽略解析失败 */
    }
    throw new Error(`生成小程序码失败：${err.errcode || ''} ${err.errmsg || res.text}`);
  }
  if (!res.buffer || !res.buffer.length) throw new Error('生成小程序码失败：返回内容为空');
  return res.buffer;
}

/* ------------------------------------------------------------------ */
/* scene 编解码                                                        */
/* ------------------------------------------------------------------ */
async function buildScene(productId) {
  if (SAFE_PID.test(productId)) return 'g_' + productId;

  // productId 含特殊字符或过长：用短哈希占位，映射单独存库
  const shortId = crypto.createHash('md5').update(String(productId)).digest('hex').slice(0, 10);
  await db.collection('qr_alias').doc(shortId).set({
    data: { productId, updatedAt: new Date() }
  });
  return 'h_' + shortId;
}

async function resolveScene({ scene }) {
  const s = String(scene || '');
  if (s.startsWith('g_')) return { ok: true, productId: s.slice(2) };
  if (s.startsWith('h_')) {
    try {
      const r = await db.collection('qr_alias').doc(s.slice(2)).get();
      return { ok: true, productId: (r.data && r.data.productId) || '' };
    } catch (e) {
      return { ok: true, productId: '' };
    }
  }
  // 兼容：scene 直接就是 productId
  return { ok: true, productId: s };
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */
async function listQrcodes() {
  const res = await db
    .collection('goods')
    .where({ enabled: true })
    .orderBy('sort', 'asc')
    .get();
  return {
    ok: true,
    page: LANDING_PAGE,
    list: (res.data || []).map((g) => ({
      productId: g.productId,
      title: g.title,
      fileID: g.qrFileID || '',
      scene: g.qrScene || ''
    }))
  };
}
