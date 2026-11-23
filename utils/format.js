/**
 * utils/format.js —— 展示层格式化
 *
 * 与旧版的关键差别：acg-faka 返回的价格单位是「元」（decimal 10,2），
 * 不是「分」。所以这里不再做 /100，只做字符串规范化。
 * 金额一旦展示错，用户就会按错价付款，因此非法值统一显示「—」而不是猜一个数。
 */

/** 任意值 → 数字，失败返回 def */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def == null ? 0 : def;
}

/**
 * 金额展示：2 → "2"，1.5 → "1.50"，1.555 → "1.56"
 * 保留两位以内小数，去掉无意义的尾零，但 1.5 显示为 1.50 更符合价签习惯。
 */
function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

/** 金额（紧凑）：2.00 → "2"，1.50 → "1.5" */
function moneyShort(v) {
  const s = money(v);
  if (s === '—') return s;
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

/** 销量：1234 → "1.2k" */
function sold(n) {
  const v = num(n, 0);
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1) + 'k';
  return (v / 10000).toFixed(1) + 'w';
}

/** 解析 "2026-11-23 20:47:56" 这类后端时间串 */
function parseTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value).replace(/-/g, '/');
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 时间戳/时间串 → "11-23 20:47" */
function formatTime(value) {
  const t = parseTime(value);
  if (!t) return '';
  const d = new Date(t);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 时间戳/时间串 → "2026-11-23 20:47:56" */
function fullTime(value) {
  const t = parseTime(value);
  if (!t) return '';
  const d = new Date(t);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 11-20 */
function relativeTime(value) {
  const t = parseTime(value);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 0) return formatTime(t);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  return formatTime(t);
}

/** 倒计时：剩余毫秒 → "14:59" 或 "01:02:03" */
function countdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

/** 手机号脱敏：13812345678 → 138****5678 */
function maskPhone(phone) {
  const s = String(phone || '');
  return /^\d{11}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : s;
}

/** 联系方式类型（faka contact_type：0 任意 / 1 手机 / 2 邮箱 / 3 QQ） */
function contactLabel(type) {
  return { 0: '联系方式', 1: '手机号', 2: '邮箱', 3: 'QQ 号' }[num(type, 0)] || '联系方式';
}

function contactPlaceholder(type) {
  return { 0: '手机号 / 邮箱 / QQ，用于查单', 1: '请输入 11 位手机号', 2: '请输入邮箱地址', 3: '请输入 QQ 号' }[
    num(type, 0)
  ];
}

/**
 * 富文本处理：faka 的 description 是后台富文本编辑器产出的 HTML。
 * 小程序富文本组件不认 <style>，也会让宽图溢出，这里做两件事：
 *   1. 去掉 script/style/iframe 等危险或无效标签；
 *   2. 给 img 加 max-width，防止横向撑破页面。
 */
function richText(html) {
  let s = String(html || '');
  if (!s) return '';
  s = s.replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<img([^>]*)>/gi, function (m, attrs) {
    let a = attrs
      .replace(/\swidth\s*=\s*["']?[^"'>]*["']?/gi, '')
      .replace(/\sheight\s*=\s*["']?[^"'>]*["']?/gi, '');
    if (!/style=/i.test(a)) a += ' style="max-width:100%;height:auto;display:block;"';
    return '<img' + a + '>';
  });
  s = s.replace(/<table/gi, '<table style="max-width:100%;"');
  return s;
}

/** 纯文本摘要（列表里展示详情的前 60 字） */
function plainText(html, max) {
  const s = String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = max || 60;
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/** 订单状态文案 */
function orderStatusText(order) {
  if (!order) return '';
  if (order.paid) return '已支付';
  return '待支付';
}

module.exports = {
  num,
  money,
  moneyShort,
  sold,
  parseTime,
  formatTime,
  fullTime,
  relativeTime,
  countdown,
  maskPhone,
  contactLabel,
  contactPlaceholder,
  richText,
  plainText,
  orderStatusText
};
