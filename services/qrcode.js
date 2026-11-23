/**
 * 极简二维码编码器（QR Code Model 2）
 * ---------------------------------------------------------------
 * 为什么自己实现：
 *   支付页要把 faka 收银台链接展示成二维码，让用户长按识别后在微信内付款。
 *   小程序不能打开外部链接，也不能依赖第三方在线二维码服务（域名不可控），
 *   所以在本地生成。纯 JS、无依赖、只支持纠错等级 L/M 与版本 1-10
 *   （版本 10-M 可容纳 213 字节，收银台链接远小于这个长度）。
 *
 * 输出的矩阵可直接喂给 canvas 绘制，再由 wx.canvasToTempFilePath 转成图片，
 * 这样 <image show-menu-by-longpress> 才能被微信识别。
 */

/* ------------------------------------------------------------------ */
/* GF(256) 有限域                                                      */
/* ------------------------------------------------------------------ */
const EXP = new Array(512);
const LOG = new Array(256);

(function buildGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 ∏(x + α^i)，i = 0..ec-1，系数高位在前 */
function ecPoly(ec) {
  let poly = [1];
  for (let i = 0; i < ec; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ec) {
  const gen = ecPoly(ec);
  const res = data.concat(new Array(ec).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
  }
  return res.slice(data.length);
}

/* ------------------------------------------------------------------ */
/* 版本 / 纠错块表                                                     */
/* ------------------------------------------------------------------ */
/**
 * ecl: { ec: 每块纠错码字数, blocks: [[块数, 每块数据码字数], ...] }
 * 只保留 L 与 M 两级，够支付链接使用。
 */
const RS_TABLE = {
  1: {
    L: { ec: 7, blocks: [[1, 19]] },
    M: { ec: 10, blocks: [[1, 16]] }
  },
  2: {
    L: { ec: 10, blocks: [[1, 34]] },
    M: { ec: 16, blocks: [[1, 28]] }
  },
  3: {
    L: { ec: 15, blocks: [[1, 55]] },
    M: { ec: 26, blocks: [[1, 44]] }
  },
  4: {
    L: { ec: 20, blocks: [[1, 80]] },
    M: { ec: 18, blocks: [[2, 32]] }
  },
  5: {
    L: { ec: 26, blocks: [[1, 108]] },
    M: { ec: 24, blocks: [[2, 43]] }
  },
  6: {
    L: { ec: 18, blocks: [[2, 68]] },
    M: { ec: 16, blocks: [[4, 27]] }
  },
  7: {
    L: { ec: 20, blocks: [[2, 78]] },
    M: { ec: 18, blocks: [[4, 31]] }
  },
  8: {
    L: { ec: 24, blocks: [[2, 97]] },
    M: { ec: 22, blocks: [[2, 38], [2, 39]] }
  },
  9: {
    L: { ec: 30, blocks: [[2, 116]] },
    M: { ec: 22, blocks: [[3, 36], [2, 37]] }
  },
  10: {
    L: { ec: 18, blocks: [[2, 68], [2, 69]] },
    M: { ec: 26, blocks: [[4, 43], [1, 44]] }
  }
};

const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function blocksOf(version, ecl) {
  const spec = RS_TABLE[version] && RS_TABLE[version][ecl];
  if (!spec) return null;
  return spec;
}

/** 该版本+等级的数据码字总容量 */
function dataCodewordsTotal(version, ecl) {
  const spec = blocksOf(version, ecl);
  if (!spec) return 0;
  return spec.blocks.reduce(function (sum, b) {
    return sum + b[0] * b[1];
  }, 0);
}

/* ------------------------------------------------------------------ */
/* 数据编码                                                            */
/* ------------------------------------------------------------------ */
function utf8Bytes(str) {
  const out = [];
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
        continue;
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function pickVersion(byteLen, ecl) {
  for (let v = 1; v <= 10; v++) {
    const cap = dataCodewordsTotal(v, ecl);
    if (!cap) continue;
    const cci = v <= 9 ? 8 : 16;
    if (cap * 8 - 4 - cci >= byteLen * 8) return v;
  }
  return 0;
}

function buildDataCodewords(bytes, version, ecl) {
  const cap = dataCodewordsTotal(version, ecl);
  const cci = version <= 9 ? 8 : 16;
  const bits = [];

  function push(value, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  push(0x4, 4); // 字节模式
  push(bytes.length, cci);
  bytes.forEach(function (b) {
    push(b, 8);
  });

  // 终止符最多 4 位
  const maxBits = cap * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    words.push(b);
  }
  // 填充码字 0xEC / 0x11 交替
  let pad = 0;
  while (words.length < cap) {
    words.push(pad % 2 === 0 ? 0xec : 0x11);
    pad++;
  }
  return words;
}

/** 分块做 RS 纠错后交错 */
function interleave(dataWords, version, ecl) {
  const spec = blocksOf(version, ecl);
  const ecLen = spec.ec;
  const dataBlocks = [];
  const ecBlocks = [];

  let offset = 0;
  spec.blocks.forEach(function (b) {
    const count = b[0];
    const size = b[1];
    for (let i = 0; i < count; i++) {
      const chunk = dataWords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(chunk);
      ecBlocks.push(rsRemainder(chunk, ecLen));
    }
  });

  const out = [];
  const maxData = dataBlocks.reduce(function (m, b) {
    return Math.max(m, b.length);
  }, 0);
  for (let i = 0; i < maxData; i++) {
    dataBlocks.forEach(function (b) {
      if (i < b.length) out.push(b[i]);
    });
  }
  for (let i = 0; i < ecLen; i++) {
    ecBlocks.forEach(function (b) {
      out.push(b[i]);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* BCH 格式信息                                                        */
/* ------------------------------------------------------------------ */
function bchFormat(data) {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version) {
  let d = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | d;
}

/* ------------------------------------------------------------------ */
/* 矩阵构建                                                            */
/* ------------------------------------------------------------------ */
function createMatrix(size) {
  const m = [];
  const reserved = [];
  for (let y = 0; y < size; y++) {
    m.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(false));
  }
  return { m: m, reserved: reserved, size: size };
}

function setFunc(matrix, x, y, dark) {
  matrix.m[y][x] = dark ? 1 : 0;
  matrix.reserved[y][x] = true;
}

function drawFinder(matrix, x, y) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= matrix.size || py >= matrix.size) continue;
      const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark =
        inside &&
        ((dx === 0 || dx === 6 || dy === 0 || dy === 6) || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setFunc(matrix, px, py, dark);
    }
  }
}

function drawAlignment(matrix, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      setFunc(matrix, cx + dx, cy + dy, dark);
    }
  }
}

function buildFunctionPatterns(matrix, version) {
  const size = matrix.size;

  drawFinder(matrix, 0, 0);
  drawFinder(matrix, size - 7, 0);
  drawFinder(matrix, 0, size - 7);

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunc(matrix, i, 6, dark);
    setFunc(matrix, 6, i, dark);
  }

  // 对齐图案
  const pos = ALIGN_POS[version] || [];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const cx = pos[i];
      const cy = pos[j];
      // 跳过与三个定位图案重叠的角落
      const corner =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (corner) continue;
      drawAlignment(matrix, cx, cy);
    }
  }

  // 预留格式信息区
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      matrix.reserved[8][i] = true;
      matrix.reserved[i][8] = true;
    }
  }
  matrix.reserved[8][6] = true;
  matrix.reserved[6][8] = true;
  for (let i = 0; i < 8; i++) {
    matrix.reserved[8][size - 1 - i] = true;
    matrix.reserved[size - 1 - i][8] = true;
  }
  // 固定暗模块
  setFunc(matrix, 8, size - 8, true);

  // 版本信息（版本 7 及以上）
  if (version >= 7) {
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(matrix, a, b, dark);
      setFunc(matrix, b, a, dark);
    }
  }
}

