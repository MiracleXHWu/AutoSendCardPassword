/**
 * acg-faka 前台接口封装
 * ---------------------------------------------------------------
 * 所有数据都实时来自发卡平台，小程序端不做任何商品/分类的本地镜像。
 * 接口清单（与 acg-faka 3.8.4 的 app/Controller/User/Api 一一对应）：
 *
 *   GET  /user/api/index/data               分类树
 *   GET  /user/api/index/commodity          商品列表（支持 categoryId / keywords / page / limit）
 *   GET  /user/api/index/commodityDetail    商品详情（commodityId）
 *   GET  /user/api/index/pay                可用支付通道（itemId）
 *   POST /user/api/index/stock              实时库存
 *   POST /user/api/index/valuation          实时价格（按数量/规格/优惠券算）
 *   POST /user/api/order/trade              提交订单，返回收银台 url
 *   POST /user/api/order/state              订单状态（轮询支付结果）
 *   POST /user/api/index/query              按手机号/订单号查单（换设备找回）
 *   POST /user/api/index/secret             取卡密
 *   POST /user/api/wx/login                 静默 openid 登录（本仓库附带的后端补丁）
 */
const http = require('./request.js');
const config = require('../config.js');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function toNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def == null ? 0 : def;
}

/** 把商品图片的相对路径补成绝对地址；已是 http(s) 的原样返回 */
function absUrl(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^(data:|wxfile:|cloud:)/i.test(raw)) return raw;
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  return base + (raw.charAt(0) === '/' ? raw : '/' + raw);
}

