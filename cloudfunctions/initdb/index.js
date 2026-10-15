/**
 * initdb —— 一次性初始化云数据库（部署后在开发者工具里点「云端测试」执行）
 * 创建集合 + 写入示例商品 + 示例卡密
 */
/* ------------------------------------------------------------------
 * ⚠️ 模块加载期没有上层 try/catch 保护，这里抛错 = 进程直接退出，
 *    「云端测试」里只会看到 -504002 functions execute fail | 145 code exit unexpected。
 *    因此把「依赖加载 + init + 取 db」全部纳入保护，失败时改为返回可读错误。
 * ------------------------------------------------------------------ */
let cloud = null;
let BOOT_ERROR = '';
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (e) {
  BOOT_ERROR = (e && e.message) || String(e);
}

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
      '常见原因：① 依赖未安装 —— 右键 cloudfunctions/initdb 选「上传并部署：云端安装依赖」重新部署；' +
      '② 云函数运行时版本过低 —— 在云开发控制台把运行时改为 Nodejs16.13。'
  };
}

// qr_alias：qrcode 云函数在 scene 超长/含中文时的短哈希别名映射表。
// ⚠️ 必须在这里一并创建——SDK 不会在写入时自动建集合，
//    漏了它会让「商品码带中文名」这条兜底路径直接写库失败（-502005）。
const COLLECTIONS = ['goods', 'cards', 'xpay_orders', 'xpay_complaints', 'sys_cache', 'qr_alias'];

// 示例商品的权威价格（单位：分）。仅用于修复被手工改动过的那两条示例记录，
// **绝不**对用户自建商品生效——猜价格等于收错钱。
const DEMO_PRICES = { goods_001: 990, goods_002: 500 };

/** 归一化为「整数分」，不合法返回 null（判定标准与 vpay / 前端 format.js 一致） */
function toFen(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : null;
  }
  return null;
}

function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return '缺失';
  return typeof v;
}

/**
 * 修复示例商品的价格字段。
 *
 * 为什么会需要它：goods 记录常常被手工在控制台改过，price 容易漏填或存成文本，
 * 前端就会显示「¥NaN」，下单时云函数才报错。这里只处理 initdb 自己写的那两个
 * productId，把它们还原成 DEMO_PRICES 里的值——用户自建商品一律不碰。
 */
async function fixDemoGoods() {
  const log = [];
  const ids = Object.keys(DEMO_PRICES);

  for (const productId of ids) {
    const res = await db.collection('goods').where({ productId }).limit(1).get();
    const g = (res.data || [])[0];
    if (!g) {
      log.push(`ℹ️ ${productId}：不存在，跳过（示例商品可能被删除过）`);
      continue;
    }
    if (toFen(g.price) !== null) {
      log.push(`ℹ️ ${productId}：price = ${g.price} 已合法，无需修改`);
      continue;
    }
    await db.collection('goods').doc(g._id).update({ data: { price: DEMO_PRICES[productId] } });
    log.push(
      `✅ ${productId}：price 由 ${typeName(g.price)}（${g.price === undefined ? '空' : g.price}）` +
        `修正为 ${DEMO_PRICES[productId]} 分（${(DEMO_PRICES[productId] / 100).toFixed(2)} 元）`
    );
  }

  log.push('');
  log.push('说明：只修复 initdb 写入的示例商品（goods_001 / goods_002）。');
  log.push('你自己新增的商品不会被改动——价格算错会导致收错钱，必须由你显式确认。');

  return log;
}

