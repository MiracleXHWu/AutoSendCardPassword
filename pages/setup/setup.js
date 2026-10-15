// pages/setup/setup.js —— 云环境自检与配置指引
const cloud = require('../../utils/cloud.js');
const vpay = require('../../utils/vpay.js');
const format = require('../../utils/format.js');

const MIN_LIB = '2.2.3';

Page({
  data: {
    checking: true,
    overall: 'checking', // ok | fail
    overallTitle: '',
    overallDesc: '',
    checks: [],
    steps: cloud.GUIDE_STEPS,
    diag: '',
    appId: '',
    env: '',
    dataReady: false, // 数据集合是否已初始化（决定初始化按钮的文案）
    initBusy: false, // 正在执行 initdb
    // 商品配置体检
    goods: [], // [{ productId, title, priceText, ok, problems }]
    goodsSummary: '',
    goodsEnvMissing: '',
    fixableDemo: 0, // 可以一键修复的示例商品数量
    fixBusy: false,
    goodsSource: '' // server（云函数代读）| client（客户端直连）
  },

  onLoad() {
    this.run();
  },

  onPullDownRefresh() {
    this.run().then(() => wx.stopPullDownRefresh());
  },

  /** 重跑全部检查 */
  async run() {
    this.setData({ checking: true });

    // 重新初始化，确保读到 config.js 的最新值（改完配置无需重启工具）
    const st = cloud.init();
    cloud.resetWarn();

    const checks = [];
    const appId = st.appId;
    const tourist = !appId || appId === 'touristappid';

    /* ---- ① 基础库是否支持云开发 ---- */
    const libOk = !!wx.cloud && vpay.compareVersion(st.libVersion || '0.0.0', MIN_LIB) >= 0;
    checks.push({
      key: 'lib',
      name: '调试基础库支持云开发',
      state: libOk ? 'ok' : 'fail',
      detail: libOk
        ? `当前基础库 ${st.libVersion || '未知'}，满足要求（≥ ${MIN_LIB}）`
        : `当前基础库 ${st.libVersion || '过低'}，请在「详情 → 本地设置」调到 ${MIN_LIB} 以上`
    });

    /* ---- ② AppID 是否为游客号 ---- */
    checks.push({
      key: 'appid',
      name: '小程序 AppID 有效',
      state: tourist ? 'fail' : 'ok',
      detail: tourist
        ? '当前仍是 touristappid（游客号），云开发在游客模式下完全不可用，必须替换成你自己的 AppID'
        : `当前 AppID：${appId}`
    });

    /* ---- ③ 云环境是否可访问 / ⑤ 商品数据是否可读 ---- */
    // 用 fetchGoodsList 而不是裸查 goods：
    // 它会自动在「客户端直连」与「云函数管理端代读」之间切换，因此既能判断
    // 环境通不通，也能精确区分「数据库确实是空的」和「有数据但被集合读权限挡住」。
    let envOk = false;
    let envState = 'fail';
    let dataOk = false;
    let envDetail = '';
    let dataDetail = '';
    let goodsList = [];
    let serverFallback = false;

    try {
      const res = await vpay.fetchGoodsList();
      goodsList = res.list || [];
      serverFallback = !!res.serverFallback;
      envOk = true;
      envState = 'ok';
      envDetail = `环境可访问${st.env ? '（env = ' + st.env + '）' : '（使用默认环境）'}`;

      const n = res.list.length;
      dataOk = n > 0;
      if (n === 0) {
        if (res.serverFallback) {
          dataDetail =
            '集合能读到，但里面没有已上架的商品。点下方「一键初始化数据库」写入 2 个示例商品，或自行往 goods 集合添加记录。';
        } else {
          dataDetail =
            '客户端直连读不到商品，云函数代读也没走通' +
            (res.serverReason ? '（' + res.serverReason + '）' : '') +
            '。最常见原因是云端的 vpay 还是旧版本：右键 cloudfunctions/vpay →「上传并部署：云端安装依赖」重新部署即可。';
        }
      } else if (res.needFixPermission) {
        dataDetail =
          `已读到 ${n} 个商品（由云函数管理端代读）。原因是 goods 集合读权限仍是「仅创建者可读写」，` +
          '小程序端直连读不到、也不报错。建议到「数据库 → goods → 权限设置」改为「所有用户可读，仅管理端可写」；不配也能用，只是每次多一次云函数调用。';
      } else {
        dataDetail = `已读到 ${n} 个商品，首页可正常展示。`;
      }
    } catch (e) {
      const msg = cloud.rawMsg(e);
      const friendly = cloud.friendly(e);

      if (cloud.isEnvError(e)) {
        envDetail = '环境不可访问：' + friendly;
        dataDetail = '环境不可用，已跳过';
      } else if (/invalid scope/i.test(msg)) {
        // 官方说明：AppID 首次开通云环境后约 10 分钟，云 API 才可正常调用
        envState = 'warn';
        envDetail = friendly;
        dataDetail = '等环境初始化完成后再看这一项';
      } else if (/not\s*exist|集合不存在|尚未初始化|COLLECTION|initdb/i.test(msg + ' ' + friendly)) {
        envOk = true;
        envState = 'ok';
        dataOk = false;
        envDetail = '环境可访问，但数据集合尚未创建';
        dataDetail = 'goods 集合不存在，请点下方「一键初始化数据库」（等价于运行一次 initdb 云函数）';
      } else {
        envDetail = friendly;
        dataDetail = '环境不可用，已跳过';
      }
    }

    // 环境恢复后解除熔断，页面无需重启即可继续用
    if (envOk) cloud.clearBlocked();

    checks.push({
      key: 'env',
      name: '云开发环境可访问',
      state: envState,
      detail: envDetail
    });

    /* ---- ④ 云函数是否已部署 ---- */
    let fnOk = false;
    let fnDetail = '';
    if (!envOk) {
      fnDetail = '环境不可用，已跳过';
    } else {
      try {
        const r = await wx.cloud.callFunction({ name: 'vpay', data: { action: 'ping' } });
        const res = (r && r.result) || {};
        fnOk = res.ok === true;
        // 云函数「启动失败」会带 hint，一并展示，用户才知道怎么修
        fnDetail = fnOk
          ? 'vpay 云函数已部署且运行正常'
          : [res.msg || '云函数返回异常', res.hint].filter(Boolean).join('；');
      } catch (e) {
        const msg = cloud.rawMsg(e);
        fnOk = false;
        fnDetail = /not\s*found|FUNCTION_NOT_FOUND|函数不存在/i.test(msg)
          ? 'vpay 云函数尚未部署，请右键 cloudfunctions/vpay 选择「上传并部署：云端安装依赖」'
          : /-504002|FUNCTIONS_EXECUTE_FAIL|code exit unexpected/i.test(msg)
            ? 'vpay 云函数启动失败（-504002 / 145）：通常是依赖未安装或运行时不兼容。请用「上传并部署：云端安装依赖」重新部署，必要时把运行时改为 Nodejs16.13'
            : msg || '云函数调用失败';
      }
    }
    checks.push({
      key: 'fn',
      name: '云函数已部署',
      state: fnOk ? 'ok' : 'fail',
      detail: fnDetail
    });

    /* ---- ⑤ 商品数据可读 ---- */
    checks.push({
      key: 'data',
      name: '商品数据可读',
      state: dataOk ? 'ok' : 'fail',
      detail: dataDetail
    });

    /* ---- ⑥ 商品价格配置 ---- */
    // price 缺失或类型不对，商品页会显示「¥NaN」并卡在下单；这里提前报出来。
    const goodsReport = await this.inspectGoods(goodsList, serverFallback);

    checks.push({
      key: 'price',
      name: '商品价格配置正确',
      state: goodsReport.priceState,
      detail: goodsReport.priceDetail
    });

    checks.push({
      key: 'vpayenv',
      name: '虚拟支付环境变量已配置',
      state: goodsReport.envState,
      detail: goodsReport.envDetail
    });

    /* ---- 汇总 ---- */
    const errCount = checks.filter((c) => c.state === 'fail').length;
    const warnCount = checks.filter((c) => c.state === 'warn').length;
    const allOk = errCount === 0 && warnCount === 0;

    this.setData({
      checking: false,
      checks,
      overall: allOk ? 'ok' : errCount ? 'fail' : 'warn',
      overallTitle: allOk
        ? '配置完成，可以开始使用了'
        : errCount
          ? '还差 ' + errCount + ' 项配置'
          : '环境正在初始化，稍等片刻',
      overallDesc: allOk
        ? '云环境、云函数与数据集合均已就绪。返回首页即可看到商品列表。'
        : errCount
          ? '请按下方指引完成配置。每完成一步就回到本页点「重新自检」，逐项变绿即可。'
          : '云环境刚创建，微信侧约需 10 分钟完成初始化。等待后点「重新自检」即可，期间不需要改任何代码。',
      diag: cloud.diagnostic(),
      appId,
      env: st.env,
      dataReady: dataOk
    });
  },

  /**
   * 商品配置体检。
   *
   * 为什么值得单独做一项：price 一旦缺失或类型不对，商品页就会渲染成「¥NaN」，
   * 而且**不会报错**——只有点到下单才会失败。这个检查把问题提前摆到自检页上。
   *
   * 数据来源分两级：
   *   ① 优先调 vpay 的 diagnoseGoods（能连 enabled=false 的商品与环境变量一起看）；
   *   ② 云端 vpay 尚未更新到该版本时，降级为本地体检（只检查已上架商品的价格）。
   */
  async inspectGoods(goodsList, serverFallback) {
    let diag = null;
    try {
      diag = await vpay.diagnoseGoods();
    } catch (e) {
      // 旧版 vpay 会返回「不支持的操作：diagnoseGoods」，此处降级，不影响其它检查
      console.warn('[setup] 商品体检接口不可用，降级为本地体检：', e.message);
    }

    const rows = [];
    const priceBad = [];
    let fixable = 0;
    let envMissingText = ''; // 本地变量：data 里的 goodsEnvMissing 只用于渲染，不能当变量读

    if (diag && Array.isArray(diag.records)) {
      envMissingText = diag.envMissing && diag.envMissing.length ? diag.envMissing.join('、') : '';
      for (const r of diag.records) {
        // 云函数已把 price 归一化过；归一化失败时用原始值生成原因文案
        const p = format.priceOf(r.price == null ? r.priceRaw : r.price);
        if (!p.valid) priceBad.push(r.productId);
        if (['goods_001', 'goods_002'].indexOf(r.productId) !== -1 && !p.valid) fixable++;
        rows.push({
          productId: r.productId,
          title: r.title,
          priceText: p.valid ? '¥' + p.text : '¥—',
          ok: !!r.sellable,
          problems: r.problems || [],
          problemsText: (r.problems || []).map((t) => '· ' + t).join('\n'),
          // 价格有问题时把记录里真实的字段名列出来：
          // 能立刻区分「字段名写成了别的」和「根本没填 price」这两种情况
          fieldsText:
            !p.valid && r.fields && r.fields.length ? '本记录实际字段：' + r.fields.join('、') : ''
        });
      }

      this.setData({
        goods: rows,
        goodsSource: 'server',
        goodsSummary: `共 ${diag.total} 条商品记录，${diag.sellable} 条可正常售卖。`,
        goodsEnvMissing: envMissingText,
        fixableDemo: fixable
      });
    } else {
      for (const g of goodsList) {
        const p = format.priceOf(g.price);
        const problems = [];
        if (!p.valid) {
          priceBad.push(g.productId);
          problems.push('price 不合法：' + p.reason);
        }
        // 客户端直连时拿到的是原始记录（link 字段在），云函数代读时是 hasLink 布尔值
        const hasLink = g.link !== undefined ? !!(g.link || '').trim() : g.hasLink !== false;
        if (g.deliveryMode !== 'pool' && !hasLink) {
          problems.push('发货方式为 static，但 link 为空，付款后没有内容可发');
        }
        if (['goods_001', 'goods_002'].indexOf(g.productId) !== -1 && !p.valid) fixable++;

        rows.push({
          productId: g.productId,
          title: g.title || '',
          priceText: p.valid ? '¥' + p.text : '¥—',
          ok: problems.length === 0,
          problems,
          problemsText: problems.map((t) => '· ' + t).join('\n')
        });
      }

      this.setData({
        goods: rows,
        goodsSource: 'client',
        goodsSummary: goodsList.length
          ? `共检查 ${rows.length} 条已上架商品（本地体检，仅覆盖价格与链接）。`
          : '暂无可检查的商品。',
        goodsEnvMissing: '',
        fixableDemo: fixable
      });
    }

    /* ---- 价格检查结论 ---- */
    let priceState = 'ok';
    let priceDetail = '全部商品价格合法（单位：分，990 = 9.90 元）。';
    if (!rows.length) {
      priceState = 'warn';
      priceDetail = '没有可检查的商品。先点下方「一键初始化数据库」，或往 goods 集合添加商品。';
    } else if (priceBad.length) {
      priceState = 'fail';
      priceDetail =
        '有 ' +
        priceBad.length +
        ' 个商品的 price 不合法：' +
        priceBad.join('、') +
        '。这会让商品页显示「¥—」且无法下单（避免按错误金额扣款）。' +
        '到「数据库 → goods」把 price 改成数字类型的整数分（9.90 元填 990）；若为示例商品，可点下方「修复示例商品价格」。';
    }

    /* ---- 环境变量检查结论 ---- */
    let envState = 'ok';
    let envDetail = 'MP_APPID / MP_APP_SECRET / OFFER_ID / APP_KEY 均已配置，可以正常下单。';
    if (!diag) {
      envState = 'warn';
      envDetail =
        '无法自动确认：云端 vpay 还是旧版本，没有商品体检接口。右键 cloudfunctions/vpay →「上传并部署：云端安装依赖」后即可自动检查。' +
        '（若点「立即购买」提示「云函数环境变量未配置完整」，就是这一项没配：控制台 → 云函数 → vpay → 配置 → 环境变量。）';
    } else if (envMissingText) {
      envState = 'fail';
      envDetail =
        '缺少环境变量：' +
        envMissingText +
        '。云开发控制台 →「云函数」→ vpay →「配置」→「环境变量」补齐后立即生效，无需重新部署。' +
        'OFFER_ID / APP_KEY 在 MP 后台「虚拟支付」页面获取；MP_APPID / MP_APP_SECRET 在「开发管理 → 开发设置」获取。';
    }

    return { priceState, priceDetail, envState, envDetail };
  },

  /**
   * 一键修复示例商品价格。
   * 只修 initdb 写入的 goods_001 / goods_002 —— 自建商品的价格必须由用户确认，不猜。
   */
  async onFixDemoGoods() {
    if (this.data.fixBusy) return;

    const yes = await new Promise((resolve) => {
      wx.showModal({
        title: '修复示例商品价格',
        content:
          '将把 goods_001 还原为 990 分（9.90 元）、goods_002 还原为 500 分（5.00 元）。\n\n只会修改这两个示例商品，你自己新增的商品不会被改动。',
        confirmText: '开始修复',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!yes) return;

    this.setData({ fixBusy: true });
    wx.showLoading({ title: '修复中…', mask: true });

    let title = '修复完成';
    let content = '';
    try {
      const lines = await vpay.fixDemoGoods();
      content = (Array.isArray(lines) ? lines : [String(lines)]).join('\n');
    } catch (e) {
      title = '修复失败';
      content = e.message || '调用失败，请稍后重试。';
    }

    wx.hideLoading();
    this.setData({ fixBusy: false });

    await new Promise((resolve) => {
      wx.showModal({
        title,
        content: String(content).slice(0, 600) || '已执行完成。',
        showCancel: false,
        success: () => resolve(),
        fail: () => resolve()
      });
    });

    this.run();
  },

  /**
   * 一键初始化数据库：直接调用 initdb 云函数
   * 好处是不必去云开发控制台里翻「云端测试」——那里叫法不同、还要求函数已部署。
   */
  async onInitDb() {
    if (this.data.initBusy) return;

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '初始化数据库',
        content:
          '将创建全部集合，并在数据为空时写入 2 个示例商品与 5 条示例卡密。已存在的数据不会被覆盖或删除，可以放心重复执行。',
        confirmText: '开始初始化',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!ok) return;

    this.setData({ initBusy: true });
    wx.showLoading({ title: '初始化中…', mask: true });

    let title = '初始化完成';
    let content = '';
    try {
      const r = await wx.cloud.callFunction({ name: 'initdb', data: {} });
      const res = (r && r.result) || {};
      const lines = Array.isArray(res)
        ? res
        : [res.msg || '已执行完成', res.hint].filter(Boolean);
      content = lines.join('\n') || '已执行完成，请到「数据库」确认集合已创建。';
    } catch (e) {
      title = '初始化失败';
      const msg = cloud.rawMsg(e);
      if (/not\s*found|FUNCTION_NOT_FOUND|函数不存在/i.test(msg)) {
        content =
          'initdb 云函数尚未部署。请在开发者工具左侧文件树里右键 cloudfunctions/initdb →「上传并部署：云端安装依赖」，部署完成后回到本页再点一次。\n\n注意：要右键 initdb 这个子目录，不要右键 cloudfunctions 根目录。';
      } else if (/-504002|FUNCTIONS_EXECUTE_FAIL|code exit unexpected|145/i.test(msg)) {
        content =
          'initdb 云函数启动失败（-504002 / 145）：通常是依赖未安装或运行时不兼容。请用「上传并部署：云端安装依赖」重新部署；仍失败则到控制台把该函数运行时改为 Nodejs16.13。';
      } else {
        content = msg || '调用失败，请稍后重试。';
      }
    }

    wx.hideLoading();
    this.setData({ initBusy: false });

    await new Promise((resolve) => {
      wx.showModal({
        title,
        content: String(content).slice(0, 600),
        showCancel: false,
        success: () => resolve(),
        fail: () => resolve()
      });
    });

    // 无论成功失败都重跑一次自检，把最新状态刷出来
    this.run();
  },

  onRetry() {
    this.run();
  },

  onCopy() {
    cloud.copyDiagnostic();
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
