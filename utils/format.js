/**
 * utils/format.js —— 展示层数值归一化
 *
 * 为什么需要单独一层：
 *   goods.price 的单位是「分」，页面普遍写成 (price / 100).toFixed(2)。
 *   一旦 price 缺失、是 null、或是控制台手工录入的文本，除法的结果就是 NaN，
 *   页面上直接显示「¥NaN」——既看不出原因，也不会报错，排查成本很高。
 *
 *   这里统一做两件事：
 *     ① 归一化：把「看起来像整数分的值」转成 number，其余一律判为无效；
 *     ② 说明原因：无效时给出人话原因（字段缺失 / 类型不对 / 值不合法），
 *        页面据此把「¥NaN」换成「价格未配置」并阻断下单，而不是先收钱再出错。
 *
 * ⚠️ 单笔金额一旦展示错误，用户就会按错误的价格付款，所以这里的原则是
 *    **宁可不显示，也不猜**：无法确定价格时返回 valid=false，绝不用兜底数字糊过去。
 */

/** 类型描述，用于给用户/开发者看清数据库里到底存了什么 */
function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return '缺失';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 把任意值归一化为「整数分」
 * @returns {number|null} 合法时返回正整数（分），否则 null
 */
function toFen(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
    // 必须是整数：分没有小数。9.9 只会是「误把元当分填了」或数据被改动过
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    // 容忍控制台手工录入时存成文本的情况："990" 与 990 等价，可以安全地当作同一个值
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    return null;
  }
  return null;
}

/** 分 → 展示用元字符串（两位小数） */
function fenToYuan(fen) {
  const n = toFen(fen);
  return n === null ? '' : (n / 100).toFixed(2);
}

/**
 * 价格展示状态（页面直接用这个）
 * @returns {{valid:boolean, fen:number|null, text:string, reason:string, raw:any, rawType:string}}
 *   valid   价格可用
 *   text    有效时是 "9.90"；无效时是 "—"（页面显示为「¥—」）
 *   reason  无效原因（人话），有效时为空串
 */
function priceOf(v) {
  const fen = toFen(v);
  const rawType = typeName(v);

  if (fen !== null) {
    return { valid: true, fen, text: fenToYuan(fen), reason: '', raw: v, rawType };
  }

  let reason;
  if (v === null || v === undefined) {
    reason = '商品记录里没有 price 字段（价格缺失）';
  } else if (typeof v === 'number' && !isFinite(v)) {
    // NaN / Infinity：typeof 也是 'number'，必须先于小数分支判断，
    // 否则会给出「price 是小数（NaN）」这种自相矛盾的提示
    reason = 'price 的值是 ' + v + '，不是有效数字';
  } else if (typeof v === 'number' && !Number.isInteger(v)) {
    reason =
      'price 是小数（' +
      v +
      '）。单位必须是「整数分」——9.90 元应填 990，而不是 9.9';
  } else if (typeof v === 'number') {
    reason = 'price 必须大于 0（当前为 ' + v + '）';
  } else if (v === '') {
    reason = 'price 是空字符串';
  } else if (rawType === 'string') {
    reason = 'price 是文本「' + String(v) + '」，且不是纯数字';
  } else {
    reason = 'price 的类型是 ' + rawType + '，必须是数字';
  }

  return { valid: false, fen: null, text: '—', reason, raw: v, rawType };
}

/** 是否为可展示的商品记录（给列表页判断用） */
function isSellable(g) {
  return !!g && priceOf(g.price).valid;
}

module.exports = {
  toFen,
  fenToYuan,
  priceOf,
  isSellable,
  typeName
};