function placeData(matrix, codewords, mask) {
  const size = matrix.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;

  function bitAt(idx) {
    if (idx >= totalBits) return 0;
    return (codewords[idx >> 3] >>> (7 - (idx & 7))) & 1;
  }

  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过定时列
    for (let n = 0; n < size; n++) {
      const row = up ? size - 1 - n : n;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (matrix.reserved[row][x]) continue;
        let dark = bitAt(bitIndex) === 1;
        bitIndex++;
        if (maskAt(mask, row, x)) dark = !dark;
        matrix.m[row][x] = dark ? 1 : 0;
      }
    }
    up = !up;
  }
}

function maskAt(mask, row, col) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function writeFormat(matrix, ecl, mask) {
  const size = matrix.size;
  const bits = bchFormat((ECL_BITS[ecl] << 3) | mask);

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // 左上角竖排
    if (i < 6) matrix.m[i][8] = dark ? 1 : 0;
    else if (i < 8) matrix.m[i + 1][8] = dark ? 1 : 0;
    else matrix.m[size - 15 + i][8] = dark ? 1 : 0;

    // 右上 / 左下
    if (i < 8) matrix.m[8][size - 1 - i] = dark ? 1 : 0;
    else if (i < 9) matrix.m[8][15 - i - 1 + 1] = dark ? 1 : 0;
    else matrix.m[8][15 - i - 1] = dark ? 1 : 0;
  }
  matrix.m[size - 8][8] = 1;
}