/** 价格展示：1.5 → "1.50"，整数也补两位小数，保持价签一致 */
function money(v) {
  const n = toNum(v, 0);
  return n.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */
/**
 * 分类 id 归一化
 * faka 会在分类树最前面注入「虚拟分类」，其 id 是字符串而非数字，
 * 例如 { id: 'recommend', name: '推荐' }。
 * 必须原样保留：一旦 Number('recommend') → NaN → 0，就会和「全部」(id=0) 撞车，
 * 表现为首页点「推荐」没有任何反应（会被判定为「已是当前分类」直接 return）。
 */
function catId(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

function normalizeCategory(node, parentId) {
  const children = Array.isArray(node.children) ? node.children : [];
  return {
    id: catId(node.id),
    name: String(node.name || ''),
    icon: absUrl(node.icon),
    parentId: parentId == null ? catId(node.pid) : parentId,
    children: children.map(function (c) {
      return normalizeCategory(c, catId(node.id));
    })
  };
}

/** 分类树展平，带层级，供左侧类目表与首页横向标签使用 */
function flattenCategories(tree, level, out) {
  const list = out || [];
  (tree || []).forEach(function (node) {
    list.push({
      id: node.id,
      name: node.name,
      icon: node.icon,
      parentId: node.parentId,
      level: level || 0,
      hasChildren: node.children && node.children.length > 0
    });
    if (node.children && node.children.length) flattenCategories(node.children, (level || 0) + 1, list);
  });
  return list;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(function (t) {
      if (!t) return null;
      if (typeof t === 'string') return { name: t, color: '' };
      return { name: String(t.name || t.title || ''), color: String(t.color || '') };
    })
    .filter(function (t) {
      return t && t.name;
    });
}

function normalizeCommodity(item) {
  const price = toNum(item.price, 0);
  const userPrice = toNum(item.user_price, 0) || price;
  return {
    id: toNum(item.id, 0),
    name: String(item.name || ''),
    cover: absUrl(item.cover),
    price: price,
    priceText: money(price),
    userPrice: userPrice,
    userPriceText: money(userPrice),
    // 会员价与零售价不同时，前端展示划线原价
    hasDiscount: userPrice < price,
    stock: toNum(item.stock, 0),
    stockState: toNum(item.stock_state, 0),
    sold: toNum(item.order_sold, 0),
    categoryId: toNum(item.category_id, 0),
    categoryName: item.category && item.category.name ? String(item.category.name) : '',
    deliveryWay: toNum(item.delivery_way, 0),
    tags: normalizeTags(item.tags),
    recommend: toNum(item.recommend, 0) === 1,
    seckill: !!item.seckill_active,
    wholesale: !!item.has_wholesale,
    // inventory_hidden 时 stock 已被服务端替换成「充足 / 已售罄」这类文案
    stockText: typeof item.stock === 'string' ? item.stock : ''
  };
}

/**
 * 商品详情归一化
 * widget 自定义下单字段只保留小程序能渲染的几种，custom 类型（后台可视化组件）跳过。
 */
function normalizeDetail(item) {
  const base = normalizeCommodity(item);

  let widget = [];
  if (Array.isArray(item.widget)) {
    widget = item.widget
      .filter(function (w) {
        return w && w.name && w.type !== 'custom';
      })
      .map(function (w) {
        return {
          name: String(w.name),
          label: String(w.cn || w.name),
          type: String(w.type || 'text'),
          placeholder: String(w.tip || w.placeholder || ''),
          required: !!w.require,
          regex: String(w.regex || ''),
          error: String(w.error || '')
        };
      });
  } else if (item.widget && typeof item.widget === 'object') {
    widget = Object.keys(item.widget).map(function (key) {
      return { name: key, label: key, type: 'text', placeholder: '', required: false, regex: '', error: '' };
    });
  }

  const cfg = item.config && typeof item.config === 'object' ? item.config : {};

  // 种类（race）：config.category 是 { 选项名: 加价 }
  const races = cfg.category && typeof cfg.category === 'object' && !Array.isArray(cfg.category)
    ? Object.keys(cfg.category).map(function (name) {
        return { name: name, premium: toNum(cfg.category[name], 0) };
      })
    : [];

  // 规格（sku）：config.sku 是 { 维度名: [可选值...] }
  const skuGroups = [];
  if (cfg.sku && typeof cfg.sku === 'object' && !Array.isArray(cfg.sku)) {
    Object.keys(cfg.sku).forEach(function (key) {
      const values = Array.isArray(cfg.sku[key]) ? cfg.sku[key] : [];
      if (values.length) skuGroups.push({ name: key, values: values.map(String) });
    });
  }

  return Object.assign(base, {
    description: String(item.description || ''),
    minimum: toNum(item.minimum, 0),
    maximum: toNum(item.maximum, 0),
    purchaseCount: toNum(item.purchase_count, 0),
    onlyUser: toNum(item.only_user, 0) === 1,
    contactType: toNum(item.contact_type, 0),
    passwordStatus: toNum(item.password_status, 0) === 1,
    tradeCaptcha: toNum(item.trade_captcha, 0) === 1,
    serviceUrl: String(item.service_url || ''),
    serviceQq: String(item.service_qq || ''),
    leaveMessage: String(item.leave_message || ''),
    races: races,
    skuGroups: skuGroups,
    widget: widget
  });
}

/* ------------------------------------------------------------------ */
/* 商品与分类                                                          */
/* ------------------------------------------------------------------ */
/** 分类树（原样树 + 展平列表） */
async function getCategories() {
  const tree = await http.get('/user/api/index/data');
  const normalized = (Array.isArray(tree) ? tree : []).map(function (n) {
    return normalizeCategory(n, 0);
  });
  return { tree: normalized, flat: flattenCategories(normalized, 0) };
}

/**
 * 商品列表
 * @returns {{list:Array, total:number, page:number, hasMore:boolean}}
 */
async function getCommodities(opts) {
  const o = opts || {};
  const page = Math.max(1, toNum(o.page, 1));
  const limit = o.limit === 0 ? 0 : toNum(o.limit, config.pageSize);
  const params = { page: page, limit: limit };
  if (o.keywords) params.keywords = o.keywords;
  // categoryId 可能是数字，也可能是 'recommend' 这类虚拟分类的字符串 id，原样透传
  const cid = o.categoryId;
  if (cid != null && cid !== '' && cid !== 0 && cid !== '0') params.categoryId = cid;

  const body = await http.request({ path: '/user/api/index/commodity', method: 'GET', data: params, raw: true });
  const rows = Array.isArray(body.data) ? body.data : [];
  const total = toNum(body.total, rows.length);
  return {
    list: rows.map(normalizeCommodity),
    total: total,
    page: page,
    hasMore: limit > 0 && page * limit < total
  };
}

/**
 * 按分类取商品：父分类会自动合并所有子分类的结果。
 * faka 的 commodity 接口只按单个 category_id 精确匹配，不递归子类，
 * 所以点父分类时如果只传父 id 往往拿到空列表，这里做一次并发合并。
 */
async function getCommoditiesByCategory(categoryId, opts) {
  const o = opts || {};
  if (!categoryId) return getCommodities(o);

  const all = o.flat || [];
  const node = all.filter(function (c) {
    return String(c.id) === String(categoryId);
  })[0];
  if (!node) return getCommodities(Object.assign({}, o, { categoryId: categoryId }));

  // 收集自身 + 所有后代
  const ids = [];
  (function walk(id) {
    ids.push(id);
    all.forEach(function (c) {
      if (String(c.parentId) === String(id)) walk(c.id);
    });
  })(node.id);

  if (ids.length === 1) return getCommodities(Object.assign({}, o, { categoryId: ids[0] }));

  const results = await Promise.all(
    ids.map(function (id) {
      return getCommodities(Object.assign({}, o, { categoryId: id, page: 1, limit: 0 })).catch(function () {
        return { list: [] };
      });
    })
  );

  const seen = {};
  const merged = [];
  results.forEach(function (r) {
    r.list.forEach(function (g) {
      if (seen[g.id]) return;
      seen[g.id] = 1;
      merged.push(g);
    });
  });

  const page = Math.max(1, toNum(o.page, 1));
  const limit = toNum(o.limit, config.pageSize) || merged.length;
  const start = (page - 1) * limit;
  return {
    list: merged.slice(start, start + limit),
    total: merged.length,
    page: page,
    hasMore: page * limit < merged.length
  };
}

/** 商品详情 */
async function getCommodityDetail(commodityId) {
  const data = await http.get('/user/api/index/commodityDetail', { commodityId: commodityId });
  return normalizeDetail(data || {});
}

/** 可用支付通道 */
async function getPayChannels(itemId) {
  const rows = await http.get('/user/api/index/pay', itemId ? { itemId: itemId } : {});
  return (Array.isArray(rows) ? rows : []).map(function (p) {
    return {
      id: toNum(p.id, 0),
      name: String(p.name || ''),
      icon: absUrl(p.icon),
      handle: String(p.handle || '').toLowerCase()
    };
  });
}

/* ------------------------------------------------------------------ */
/* 价格与库存                                                          */
/* ------------------------------------------------------------------ */
/** 实时价格：改数量/规格都要重新算，不要在前端自己加价 */
async function valuate(payload) {
  const data = await http.post('/user/api/index/valuation', payload);
  const price = toNum(data && data.price, 0);
  return { price: price, priceText: money(price) };
}

/** 实时库存 */
async function getStock(payload) {
  const data = await http.post('/user/api/index/stock', payload);
  return {
    stock: toNum(data && data.stock, 0),
    stockState: toNum(data && data.stock_state, 0),
    stockText: typeof (data && data.stock) === 'string' ? data.stock : ''
  };
}

/* ------------------------------------------------------------------ */
/* 下单 / 查单 / 卡密                                                  */
/* ------------------------------------------------------------------ */
/**
 * 提交订单
 * @param {object} payload { item_id, num, contact, pay_id, race?, sku?, password?, coupon?, captcha?, request_no? }
 * @returns {{tradeNo:string, amount:number, url:string, secret:string, leaveMessage:string, paid:boolean}}
 */
async function trade(payload) {
  const data = (await http.post('/user/api/order/trade', payload)) || {};
  const amount = toNum(data.amount, 0);
  const secret = String(data.secret || '');
  return {
    tradeNo: String(data.tradeNo || data.trade_no || ''),
    amount: amount,
    amountText: money(amount),
    url: String(data.url || ''),
    secret: secret,
    leaveMessage: String(data.leave_message || ''),
    // 0 元单或余额支付会直接发货，没有收银台
    paid: !!secret || (amount <= 0 && !data.url)
  };
}

/** 订单状态：status=1 表示已支付 */
async function getOrderState(tradeNo) {
  const data = (await http.post('/user/api/order/state', { tradeNo: tradeNo })) || {};
  return {
    tradeNo: String(data.trade_no || tradeNo),
    status: toNum(data.status, 0),
    paid: toNum(data.status, 0) === 1,
    amount: toNum(data.amount, 0),
    amountText: money(data.amount)
  };
}

/** 按手机号或完整订单号查单（换设备找回） */
async function queryOrders(keywords, page) {
  const body = await http.request({
    path: '/user/api/index/query',
    method: 'POST',
    data: { keywords: keywords, page: page || 1, limit: 20 },
    raw: true
  });
  const payload = body.data || {};
  const rows = Array.isArray(payload.list) ? payload.list : [];
  return {
    list: rows.map(function (o) {
      return {
        tradeNo: String(o.trade_no || ''),
        amount: toNum(o.amount, 0),
        amountText: money(o.amount),
        status: toNum(o.status, 0),
        paid: toNum(o.status, 0) === 1,
        deliveryStatus: toNum(o.delivery_status, 0),
        createTime: String(o.create_time || ''),
        payTime: String(o.pay_time || ''),
        contact: String(o.contact || ''),
        name: o.commodity && o.commodity.name ? String(o.commodity.name) : '',
        cover: absUrl((o.commodity && o.commodity.cover) || ''),
        commodityId: toNum(o.commodity_id, 0),
        hasPassword: !!o.password,
        race: String(o.race || ''),
        sku: o.sku || null
      };
    }),
    total: toNum(payload.total, rows.length)
  };
}

/** 取卡密；订单设置了查单密码时需要传 password */
async function getSecret(tradeNo, password) {
  const data = (await http.post('/user/api/index/secret', { tradeNo: tradeNo, password: password || '' })) || {};
  return {
    secret: String(data.secret || ''),
    leaveMessage: String(data.leave_message || ''),
    widget: data.widget || null
  };
}

/* ------------------------------------------------------------------ */
/* 微信静默登录（后端补丁：app/Controller/User/Api/Wx.php）             */
/* ------------------------------------------------------------------ */
/**
 * @param {string} code wx.login 拿到的 code
 * @returns {{user:Object|null, openid:string}}
 */
async function wxLogin(code) {
  const data = (await http.post('/user/api/wx/login', { code: code })) || {};
  return { user: data.user || null, openid: String(data.openid || '') };
}

/** 绑定手机号（登录后写入 faka 用户资料，用于换设备找回订单） */
async function wxBindPhone(phone) {
  return http.post('/user/api/wx/bindPhone', { phone: phone });
}

/** 虚拟支付签名（payChannel 为 vpay 时使用） */
async function vpaySign(payload) {
  return http.post('/user/api/wx/vpaySign', payload);
}

/* ------------------------------------------------------------------ */
/* 图形验证码                                                          */
/* ------------------------------------------------------------------ */
/**
 * 取交易验证码图片
 *
 * 关键点：faka 的验证码与当前会话绑定（存在 Cookie 里）。如果用 <image src> 直接加载，
 * 图片请求不会带上我们维护的 Cookie，验证必然失败。所以用 wx.request 下载成
 * arraybuffer 再转 base64，保证与下单请求共用同一个会话。
 *
 * @returns {Promise<string>} data:image/png;base64,...
 */
function getCaptcha(action) {
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  const cookie = http.readCookie();
  const act = action || 'trade';

  return new Promise(function (resolve, reject) {
    wx.request({
      url: base + '/user/captcha/image?action=' + act + '&_t=' + Date.now(),
      method: 'GET',
      responseType: 'arraybuffer',
      header: cookie ? { Cookie: cookie } : {},
      success: function (res) {
        http.absorbSetCookie(res.header);
        if (res.statusCode !== 200 || !res.data) {
          reject(http.makeError('验证码获取失败', res.statusCode || -1));
          return;
        }
        try {
          const b64 = wx.arrayBufferToBase64(res.data);
          resolve('data:image/png;base64,' + b64);
        } catch (e) {
          reject(http.makeError('验证码解析失败', -1));
        }
      },
      fail: function () {
        reject(http.makeError('验证码获取失败，请检查网络', -2));
      }
    });
  });
}

module.exports = {
  getCategories,
  getCommodities,
  getCommoditiesByCategory,
  getCommodityDetail,
  getPayChannels,
  valuate,
  getStock,
  trade,
  getOrderState,
  queryOrders,
  getSecret,
  wxLogin,
  wxBindPhone,
  vpaySign,
  getCaptcha,
  absUrl,
  money,
  toNum,
  normalizeCommodity,
  normalizeDetail
};