exports.main = async (event = {}) => {
  // 启动期失败时给出可读原因，避免只看到 145
  if (BOOT_ERROR) return bootFailure();

  if (event && event.action === 'fixDemoGoods') {
    try {
      return await fixDemoGoods();
    } catch (e) {
      return ['修复失败：' + ((e && e.message) || String(e))];
    }
  }

  const log = [];

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      log.push(`✅ 创建集合 ${name}`);
    } catch (e) {
      log.push(`ℹ️ 集合 ${name} 已存在（${e.errMsg || e.message}）`);
    }
  }

  // 示例商品：deliveryMode = static（所有买家发同一份链接）
  const goodsCount = await db.collection('goods').count();
  if (goodsCount.total === 0) {
    await db.collection('goods').add({
      data: {
        productId: 'goods_001', // 必须与 MP 后台「虚拟支付 → 道具管理」里的道具 ID 一致
        title: '示例资料包',
        desc: '付款后自动发送网盘链接与提取码',
        price: 990, // 单位：分 = 9.90 元
        sort: 1,
        enabled: true,
        deliveryMode: 'static',
        link: 'https://pan.example.com/s/abcdefg',
        pwd: 'a1b2',
        tips: '请及时转存，链接失效可联系客服补发。',
        templateId: '' // 填订阅消息模板 ID 可额外推送提醒（可选）
      }
    });
    log.push('✅ 写入示例商品 goods_001（static 模式）');

    // 第二个示例商品：deliveryMode = pool（一人一份，从卡密池分配）
    await db.collection('goods').add({
      data: {
        productId: 'goods_002',
        title: '示例兑换码（一人一码）',
        icon: '🎟️',
        desc: '每笔订单从卡密池分配一条未被使用过的兑换码',
        price: 500,
        sort: 2,
        enabled: true,
        deliveryMode: 'pool',
        tips: '兑换码只能使用一次，请勿外传。',
        notice: '兑换码一经分配即刻锁定，不支持退换，请确认后再购买。',
        templateId: ''
      }
    });
    log.push('✅ 写入示例商品 goods_002（pool 模式）');
  } else {
    log.push('ℹ️ goods 集合已有数据，跳过示例商品');
  }

  // 示例卡密池（deliveryMode = pool 时使用，一人一份、发完即止）
  const cardCount = await db.collection('cards').count();
  if (cardCount.total === 0) {
    const batch = [];
    for (let i = 1; i <= 5; i++) {
      batch.push(
        db.collection('cards').add({
          data: {
            productId: 'goods_002',
            seq: i,
            raw: `兑换码-DEMO-${String(i).padStart(4, '0')}`,
            link: '',
            pwd: '',
            used: false,
            orderNo: '',
            openid: '',
            createdAt: new Date()
          }
        })
      );
    }
    await Promise.all(batch);
    log.push('✅ 写入 5 条示例卡密（productId = goods_002，pool 模式）');
  } else {
    log.push('ℹ️ cards 集合已有数据，跳过示例卡密');
  }

  log.push('');
  log.push('—— 结果核对（共 ' + COLLECTIONS.length + ' 个集合）——');
  for (const name of COLLECTIONS) {
    try {
      const c = await db.collection(name).count();
      log.push(`   ${name}：${c.total} 条`);
    } catch (e) {
      log.push(`   ${name}：读取失败（${e.errMsg || e.message}）`);
    }
  }

  // 商品配置体检：价格是「分」且必须是整数，写错了前端会显示「¥NaN」，
  // 而且只有走到下单才会暴露。在这里当场打印，免得后面再回头查。
  log.push('');
  log.push('—— 商品配置体检 ——');
  try {
    const gs = await db.collection('goods').orderBy('sort', 'asc').limit(50).get();
    const bad = [];
    for (const g of gs.data || []) {
      const priceOk = toFen(g.price) !== null;
      log.push(
        `   ${g.productId || '(缺 productId)'}｜price ${priceOk ? '✅' : '❌'} = ${
          g.price === undefined ? '缺失' : g.price
        }（${typeName(g.price)}）｜enabled ${g.enabled !== false ? 'true' : 'false'}｜${
          g.deliveryMode === 'pool' ? 'pool（卡密池）' : 'static（固定链接）'
        }`
      );
      if (!priceOk) bad.push(g.productId || '(缺 productId)');
    }
    if (!bad.length) {
      log.push('   全部商品价格合法，无需处理。');
    } else {
      log.push('');
      log.push(`   ⚠️ 有 ${bad.length} 个商品价格不合法：${bad.join('、')}`);
      log.push('   这会导致商品页显示「¥NaN」且无法下单。修法二选一：');
      log.push('     ① 若为示例商品：在「环境自检」页点「修复示例商品价格」（等价于调用本函数并传 {"action":"fixDemoGoods"}）；');
      log.push('     ② 自己建的商品：到「数据库 → goods」把该记录的 price 改为数字类型的整数分（如 990），不要用文本、不要带小数。');
    }
  } catch (e) {
    log.push('   读取失败（' + (e.errMsg || e.message) + '）');
  }

  log.push('');
  log.push('下一步：在云开发控制台「数据库 → 权限设置」中，把 goods 设为「所有用户可读，仅管理端可写」，');
  log.push('其余集合（cards / xpay_orders / sys_cache / xpay_complaints / qr_alias）保持「仅管理端可读写」。');
  log.push('');
  log.push('看到 goods = 2 条、cards = 5 条，即初始化成功。');

  return log;
};