/* ------------------------------------------------------------------ */
/* 掩码罚分                                                            */
/* ------------------------------------------------------------------ */
function penalty(matrix) {
  const size = matrix.size;
  const m = matrix.m;
  let score = 0;

  // 规则 1：连续同色 >= 5
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m[y][x] === m[y][x - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m[y][x] === m[y - 1][x]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 模式（含静区）
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  function matchLine(get) {
    let count = 0;
    for (let i = 0; i + 7 <= size; i++) {
      let ok = true;
      for (let j = 0; j < 7; j++) {
        if (get(i + j) !== pattern[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // 前后需有 4 个浅色（越界视为浅色）
      let before = true;
      for (let j = 1; j <= 4; j++) {
        if (i - j >= 0 && get(i - j) !== 0) {
          before = false;
          break;
        }
      }
      let after = true;
      for (let j = 7; j <= 10; j++) {
        if (i + j < size && get(i + j) !== 0) {
          after = false;
          break;
        }
      }
      if (before || after) count++;
    }
    return count;
  }
  for (let y = 0; y < size; y++) score += 40 * matchLine(function (x) { return m[y][x]; });
  for (let x = 0; x < size; x++) score += 40 * matchLine(function (y) { return m[y][x]; });

  // 规则 4：暗色占比偏离 50%
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += m[y][x];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */
/**
 * 生成二维码矩阵
 * @param {string} text
 * @param {{ecl?:'L'|'M'}} [opts]
 * @returns {{size:number, modules:number[][], version:number, ecl:string}}
 */
function encode(text, opts) {
  const ecl = (opts && opts.ecl) || 'M';
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ecl);
  if (!version) throw new Error('二维码内容过长（' + bytes.length + ' 字节），无法生成');

  const dataWords = buildDataCodewords(bytes, version, ecl);
  const codewords = interleave(dataWords, version, ecl);

  const size = version * 4 + 17;
  let best = null;

  for (let mask = 0; mask < 8; mask++) {
    const matrix = createMatrix(size);
    buildFunctionPatterns(matrix, version);
    placeData(matrix, codewords, mask);
    writeFormat(matrix, ecl, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score: score, matrix: matrix, mask: mask };
  }

  return {
    size: size,
    // 统一成 0/1 二维数组（row 在前）
    modules: best.matrix.m,
    version: version,
    ecl: ecl,
    // 实际选用的掩码（0-7）与罚分，便于排查扫码兼容性问题
    mask: best.mask,
    penalty: best.score
  };
}

module.exports = { encode, utf8Bytes, pickVersion, dataCodewordsTotal, RS_TABLE, ALIGN_POS, ecPoly, rsRemainder };
