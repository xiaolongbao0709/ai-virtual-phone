/**
 * xhs-mcp.mjs —— 小红书 MCP 服务器（Netlify Function · 单文件版）
 * ============================================================================
 *
 * 这个文件做什么
 *   一个标准的 MCP（Model Context Protocol）服务器，让 ai-virtual-phone 里的
 *   AI 角色能真实地刷小红书：搜索笔记、看首页推荐、读正文和评论、点赞、收藏、
 *   发评论、看用户主页、发笔记。
 *
 * 为什么是单文件
 *   文件上半部分（约 1500 行）是从 SullyOS 的 XHS Lite 里原样取出的**纯 JS 签名
 *   实现**，用途是给每个小红书请求算 x-s / x-s-common / x-t 等风控签名。
 *   它是纯数学算法，不需要 Chrome、不需要 Python、不需要登录插件，只要一串
 *   cookie 就能跑，所以可以直接塞进 Netlify 的函数里。
 *   下部分是 MCP 协议层（JSON-RPC 握手 + 工具清单 + 结果渲染）。
 *   合成一个文件是为了部署最省事：在 GitHub 上新建 1 个文件就完事。
 *
 * 签名算法出处：Cloxl/xhshow（MIT），经由 SullyOS (qegj567-cloud/SullyOS) 移植，
 *   已与 Python 原版逐字节比对验证。此处原样保留，未做改动。
 *
 * 部署（不用命令行，全程网页 / 手机可完成）
 *   1. 在你的 ai-virtual-phone 仓库里新建文件 netlify/functions/xhs-mcp.mjs,
 *      把本文件全部内容粘进去。
 *   2. Netlify 站点 -> Site configuration -> Environment variables,
 *      新建变量 XHS_COOKIE = 你的小红书 cookie。
 *   3. 等 Netlify 自动重新部署完成。
 *   4. 在 ai-virtual-phone 的 设置 -> 工具(MCP) 里把服务器 URL 填成
 *      https://<你的站点>/.netlify/functions/xhs-mcp
 *
 * 环境变量
 *   XHS_COOKIE  必填。小红书完整 cookie（必须含 a1= 和 web_session=）。
 *               放在 Netlify 环境变量里，不进浏览器、不进备份、模型看不到。
 *   MCP_KEY     可选。设了就要求请求带 Authorization: Bearer <MCP_KEY>。
 *
 * 安全提醒
 *   这个 endpoint 是公开可访问的（Netlify 函数默认如此）。知道 URL 的人如果
 *   同时知道你的站点，就能调用它来操作你的小红书账号。强烈建议设置 MCP_KEY。
 *
 * ============================================================================
 */

// ============================================================================
//  第 1 部分：XHS Lite 核心（纯 JS 签名 + 小红书 Web API 封装）
//  来源：SullyOS worker/index.js 的 XHSLite 模块，原样复制，未修改。
//  对外接口：XHSLite.handle(command, body, cookie, env, ctx) -> JSON
// ============================================================================

const XHSLite = (() => {
  const STANDARD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const CUSTOM_B64 = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
  const X3_B64 = 'MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G';
  const HEX_KEY =
    '71a302257793271ddd273bcee3e4b98d9d7935e1da33f5765e2ea8afb6dc77a5' +
    '1a499d23b67c20660025860cbf13d4540d92497f58686c574e508f46e1956344' +
    'f39139bf4faf22a3eef120b79258145b2feb5193b6478669961298e79bedca64' +
    '6e1a693a926154a5a7a1bd1cf0dedb742f917a747a1e388b234f2277516db711' +
    '6035439730fa61e9822a0eca7bff72d8';
  const VERSION_BYTES = [121, 104, 96, 41];
  const PAYLOAD_LENGTH = 144, A1_LENGTH = 52, APP_ID_LENGTH = 10;
  const A3_PREFIX = [2, 97, 51, 16];
  const ENV_TABLE = [115, 248, 83, 102, 103, 201, 181, 131, 99, 94, 4, 68, 250, 132, 21];
  const ENV_CHECKS_DEFAULT = [0, 1, 18, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0];
  const HASH_IV = [1831565813, 461845907, 2246822507, 3266489909];
  const X3_PREFIX = 'mns0301_', XYS_PREFIX = 'XYS_', XYW_PREFIX = 'XYW_', B1_SECRET_KEY = 'xhswebmplfbt';
  const XYW_AES_KEY = '7cc4adla5ay0701v';
  const XYW_AES_IV = '4uzjr7mbsibcaldp';
  const XYW_ENV_FLAGS = '0|0|0|1|0|0|1|0|0|0|1|0|0|0|0|1|0|0|1';
  const SIGNATURE_DATA_TEMPLATE = { x0: '4.3.5', x1: 'xhs-pc-web', x2: 'Windows', x3: '', x4: 'object' };
  const SIGNATURE_XSCOMMON_TEMPLATE = {
    s0: 5, s1: '', x0: '1', x1: '4.3.5', x2: 'Windows', x3: 'xhs-pc-web', x4: '4.86.0',
    x5: '', x6: '', x7: '', x8: '', x9: -596800761, x10: 0, x11: 'normal',
  };
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';
  const IMG_FORMATS = ['jpg', 'webp', 'avif'];
  const EDITH = 'https://edith.xiaohongshu.com', CREATOR = 'https://creator.xiaohongshu.com', WWW = 'https://www.xiaohongshu.com';
  const XHS_PLATFORMS = Object.freeze({
    xhs: Object.freeze({ key: 'xhs', apiBase: EDITH, webBase: WWW }),
    rednote: Object.freeze({ key: 'rednote', apiBase: 'https://webapi.rednote.com', webBase: 'https://www.rednote.com' }),
  });
  const PLATFORM_CACHE_TTL_MS = 30 * 60 * 1000;
  const platformCache = new Map();
  const SPIDER_V3 = Object.freeze({
    schemaVersion: 1,
    signVersion: '4.3.7',
    webBuild: '6.32.2',
    appId: 'xhs-pc-web',
    platform: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    envConst: 1352,
    envFpTail: Object.freeze(hexToBytes('f9416767c9b581635e0744fa8415')),
  });
  const SPIDER_V3_STRATEGIES = new Set([
    'no-client-hints',
    'browser-hints',
    'legacy-transport',
  ]);
  const SPIDER_V3_DSL_URL = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';
  const SPIDER_V3_DSL_TTL_MS = 5 * 60 * 1000;
  const SPIDER_V3_DSLLT_REFRESH_MS = 15 * 60 * 1000;
  let spiderV3DslCache = { value: '', expiresAt: 0 };

  const RNG = {
    randint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); },
    randbytes(n) { const o = new Uint8Array(n); crypto.getRandomValues(o); return o; },
  };

  const u32 = (v) => v >>> 0;
  const rotl = (v, n) => u32((v << n) | (v >>> (32 - n)));
  const utf8 = (s) => new TextEncoder().encode(s);
  function intToLeBytes(val, length = 4) {
    const arr = []; let v = val;
    for (let i = 0; i < length; i++) { arr.push(v & 0xff); v = Math.floor(v / 256); }
    return arr;
  }
  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  function md5Hex(bytes) {
    if (typeof bytes === 'string') bytes = utf8(bytes);
    const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const ml = bytes.length * 8;
    const withOne = bytes.length + 1;
    const padLen = ((withOne + 8 + 63) & ~63) - withOne - 8;
    const total = bytes.length + 1 + padLen + 8;
    const msg = new Uint8Array(total);
    msg.set(bytes); msg[bytes.length] = 0x80;
    const lenLo = ml >>> 0, lenHi = Math.floor(ml / 4294967296) >>> 0;
    for (let i = 0; i < 4; i++) msg[total - 8 + i] = (lenLo >>> (8 * i)) & 0xff;
    for (let i = 0; i < 4; i++) msg[total - 4 + i] = (lenHi >>> (8 * i)) & 0xff;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < total; off += 64) {
      const M = new Array(16);
      for (let i = 0; i < 16; i++) {
        M[i] = ((msg[off + i * 4]) | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0;
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | (~D >>> 0)); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B; B = (B + rotl(F, s[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const toHex = (n) => { let h = ''; for (let i = 0; i < 4; i++) h += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0'); return h; };
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
  }

  function bytesToStdB64(bytes) {
    let out = ''; const n = bytes.length;
    for (let i = 0; i < n; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0, b2 = i + 2 < n ? bytes[i + 2] : 0;
      out += STANDARD_B64[b0 >> 2];
      out += STANDARD_B64[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < n ? STANDARD_B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < n ? STANDARD_B64[b2 & 63] : '=';
    }
    return out;
  }
  function translateAlphabet(str, to) {
    let out = '';
    for (const ch of str) { const idx = STANDARD_B64.indexOf(ch); out += idx === -1 ? ch : to[idx]; }
    return out;
  }
  const encodeCustom = (bytes) => translateAlphabet(bytesToStdB64(bytes), CUSTOM_B64);
  const encodeX3 = (bytes) => translateAlphabet(bytesToStdB64(bytes), X3_B64);
  const encodeCustomStr = (str) => encodeCustom(utf8(str));

  const CRC_POLY = 0xedb88320;
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let d = 0; d < 256; d++) { let r = d; for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >>> 1) ^ CRC_POLY) : (r >>> 1); CRC_TABLE[d] = r >>> 0; }
    return CRC_TABLE;
  }
  function crc32JsInt(str) {
    const tbl = crcTable(); let c = 0xffffffff;
    for (let i = 0; i < str.length; i++) { const b = str.charCodeAt(i) & 0xff; c = (tbl[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0; }
    const v = ((0xffffffff ^ c) ^ CRC_POLY) >>> 0;
    return v & 0x80000000 ? v - 0x100000000 : v;
  }

  function rc4(keyBytes, dataBytes) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff; const t = S[i]; S[i] = S[j]; S[j] = t; }
    const out = new Uint8Array(dataBytes.length);
    let a = 0, b = 0;
    for (let k = 0; k < dataBytes.length; k++) {
      a = (a + 1) & 0xff; b = (b + S[a]) & 0xff;
      const t = S[a]; S[a] = S[b]; S[b] = t;
      out[k] = dataBytes[k] ^ S[(S[a] + S[b]) & 0xff];
    }
    return out;
  }

  function customHashV2(inputBytes) {
    let [s0, s1, s2, s3] = HASH_IV;
    const length = inputBytes.length;
    s0 = u32(s0 ^ length); s1 = u32(s1 ^ u32(length << 8)); s2 = u32(s2 ^ u32(length << 16)); s3 = u32(s3 ^ u32(length << 24));
    const dv = new DataView(new Uint8Array(inputBytes).buffer);
    for (let i = 0; i < Math.floor(length / 8); i++) {
      const v0 = dv.getUint32(i * 8, true), v1 = dv.getUint32(i * 8 + 4, true);
      s0 = rotl(u32(u32(s0 + v0) ^ s2), 7);
      s1 = rotl(u32(u32(v0 ^ s1) + s3), 11);
      s2 = rotl(u32(u32(s2 + v1) ^ s0), 13);
      s3 = rotl(u32(u32(s3 ^ v1) + s1), 17);
    }
    const t0 = u32(s0 ^ length), t1 = u32(s1 ^ t0), t2 = u32(s2 + t1), t3 = u32(s3 ^ t2);
    const r0 = rotl(t0, 9), r1 = rotl(t1, 13), r2 = rotl(t2, 17), r3 = rotl(t3, 19);
    s0 = u32(r0 + r2); s1 = u32(r1 ^ r3); s2 = u32(r2 + s0); s3 = u32(r3 ^ s1);
    const result = [];
    for (const s of [s0, s1, s2, s3]) result.push(...intToLeBytes(s, 4));
    return result;
  }

  function pyQuote(value, safeExtra) {
    const keep = new Set();
    const always = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~';
    for (const c of always) keep.add(c);
    for (const c of safeExtra) keep.add(c);
    let out = '';
    for (const byte of utf8(value)) {
      const ch = String.fromCharCode(byte);
      if (byte < 0x80 && keep.has(ch)) out += ch;
      else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }
  const jsonCompact = (obj) => JSON.stringify(obj);
  function buildContentString(method, uri, payload) {
    payload = payload || {};
    if (method.toUpperCase() === 'POST') return uri + jsonCompact(payload);
    const keys = Object.keys(payload);
    if (!keys.length) return uri;
    const parts = keys.map((k) => {
      const v = payload[k];
      let s; if (Array.isArray(v)) s = v.map(String).join(','); else if (v !== null && v !== undefined) s = String(v); else s = '';
      return `${k}=${pyQuote(s, ',')}`;
    });
    return `${uri}?${parts.join('&')}`;
  }
  function extractUri(uri) {
    uri = uri.trim();
    if (uri.startsWith('http')) return new URL(uri).pathname;
    const q = uri.indexOf('?');
    return q === -1 ? uri : uri.slice(0, q);
  }

  function buildPayloadArray(dValue, mValue, a1Value, appId, stringParam, timestampSec) {
    const seed = RNG.randint(0, 0xffffffff), seedByte = seed & 0xff;
    const payload = [...VERSION_BYTES];
    payload.push(...intToLeBytes(seed, 4));
    const tsMs = Math.floor(timestampSec * 1000), tsBytes = intToLeBytes(tsMs, 8);
    payload.push(...tsBytes);
    const timeOffset = RNG.randint(10, 50);
    payload.push(...intToLeBytes(Math.floor((timestampSec - timeOffset) * 1000), 8));
    payload.push(...intToLeBytes(RNG.randint(15, 50), 4));
    payload.push(...intToLeBytes(RNG.randint(1000, 1200), 4));
    payload.push(...intToLeBytes(utf8(stringParam).length, 4));
    const md5Bytes = hexToBytes(dValue);
    for (let i = 0; i < 8; i++) payload.push(md5Bytes[i] ^ seedByte);
    const a1Full = utf8(a1Value).slice(0, A1_LENGTH);
    const a1Bytes = new Uint8Array(A1_LENGTH); a1Bytes.set(a1Full);
    payload.push(a1Bytes.length); payload.push(...a1Bytes);
    const appFull = utf8(appId).slice(0, APP_ID_LENGTH);
    const appBytes = new Uint8Array(APP_ID_LENGTH); appBytes.set(appFull);
    payload.push(appBytes.length); payload.push(...appBytes);
    const part11 = [1, seedByte ^ ENV_TABLE[0]];
    for (let i = 1; i < 15; i++) part11.push(ENV_TABLE[i] ^ ENV_CHECKS_DEFAULT[i]);
    payload.push(...part11);
    const md5PathBytes = hexToBytes(mValue);
    const hashed = customHashV2([...tsBytes, ...md5PathBytes]);
    payload.push(...A3_PREFIX, ...hashed.map((b) => b ^ seedByte));
    return payload;
  }
  function xorTransform(src) {
    const key = hexToBytes(HEX_KEY);
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = (i < key.length ? (src[i] ^ key[i]) : src[i]) & 0xff;
    return out;
  }

  function signXs(method, uri, a1Value, { appId = 'xhs-pc-web', payload = null, timestampSec = null } = {}) {
    uri = extractUri(uri);
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const contentString = buildContentString(method, uri, payload);
    const dValue = md5Hex(contentString);
    const mValue = method.toUpperCase() === 'GET' ? dValue : md5Hex(uri);
    const xorResult = xorTransform(buildPayloadArray(dValue, mValue, a1Value, appId, contentString, timestampSec));
    const x3sig = encodeX3(xorResult.slice(0, PAYLOAD_LENGTH));
    return XYS_PREFIX + encodeCustomStr(jsonCompact({ ...SIGNATURE_DATA_TEMPLATE, x3: X3_PREFIX + x3sig }));
  }

  function randomUint32() {
    const out = new Uint32Array(1);
    crypto.getRandomValues(out);
    return out[0] >>> 0;
  }

  async function sha256Prefix(value) {
    const digest = await crypto.subtle.digest('SHA-256', utf8(String(value)));
    return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function finiteInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  }

  async function normalizeSpiderV3State(cookieDict, suppliedState, nowMs = Date.now()) {
    const a1Tag = await sha256Prefix(cookieDict.a1);
    const supplied = suppliedState && typeof suppliedState === 'object' ? suppliedState : {};
    const suppliedLoadts = finiteInteger(supplied.loadts, 0, 1, Number.MAX_SAFE_INTEGER);
    const reusable = supplied.version === SPIDER_V3.schemaVersion
      && supplied.a1Tag === a1Tag
      && suppliedLoadts > 0;
    const cookieLoadts = /^\d{13}$/.test(cookieDict.loadts || '') ? Number(cookieDict.loadts) : 0;
    const loadts = reusable
      ? suppliedLoadts
      : (cookieLoadts || (nowMs - RNG.randint(50, 200)));
    const b1Seed = reusable
      ? finiteInteger(supplied.b1Seed, randomUint32(), 0, 0xffffffff)
      : randomUint32();
    return {
      version: SPIDER_V3.schemaVersion,
      a1Tag,
      loadts,
      dsllt: reusable
        ? finiteInteger(supplied.dsllt, loadts, 1, Number.MAX_SAFE_INTEGER)
        : loadts,
      mnsSeq: reusable ? finiteInteger(supplied.mnsSeq, 0, 0, 0x7fffffff) : 0,
      signCount: reusable ? finiteInteger(supplied.signCount, 0, 0, 0x7fffffff) : 0,
      b1Seed,
      timeOrigin: reusable && Number.isFinite(Number(supplied.timeOrigin))
        ? Number(supplied.timeOrigin)
        : loadts - (700 + (b1Seed % 1600)),
      webBuild: String(cookieDict.webBuild || supplied.webBuild || SPIDER_V3.webBuild),
      reset: !reusable,
    };
  }

  function spiderV3Telemetry(state) {
    const seed = state.b1Seed >>> 0;
    const mouseCount = 45 + (seed % 11);
    const clickCount = 1 + ((seed >>> 5) % 3);
    const focusCount = 3 + ((seed >>> 9) % 4);
    const blurCount = Math.max(1, focusCount - 1);
    return `{mt:{to:${state.timeOrigin}},m:{me:${mouseCount},mm:${mouseCount},md:${clickCount},mu:${clickCount},c:${clickCount}},k:{},p:{ulr:1,ps:1,f:${focusCount},b:${blurCount},vc:0,rs:1,sc:0},st:{h:0,f:1,kr:0},ft:{ae:3.3656015629507223,ak:6.231183732330187,cdr:0.4096814442007536,bf:{ar:0.6210873146622735,fr:7.158084478545331},fi:${2151.1 + (seed % 200) / 10}}}`;
  }

  function generateSpiderV3B1(state, nowMs) {
    const seed = state.b1Seed >>> 0;
    const mini = {
      x33: '0',
      x34: '0',
      x35: '0',
      x36: String(2 + (seed % 3)),
      x37: '0|0|0|0|0|0|0|0|0|1|0|0|1|0|0|0|0|1|1|0|0|0|0|0',
      x38: '0|0|1|0|1|0|0|0|0|0|1|0|1|0|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0',
      x39: String(21 + ((seed >>> 4) % 3)),
      x42: '3.5.4',
      x43: 'Canvas not supported',
      x44: String(nowMs),
      x45: '__SEC_CAV__1-1-1-1-1|',
      x46: 'false',
      x48: '',
      x49: '{list:[],type:}',
      x50: '131,88,103',
      x51: '',
      x52: '',
      x82: '1|_BHjFmfUMEtxhI|_AUuXfEG27Xa3x|__xhsPendingNotePoint25300ReportMap|__xhsReportedNotePoint25300RecordMap|setImDebugMode|anti_hp_sign_config|__rap_app_id__|__rap_report__|__rap_last_sign_cost__|__rap_last_transform_cost__|__rap_hijack_installed__|__ed1a7dddf7c818e4bd',
      x84: spiderV3Telemetry(state),
    };
    const cipher = rc4(utf8(B1_SECRET_KEY), utf8(jsonCompact(mini)));
    let binary = '';
    for (const byte of cipher) binary += String.fromCharCode(byte);
    return encodeCustom(utf8(binary));
  }

  function buildSpiderV3Payload(api, a1Value, context) {
    const a1Bytes = Array.from(utf8(a1Value));
    if (a1Bytes.length !== A1_LENGTH) {
      throw new Error(`Spider v3 requires a ${A1_LENGTH}-byte a1 cookie`);
    }
    const appBytes = Array.from(utf8(SPIDER_V3.appId));
    const version = context.version >>> 0;
    const versionByte = version & 0xff;
    const timestampBytes = intToLeBytes(context.now, 8);
    const md5Full = hexToBytes(md5Hex(api));
    const md5Api = hexToBytes(md5Hex(api));
    const dsSignature = customHashV2([...timestampBytes, ...md5Api]);
    const payload = [
      ...VERSION_BYTES,
      ...intToLeBytes(version, 4),
      ...timestampBytes,
      ...intToLeBytes(context.loadts, 8),
      ...intToLeBytes(context.seq, 4),
      ...intToLeBytes(SPIDER_V3.envConst, 4),
      ...intToLeBytes(utf8(api).length, 4),
      ...md5Full.slice(0, 8).map((byte) => byte ^ versionByte),
      a1Bytes.length,
      ...a1Bytes,
      appBytes.length,
      ...appBytes,
      1,
      versionByte ^ 115,
      ...SPIDER_V3.envFpTail,
      2,
      97,
      51,
      16,
      ...dsSignature.map((byte) => byte ^ versionByte),
    ];
    if (payload.length !== PAYLOAD_LENGTH) {
      throw new Error(`Spider v3 MNS payload length mismatch: ${payload.length}`);
    }
    return payload;
  }

  function signSpiderV3Comment(api, cookieDict, state, dsl, options = {}) {
    const nextState = { ...state };
    nextState.mnsSeq += 1;
    nextState.signCount += 1;
    const now = finiteInteger(options.now, Date.now(), 1, Number.MAX_SAFE_INTEGER);
    if (now - nextState.dsllt >= SPIDER_V3_DSLLT_REFRESH_MS) nextState.dsllt = now;
    const context = {
      now,
      loadts: nextState.loadts,
      seq: nextState.mnsSeq,
      version: options.version == null ? randomUint32() : Number(options.version) >>> 0,
    };
    const x3 = X3_PREFIX + encodeX3(xorTransform(buildSpiderV3Payload(api, cookieDict.a1, context)));
    const xs = XYS_PREFIX + encodeCustomStr(jsonCompact({
      x0: SPIDER_V3.signVersion,
      x1: SPIDER_V3.appId,
      x2: SPIDER_V3.platform,
      x3,
      x4: '',
    }));
    const xt = String(now);
    const b1 = generateSpiderV3B1(nextState, now);
    const xsCommon = encodeCustomStr(jsonCompact({
      s0: 5,
      s1: '',
      x0: '1',
      x1: SPIDER_V3.signVersion,
      x2: SPIDER_V3.platform,
      x3: SPIDER_V3.appId,
      x4: nextState.webBuild,
      x5: cookieDict.a1,
      x6: '',
      x7: '',
      x8: b1,
      x9: crc32JsInt(b1),
      x10: nextState.signCount,
      x11: 'normal',
      x12: `${nextState.dsllt};${dsl}`,
    }));
    delete nextState.reset;
    return {
      state: nextState,
      headers: {
        'x-s': xs,
        'x-t': xt,
        'x-s-common': xsCommon,
        'x-b3-traceid': b3TraceId(),
        'x-xray-traceid': xrayTraceId(now),
      },
      debug: { x3Prefix: x3.slice(0, 12), x3Length: x3.length, b1Length: b1.length },
    };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function signXyw(method, uri, a1Value, { appId = 'xhs-pc-web', payload = null, timestampSec = null } = {}) {
    uri = extractUri(uri);
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const contentString = buildContentString(method, uri, payload);
    const timestampMs = String(Math.floor(timestampSec * 1000));
    const x1 = md5Hex(`url=${contentString}`);
    const message = utf8(`x1=${x1};x2=${XYW_ENV_FLAGS};x3=${a1Value};x4=${timestampMs};`);
    const plaintext = utf8(bytesToBase64(message));
    const key = await crypto.subtle.importKey('raw', utf8(XYW_AES_KEY), 'AES-CBC', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: utf8(XYW_AES_IV) },
      key,
      plaintext,
    ));
    const signData = {
      signSvn: '56',
      signType: 'x2',
      appId,
      signVersion: '1',
      payload: bytesToHex(encrypted),
    };
    return XYW_PREFIX + bytesToBase64(utf8(jsonCompact(signData)));
  }

  // x-rap-param: ported from xhshow 4.3.5. Feed/search endpoints started
  // requiring this browser-risk-control envelope in the 2026 server rollout.
  const XRAP_ROUND_KEYS = [
    [0x6B714931, 0x44546377, 0x4B583930, 0x5A744179],
    [0x89314C98, 0xCD652FEF, 0x863D16DF, 0xDC4957A6],
    [0xC205330C, 0x0F601CE3, 0x895D0A3C, 0x55145D9A],
    [0xD205006E, 0xDD651C8D, 0x543816B1, 0x012C4B2B],
    [0x770C2B6F, 0xAA6937E2, 0xFE512153, 0xFF7D6A78],
    [0x7866FBF4, 0xD20FCC16, 0x2C5EED45, 0xD323873D],
    [0x90E9C67E, 0x42E60A68, 0x6EB8E72D, 0xBD9B6010],
    [0xE9C52BEE, 0xAB232186, 0xC59BC6AB, 0x7800A6BB],
    [0x13BA9A3E, 0xB899BBB8, 0x7D027D13, 0x0502DBA8],
    [0x50613270, 0xE8F889C8, 0x95FAF4DB, 0x90F82F73],
  ];
  const XRAP_LAST_KEY = [0xF396B44F, 0x1B6E3D87, 0x8E94C95C, 0x1E6CE62F];
  const XRAP_SBOX = Uint8Array.from(hexToBytes(
    '7a0158e0504e02791d4b53da6b48d452ed7712211415ec1018e5b9f10c08fc7d' +
    'f9cdb5c8e637268756bab82badf068f78b8dd35e364d2e923182f229703d2dd7' +
    'b640b243448078d20d494a09636c073a9ed506c6e162f4342459a9572a003e17' +
    '2c0a1a42fa93bedcf5b36a13e803c797bb737686e3467247d0054c387c1f81ab' +
    '7551ebf33274118f84899c71227e9dcf3f9169653c6d96a2989933399acac39f' +
    'a0bce4a3a4547fa7a8046f5dacb727afb02841aeb46e0b1bdf8e30b1fe906160' +
    'c0cb5c0eef1683ea20e9c955c44585cc1eaa678a7b35d619d8d9c2db94dd1cde' +
    'a6fff8bf5b5a0fe7c1bdd166c525ee8ce25f88a13ba5f6ce952f6423fbfd4f9b'
  ));
  const XRAP_TRACE = Uint8Array.from(hexToBytes(
    '0002000200004700000000000001ffd9ffa8005c23fff1ffff001501ff90fff9000022fff2ffff' +
    '001501ffb800770061a5ffe3ffff002a01fffcffe70000f0ffe4ffff002a01ffd30000003e01' +
    'ffd40000003e01ffc8ffff005301ffbdfffa006901ffbefffb006901ffb1fff4007d01ffa6ff' +
    'ee009301ffa8ffef009301ff9effe900a801ff96ffe600be01ff97ffe600be01ff93ffe500d3' +
    '01ff92ffe500ea01ff92ffe4010501ff92ffe3011b01ff92ffe402d101ff93ffe502f201ff94' +
    'ffe6040501'
  ));
  const XRAP_ENV = Uint8Array.from(hexToBytes(
    '000000010000000000000000fffeffff00000000000000390001ffff00bc00000000006e0002' +
    '0001013400000000012f00000002011a00000000016100000000019f000000000247000000000279' +
    '0000000002b1'
  ));
  const xrapConcat = (...parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  };
  const xrapU16 = (value) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
  const xrapU32 = (value) => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const xrapU64 = (value) => {
    let n = BigInt(value);
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
    return out;
  };
  const xrapFieldByte = (tag, value = 0) => xrapConcat(xrapU16(tag), Uint8Array.of(value));
  const xrapFieldU32 = (tag, value) => xrapConcat(xrapU16(tag), xrapU32(value));
  const xrapFieldU64 = (tag, value) => xrapConcat(xrapU16(tag), xrapU64(value));
  const xrapFieldBlob = (tag, value) => xrapConcat(xrapU16(tag), xrapU32(value.length), value);
  function xrapXxh32(data, seed = 0) {
    const p1 = 0x9E3779B1, p2 = 0x85EBCA77, p3 = 0xC2B2AE3D, p4 = 0x27D4EB2F, p5 = 0x165667B1;
    const round = (acc, word) => Math.imul(rotl(u32(acc + Math.imul(word, p2)), 13), p1) >>> 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0, digest;
    if (data.length >= 16) {
      let a1 = u32(seed + p1 + p2), a2 = u32(seed + p2), a3 = seed >>> 0, a4 = u32(seed - p1);
      while (pos <= data.length - 16) {
        a1 = round(a1, view.getUint32(pos, true)); pos += 4;
        a2 = round(a2, view.getUint32(pos, true)); pos += 4;
        a3 = round(a3, view.getUint32(pos, true)); pos += 4;
        a4 = round(a4, view.getUint32(pos, true)); pos += 4;
      }
      digest = u32(rotl(a1, 1) + rotl(a2, 7) + rotl(a3, 12) + rotl(a4, 18));
    } else {
      digest = u32(seed + p5);
    }
    digest = u32(digest + data.length);
    while (pos + 4 <= data.length) {
      digest = Math.imul(rotl(u32(digest + Math.imul(view.getUint32(pos, true), p3)), 17), p4) >>> 0;
      pos += 4;
    }
    while (pos < data.length) {
      digest = Math.imul(rotl(u32(digest + Math.imul(data[pos], p5)), 11), p1) >>> 0;
      pos++;
    }
    digest ^= digest >>> 15;
    digest = Math.imul(digest, p2) >>> 0;
    digest ^= digest >>> 13;
    digest = Math.imul(digest, p3) >>> 0;
    digest ^= digest >>> 16;
    return digest >>> 0;
  }
  let xrapLuts;
  function getXrapLuts() {
    if (xrapLuts) return xrapLuts;
    const tables = Array.from({ length: 4 }, () => new Uint32Array(256));
    const gf2 = (value) => ((value << 1) ^ ((value & 0x80) ? 0x11b : 0)) & 0xff;
    XRAP_SBOX.forEach((s, i) => {
      const a = gf2(s), d = a ^ s;
      tables[0][i] = u32((a << 24) | (s << 16) | (s << 8) | d);
      tables[1][i] = u32((d << 24) | (a << 16) | (s << 8) | s);
      tables[2][i] = u32((s << 24) | (d << 16) | (a << 8) | s);
      tables[3][i] = u32((s << 24) | (s << 16) | (d << 8) | a);
    });
    xrapLuts = tables;
    return tables;
  }
  function xrapEncryptBlock(block) {
    const src = new Uint8Array(16);
    src.set(block.slice(0, 16));
    const view = new DataView(src.buffer);
    let state = [0, 1, 2, 3].map((i) => u32(view.getUint32(i * 4) ^ XRAP_ROUND_KEYS[0][i]));
    const lut = getXrapLuts();
    for (let round = 1; round < 10; round++) {
      const next = [];
      for (let i = 0; i < 4; i++) {
        next[i] = u32(
          lut[0][state[i] >>> 24] ^
          lut[1][(state[(i + 1) & 3] >>> 16) & 0xff] ^
          lut[2][(state[(i + 2) & 3] >>> 8) & 0xff] ^
          lut[3][state[(i + 3) & 3] & 0xff] ^
          XRAP_ROUND_KEYS[round][i]
        );
      }
      state = next;
    }
    const lastKey = xrapConcat(...XRAP_LAST_KEY.map(xrapU32));
    const out = new Uint8Array(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const index = (state[(row + col) & 3] >>> (24 - 8 * col)) & 0xff;
        out[row * 4 + col] = XRAP_SBOX[index] ^ lastKey[row * 4 + col];
      }
    }
    return out;
  }
  function xrapEncryptBlocks(data) {
    const blocks = [];
    for (let offset = 0; offset < data.length; offset += 16) blocks.push(xrapEncryptBlock(data.slice(offset, offset + 16)));
    return xrapConcat(...blocks);
  }
  const xrapRandomAscii = (length) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < length; i++) value += chars[RNG.randint(0, chars.length - 1)];
    return value;
  };
  function xrapBuildBody(api, data, options) {
    const bodyString = typeof data === 'string' ? data : jsonCompact(data);
    const timestamp = options.timestampMs ?? Date.now();
    const innerKey = utf8(options.innerKey ?? xrapRandomAscii(16));
    const mask = options.mask ?? RNG.randint(1, 255);
    const nonce = options.bodyRand32 ?? RNG.randint(0, 0xffffffff);
    const fields = [
      xrapFieldU64(0x03e8, timestamp),
      xrapFieldU32(0x03e9, nonce),
      xrapFieldBlob(0x03ea, innerKey),
      xrapFieldU32(0x03eb, xrapXxh32(utf8(api + bodyString))),
    ];
    for (const tag of [...Array.from({ length: 15 }, (_, i) => 1051 + i), 1070, ...Array.from({ length: 4 }, (_, i) => 1066 + i)]) {
      fields.push(xrapFieldByte(tag));
    }
    fields.push(xrapFieldU32(1100, 0));
    for (let tag = 1071; tag < 1074; tag++) fields.push(xrapFieldByte(tag));
    fields.push(xrapFieldU32(1075, 0x564), xrapFieldU32(1076, 0x2c));
    fields.push(xrapFieldU64(1077, Math.max(0, timestamp - 0x434)), xrapFieldBlob(1078, XRAP_TRACE));
    fields.push(xrapFieldU32(1082, 0), xrapFieldU32(1084, 0), xrapFieldU32(1085, 0), xrapFieldU32(1086, 100));
    fields.push(xrapFieldU64(1087, Math.max(0, timestamp - 0x2d7)), xrapFieldBlob(1088, XRAP_ENV));
    fields.push(xrapFieldU32(1090, 0), xrapFieldU32(1097, 0), xrapFieldU32(1092, 0x566), xrapFieldU32(1094, 0x519));
    fields.push(xrapFieldU64(1095, Math.max(0, timestamp - 0x218c)), xrapFieldU32(1093, 0), xrapFieldByte(1096));
    fields.push(xrapFieldBlob(1091, Uint8Array.of(0, 0, 0xff, 0xff)));
    for (let tag = 1151; tag < 1157; tag++) fields.push(xrapFieldByte(tag));
    const raw = xrapConcat(...fields);
    for (let i = 16; i < raw.length; i++) raw[i] ^= mask;
    return raw;
  }
  async function xrapGzip(data, mtime) {
    if (typeof CompressionStream !== 'function') throw new Error('CompressionStream(gzip) is unavailable');
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    const output = new Uint8Array(await new Response(stream).arrayBuffer());
    if (mtime !== undefined && output.length >= 10) {
      const value = mtime >>> 0;
      output[4] = value & 0xff; output[5] = (value >>> 8) & 0xff;
      output[6] = (value >>> 16) & 0xff; output[7] = (value >>> 24) & 0xff;
    }
    if (output.length >= 10) output[9] = 0x03;
    return output;
  }
  async function xRapParam(api, data, options = {}) {
    const raw = xrapBuildBody(api, data, options);
    const compressed = await xrapGzip(raw, options.gzipMtime);
    const key = utf8(options.aesKey ?? xrapRandomAscii(16));
    const salt = utf8(options.randomString ?? xrapRandomAscii(RNG.randint(4, 6)));
    const xored = Uint8Array.from(compressed, (byte, i) => byte ^ key[i % key.length]);
    const cipherBody = xrapConcat(xrapEncryptBlocks(xored), xrapU32(compressed.length));
    const content = xrapConcat(salt, xrapEncryptBlock(key), xrapU32(16), cipherBody);
    const processingTime = options.bodyEncryptTime ?? RNG.randint(60, 240);
    const header = xrapConcat(
      Uint8Array.of(0x07, 0x24, 0x01, salt.length),
      xrapU32(1), xrapU32(20), xrapU32(cipherBody.length),
      xrapU32(xrapXxh32(content)), xrapU32(10300), xrapU32(processingTime),
      new Uint8Array(8),
    );
    return bytesToBase64(xrapConcat(header, content));
  }

  function generateB1(fp) {
    const keys = ['x33', 'x34', 'x35', 'x36', 'x37', 'x38', 'x39', 'x42', 'x43', 'x44', 'x45', 'x46', 'x48', 'x49', 'x50', 'x51', 'x52', 'x82'];
    const b1fp = {};
    for (const k of keys) b1fp[k] = fp[k];
    const cipher = rc4(utf8(B1_SECRET_KEY), utf8(jsonCompact(b1fp)));
    let cipherStr = '';
    for (const b of cipher) cipherStr += String.fromCharCode(b);
    const encodedUrl = pyQuote(cipherStr, "!*'()~_-");
    const b = [];
    for (const c of encodedUrl.split('%').slice(1)) {
      b.push(parseInt(c.slice(0, 2), 16));
      for (const ch of c.slice(2)) b.push(ch.charCodeAt(0));
    }
    return encodeCustom(b);
  }

  const GPU_VENDORS = [
    'Google Inc. (Intel)|ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x0000250F) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Google Inc. (AMD)|ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ];
  const SCREEN_RES = ['1366;768', '1920;1080', '2560;1440'];
  const pick = (arr) => arr[RNG.randint(0, arr.length - 1)];
  const randMd5 = () => md5Hex(RNG.randbytes(32));
  function generateFingerprint(cookies) {
    const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const [w, h] = pick(SCREEN_RES).split(';').map(Number);
    const incognito = RNG.randint(0, 99) < 95 ? 'true' : 'false';
    const [vendor, renderer] = pick(GPU_VENDORS).split('|');
    return {
      x1: UA, x2: 'false', x3: 'zh-CN', x4: pick([16, 24, 30, 32]), x5: pick([2, 4, 8, 16]), x6: '24',
      x7: `${vendor},${renderer}`, x8: pick([4, 6, 8, 12, 16]), x9: `${w};${h}`, x10: `${w};${h}`, x11: '-480', x12: 'Asia/Shanghai',
      x13: incognito, x14: incognito, x15: incognito, x16: 'false', x17: 'false', x18: 'un', x19: 'Win32', x20: '',
      x21: 'PDF Viewer,Chrome PDF Viewer', x22: randMd5(), x23: 'false', x24: 'false', x25: 'false', x26: 'false', x27: 'false',
      x28: '0,false,false', x29: '4,7,8', x30: 'swf object not loaded',
      x33: '0', x34: '0', x35: '0', x36: `${RNG.randint(1, 20)}`,
      x37: '0|0|0|0|0|0|0|0|0|1|0|0|0|0|0|0|0|0|1|0|0|0|0|0',
      x38: '0|0|1|0|1|0|0|0|0|0|1|0|1|0|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0',
      x39: 0, x40: '0', x41: '0', x42: '3.4.4', x43: randMd5(), x44: `${Date.now()}`,
      x45: '__SEC_CAV__1-1-1-1-1|__SEC_WSA__|', x46: 'false', x47: '1|0|0|0|0|0',
      x48: '', x49: '{list:[],type:}', x50: '', x51: '', x52: '', x82: '_0x17a2|_0x1954',
      x53: randMd5(), x57: cookieString,
    };
  }

  function signXsCommon(cookieDict, fingerprint) {
    const fp = fingerprint || generateFingerprint(cookieDict);
    const b1 = generateB1(fp);
    return encodeCustomStr(jsonCompact({ ...SIGNATURE_XSCOMMON_TEMPLATE, x5: cookieDict.a1, x8: b1, x9: crc32JsInt(b1) }));
  }

  const HEX_CHARS = 'abcdef0123456789';
  function b3TraceId() { let s = ''; for (let i = 0; i < 16; i++) s += HEX_CHARS[RNG.randint(0, 15)]; return s; }
  function xrayTraceId(tsMs) {
    if (!tsMs) tsMs = Date.now();
    const part1 = ((BigInt(tsMs) << 23n) | BigInt(RNG.randint(0, 8388607))).toString(16).padStart(16, '0');
    let part2 = ''; for (let i = 0; i < 16; i++) part2 += HEX_CHARS[RNG.randint(0, 15)];
    return part1 + part2;
  }
  async function signHeaders(method, uri, cookieDict, {
    params = null,
    payload = null,
    timestampSec = null,
    signFormat = 'xys',
  } = {}) {
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const m = method.toUpperCase();
    const requestData = m === 'GET' ? params : payload;
    const xSignature = signFormat === 'xyw'
      ? await signXyw(m, uri, cookieDict.a1, { payload: requestData, timestampSec })
      : signXs(m, uri, cookieDict.a1, { payload: requestData, timestampSec });
    return {
      'x-s': xSignature,
      'x-s-common': signXsCommon(cookieDict),
      'x-t': String(Math.floor(timestampSec * 1000)),
      'x-b3-traceid': b3TraceId(),
      'x-xray-traceid': xrayTraceId(Math.floor(timestampSec * 1000)),
    };
  }

  // ---------- API layer ----------
  function parseCookies(s) {
    const out = {};
    if (!s) return out;
    for (const part of s.split(';')) { const i = part.indexOf('='); if (i === -1) continue; out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return out;
  }
  function normalizePlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    return platform === 'xhs' || platform === 'rednote' ? platform : 'auto';
  }
  function platformConfig(value) {
    return XHS_PLATFORMS[normalizePlatform(value)] || XHS_PLATFORMS.xhs;
  }
  function platformForApiBase(base) {
    return String(base).includes('rednote.com') ? XHS_PLATFORMS.rednote : XHS_PLATFORMS.xhs;
  }
  function platformCacheKey(cookieStr) {
    const a1 = parseCookies(cookieStr).a1 || '';
    return a1 ? md5Hex(a1).slice(0, 16) : '';
  }
  function getCachedPlatform(cookieStr, now = Date.now()) {
    const key = platformCacheKey(cookieStr);
    const cached = key ? platformCache.get(key) : null;
    if (!cached) return '';
    if (cached.expiresAt <= now) {
      platformCache.delete(key);
      return '';
    }
    return cached.platform;
  }
  function cachePlatform(cookieStr, platform, now = Date.now()) {
    const key = platformCacheKey(cookieStr);
    if (key) platformCache.set(key, { platform, expiresAt: now + PLATFORM_CACHE_TTL_MS });
  }
  function clearCachedPlatform(cookieStr) {
    const key = platformCacheKey(cookieStr);
    if (key) platformCache.delete(key);
  }
  function baseHeaders(cookieStr, apiBase = EDITH) {
    const { webBase } = platformForApiBase(apiBase);
    return {
      accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json;charset=UTF-8', origin: webBase, referer: webBase + '/', 'user-agent': UA,
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"', 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site',
      'x-mns': 'unload', cookie: cookieStr,
    };
  }
  function buildSignedQuery(params) {
    if (!params) return '';
    const keys = Object.keys(params);
    if (!keys.length) return '';
    return keys.map((k) => {
      const v = params[k];
      let s; if (Array.isArray(v)) s = v.map(String).join(','); else if (v !== null && v !== undefined) s = String(v); else s = '';
      return `${k}=${pyQuote(s, ',')}`;
    }).join('&');
  }
  async function readJsonResponse(resp) {
    let data;
    try {
      data = await resp.json();
    } catch {
      data = { success: false, msg: `HTTP ${resp.status} returned a non-JSON response` };
    }
    if (!resp.ok) {
      return { ...data, success: false, http_status: resp.status };
    }
    return data;
  }
  async function fetchSpiderV3Dsl(nowMs = Date.now()) {
    if (spiderV3DslCache.value && spiderV3DslCache.expiresAt > nowMs) {
      return spiderV3DslCache.value;
    }
    try {
      const response = await fetch(SPIDER_V3_DSL_URL, {
        method: 'GET',
        headers: {
          accept: '*/*',
          referer: WWW + '/',
          'user-agent': SPIDER_V3.userAgent,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      const match = source.match(/function\s+getdss\s*\(\s*\)\s*\{\s*return\s*['"](\d{13})['"]/);
      if (!match) throw new Error('getdss timestamp was not found');
      spiderV3DslCache = { value: match[1], expiresAt: nowMs + SPIDER_V3_DSL_TTL_MS };
      return match[1];
    } catch (error) {
      if (spiderV3DslCache.value) return spiderV3DslCache.value;
      throw new Error(`Spider v3 DSL unavailable: ${error?.message || error}`);
    }
  }

  function spiderV3RequestHeaders(cookieStr, strategy, signedHeaders) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      origin: WWW,
      referer: WWW + '/',
      priority: 'u=1, i',
      'user-agent': SPIDER_V3.userAgent,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      cookie: cookieStr,
      ...signedHeaders,
    };
    if (strategy === 'browser-hints' || strategy === 'legacy-transport') {
      headers['sec-ch-ua'] = SPIDER_V3.secChUa;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
    }
    if (strategy === 'legacy-transport') headers['x-mns'] = 'unload';
    return headers;
  }

  async function experimentalComments(cookieStr, body) {
    const strategy = String(body.strategy || 'no-client-hints');
    if (!SPIDER_V3_STRATEGIES.has(strategy)) {
      return {
        success: false,
        error: `Unknown Spider v3 strategy: ${strategy}`,
        error_code: 'XHS_EXPERIMENT_INVALID_STRATEGY',
        allowed_strategies: Array.from(SPIDER_V3_STRATEGIES),
      };
    }
    const noteId = String(body.feed_id || body.note_id || '').trim();
    if (!noteId) {
      return {
        success: false,
        error: 'feed_id is required',
        error_code: 'XHS_EXPERIMENT_MISSING_FEED_ID',
      };
    }
    const cookieDict = parseCookies(cookieStr);
    const now = Date.now();
    const state = await normalizeSpiderV3State(cookieDict, body.session_state, now);
    const stateWasReset = state.reset;
    let dsl;
    try {
      dsl = await fetchSpiderV3Dsl(now);
    } catch (error) {
      const sessionState = { ...state };
      delete sessionState.reset;
      return {
        success: false,
        error: error?.message || String(error),
        error_code: 'XHS_EXPERIMENT_DSL_UNAVAILABLE',
        upstream_requests: { dsl: 1, comments: 0 },
        retry_performed: false,
        session_state: sessionState,
      };
    }
    const params = {
      note_id: noteId,
      cursor: String(body.cursor || ''),
      top_comment_id: String(body.top_comment_id || ''),
      image_formats: 'jpg,webp,avif',
      xsec_token: String(body.xsec_token || ''),
    };
    const uri = '/api/sns/web/v2/comment/page';
    const api = `${uri}?${buildSignedQuery(params)}`;
    const signed = signSpiderV3Comment(api, cookieDict, state, dsl);
    const experiment = {
      name: 'spider-session-v3',
      strategy,
      state_reset: stateWasReset,
      retry_performed: false,
      signature: signed.debug,
    };
    if (body.dry_run === true) {
      return {
        success: true,
        dry_run: true,
        experiment,
        upstream_requests: { dsl: 1, comments: 0 },
        session_state: signed.state,
      };
    }
    const response = await fetch(EDITH + api, {
      method: 'GET',
      headers: spiderV3RequestHeaders(cookieStr, strategy, signed.headers),
    });
    let raw;
    try {
      raw = await response.json();
    } catch {
      raw = { success: false, msg: `HTTP ${response.status} returned a non-JSON response` };
    }
    if (response.status === 406) {
      return {
        success: false,
        error: raw?.msg || 'XHS rejected the isolated comment request with HTTP 406',
        error_code: 'XHS_EXPERIMENT_HTTP_406',
        http_status: 406,
        circuit_open: true,
        retry_performed: false,
        upstream_requests: { dsl: 1, comments: 1 },
        experiment,
        session_state: signed.state,
      };
    }
    if (!response.ok || raw?.success === false) {
      return {
        success: false,
        error: raw?.msg || `XHS comment request failed with HTTP ${response.status}`,
        error_code: 'XHS_EXPERIMENT_UPSTREAM_REJECTED',
        http_status: response.status,
        circuit_open: false,
        retry_performed: false,
        upstream_requests: { dsl: 1, comments: 1 },
        experiment,
        session_state: signed.state,
      };
    }
    const comments = Array.isArray(raw?.data?.comments) ? raw.data.comments.map(normComment) : [];
    return {
      success: true,
      data: {
        comments: {
          list: comments,
          cursor: raw?.data?.cursor || '',
          has_more: !!raw?.data?.has_more,
        },
        comments_status: 'loaded',
        comments_provider: 'spider-session-v3',
      },
      upstream_requests: { dsl: 1, comments: 1 },
      experiment,
      session_state: signed.state,
    };
  }

  async function signedGet(base, uri, params, cookieStr, ck, extraHeaders = {}, signFormat = 'xys', useXrap = false) {
    const query = buildSignedQuery(params);
    const sig = await signHeaders('GET', uri, ck, { params: params || {}, signFormat });
    const requestUri = uri + (query ? '?' + query : '');
    const xrapHeader = useXrap
      ? { 'x-rap-param': await xRapParam(`//${new URL(base).host}${requestUri}`, '') }
      : {};
    const resp = await fetch(base + requestUri, { method: 'GET', headers: { ...baseHeaders(cookieStr, base), ...sig, ...xrapHeader, ...extraHeaders } });
    return readJsonResponse(resp);
  }
  async function signedPost(base, uri, payload, cookieStr, ck, extraHeaders = {}, useXrap = false) {
    const sig = await signHeaders('POST', uri, ck, { payload });
    const xrapHeader = useXrap
      ? { 'x-rap-param': await xRapParam(`//${new URL(base).host}${uri}`, payload) }
      : {};
    const resp = await fetch(base + uri, { method: 'POST', headers: { ...baseHeaders(cookieStr, base), ...sig, ...xrapHeader, ...extraHeaders }, body: JSON.stringify(payload) });
    return readJsonResponse(resp);
  }

  function pickCover(nc) {
    const cover = nc?.cover || {};
    const url = cover.url_default || cover.url_pre || cover.url || (cover.info_list?.[0]?.url) || '';
    return url ? url.replace(/^http:\/\//, 'https://') : '';
  }
  function normItem(item) {
    const nc = item.note_card || item.noteCard || item;
    const user = nc.user || {};
    const interact = nc.interact_info || nc.interactInfo || {};
    const liked = interact.liked_count ?? interact.likedCount ?? 0;
    const id = item.id || nc.note_id || nc.id || '';
    const token = item.xsec_token || nc.xsec_token || '';
    return {
      id, note_id: id, noteId: id, xsec_token: token, xsecToken: token,
      title: nc.display_title || nc.title || '', display_title: nc.display_title || nc.title || '',
      desc: nc.desc || '', type: nc.type || item.model_type || '',
      user: { nickname: user.nickname || user.nick_name || '', user_id: user.user_id || user.userId || '' },
      nickname: user.nickname || '', author: user.nickname || '', authorId: user.user_id || '',
      interact_info: { liked_count: String(liked) }, liked_count: String(liked),
      cover: { url_default: pickCover(nc) },
    };
  }
  function normComment(c) {
    const u = c.user_info || c.userInfo || c.user || {};
    const id = c.id || c.comment_id || c.commentId || '';
    const replies = Array.isArray(c.sub_comments) ? c.sub_comments
      : Array.isArray(c.subComments) ? c.subComments
      : Array.isArray(c.replies) ? c.replies
      : [];
    return {
      id, comment_id: id, commentId: id, content: c.content || c.text || '',
      nickname: u.nickname || u.name || '', author_name: u.nickname || u.name || '',
      user: { nickname: u.nickname || u.name || '', user_id: u.user_id || u.userId || '' },
      like_count: c.like_count ?? c.likeCount ?? c.likes ?? '0',
      likes: c.like_count ?? c.likeCount ?? c.likes ?? '0',
      sub_comments: replies.map(normComment),
    };
  }

  function findCommentArray(value, depth = 0) {
    if (depth > 5 || value == null) return null;
    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      const first = value[0];
      if (first && typeof first === 'object' &&
          (first.content != null || first.comment_id || first.commentId || first.id)) {
        return value;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    for (const key of ['comments', 'comment_list', 'commentList', 'items', 'list']) {
      const found = findCommentArray(value[key], depth + 1);
      if (found) return found;
    }
    for (const key of ['data', 'result', 'response']) {
      const found = findCommentArray(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function getRnoteComments(feedId, env, requestApiKey) {
    const apiKey = requestApiKey || (env && env.RNOTE_API_KEY);
    if (!apiKey) return null;

    const providerUrl = new URL('https://rnote.dev/api/v2/crawler/note/comments');
    providerUrl.searchParams.set('note_id', feedId);
    providerUrl.searchParams.set('index', '0');
    providerUrl.searchParams.set('pageArea', 'UNFOLDED');
    providerUrl.searchParams.set('sort_strategy', 'like_count');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(providerUrl.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-API-Key': apiKey,
        },
        signal: controller.signal,
      });
      const body = await readJsonResponse(resp);
      if (!resp.ok || body?.success === false) {
        return {
          success: false,
          error: {
            status: resp.status,
            code: body?.debug_id || 'COMMENT_PROVIDER_REJECTED',
            message: body?.error || body?.message || `真实评论服务 HTTP ${resp.status}`,
          },
        };
      }
      const rawComments = findCommentArray(body?.data ?? body) || [];
      return {
        success: true,
        comments: rawComments.map(normComment).filter((comment) => comment.content),
        provider: 'rnote',
      };
    } catch (e) {
      return {
        success: false,
        error: {
          code: e?.name === 'AbortError' ? 'COMMENT_PROVIDER_TIMEOUT' : 'COMMENT_PROVIDER_FAILED',
          message: e instanceof Error ? e.message : String(e),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getManagedComments(feedId, env, requestRnoteApiKey) {
    const rnoteConfigured = !!(requestRnoteApiKey || env?.RNOTE_API_KEY);
    if (!rnoteConfigured) {
      return {
        success: false,
        error: {
          code: 'COMMENT_PROVIDER_NOT_CONFIGURED',
          message: '真实评论服务尚未配置',
        },
      };
    }

    const cacheKey = new Request(`https://sullyos.invalid/_xhs-comments/${encodeURIComponent(feedId)}`);
    const cache = globalThis.caches && globalThis.caches.default;
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        return {
          success: true,
          comments: data.comments || [],
          provider: data.provider || 'managed-cache',
          cached: true,
        };
      }
    }

    const result = await getRnoteComments(feedId, env, requestRnoteApiKey);
    if (result?.success) {
      const comments = result.comments || [];
      if (cache) {
        const cacheResponse = new Response(JSON.stringify({
          comments,
          provider: result.provider,
        }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        });
        await cache.put(cacheKey, cacheResponse);
      }
      return { ...result, comments, cached: false };
    }
    return result || {
      success: false,
      error: { code: 'COMMENT_PROVIDER_NOT_CONFIGURED', message: '真实评论服务尚未配置' },
    };
  }

  async function checkLoginOnPlatform(cookieStr, platform) {
    const config = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    let r = await signedGet(config.apiBase, '/api/sns/web/v2/user/me', null, cookieStr, ck);
    let root = r?.data || {};
    let d = root.user_info || root.userInfo || root.user || root;
    let sessionOk = !!(r?.success && (
      d.user_id
      || d.userId
      || root.user_id
      || root.userId
      || d.guest === false
      || root.guest === false
      || d.logged_in === true
      || d.loggedIn === true
    ));
    // The global backend has also shipped /v1/user/selfinfo. Its login bit is
    // nested under data.result.success, so use it as a RedNote-only fallback.
    if (!sessionOk && config.key === 'rednote') {
      const selfInfo = await signedGet(config.apiBase, '/api/sns/web/v1/user/selfinfo', null, cookieStr, ck);
      const selfRoot = selfInfo?.data || {};
      const selfResult = selfRoot.result || {};
      if (selfResult.success === true) {
        r = selfInfo;
        root = selfRoot;
        d = selfResult.user_info || selfResult.userInfo || selfResult.user || selfResult;
        sessionOk = true;
      }
    }
    const userId = d.user_id || d.userId || root.user_id || root.userId || '';
    return {
      logged_in: sessionOk,
      nickname: d.nickname || d.nick_name || root.nickname || '',
      user_id: userId,
      red_id: d.red_id || d.redId || root.red_id || '',
      platform: config.key,
      api_host: new URL(config.apiBase).host,
      web_host: new URL(config.webBase).host,
      raw: r,
    };
  }
  async function checkLogin(cookieStr, requestedPlatform = 'auto') {
    const requested = normalizePlatform(requestedPlatform);
    const cached = requested === 'auto' ? getCachedPlatform(cookieStr) : '';
    const candidates = requested === 'auto'
      ? [...new Set([cached, 'xhs', 'rednote'].filter(Boolean))]
      : [requested];
    let lastResult = null;
    for (const platform of candidates) {
      const result = await checkLoginOnPlatform(cookieStr, platform);
      lastResult = result;
      if (result.logged_in) {
        cachePlatform(cookieStr, platform);
        return result;
      }
    }
    clearCachedPlatform(cookieStr);
    return {
      ...(lastResult || {}),
      logged_in: false,
      platform: requested === 'auto' ? undefined : requested,
      checked_platforms: candidates,
    };
  }
  async function resolvePlatform(cookieStr, requestedPlatform = 'auto') {
    const requested = normalizePlatform(requestedPlatform);
    if (requested !== 'auto') return { platform: requested, login: null };
    const cached = getCachedPlatform(cookieStr);
    if (cached) return { platform: cached, login: null };
    const login = await checkLogin(cookieStr, 'auto');
    return { platform: login.platform || '', login };
  }
  async function listFeeds(cookieStr, { category = 'homefeed_recommend', cursorScore = '', noteIndex = 0, refreshType = 1 } = {}, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { cursor_score: cursorScore, num: 20, refresh_type: refreshType, note_index: noteIndex, unread_begin_note_id: '', unread_end_note_id: '', unread_note_count: 0, category, search_key: '', need_num: 10, image_formats: IMG_FORMATS, need_filter_image: false };
    const r = await signedPost(apiBase, '/api/sns/web/v1/homefeed', payload, cookieStr, ck);
    return { feeds: (r?.data?.items || []).map(normItem), cursor_score: r?.data?.cursor_score, success: !!r?.success, msg: r?.msg, raw_error: r?.success ? undefined : r };
  }
  const SORT_MAP = { general: 'general', time: 'time_descending', hot: 'popularity_descending', comment: 'comment_descending', collect: 'collect_descending' };
  function genSearchId() {
    const big = (BigInt(Date.now()) << 64n) + BigInt(Math.ceil(0x7ffffffe * Math.random()));
    const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
    let n = big, s = ''; if (n === 0n) return '0';
    while (n > 0n) { s = B36[Number(n % 36n)] + s; n /= 36n; }
    return s;
  }
  async function search(cookieStr, keyword, { page = 1, sort = 'general' } = {}, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const st = SORT_MAP[sort] || 'general';
    const payload = { keyword, page, page_size: 20, search_id: genSearchId(), sort: st, note_type: 0, ext_flags: [],
      filters: [{ tags: [st], type: 'sort_type' }, { tags: ['不限'], type: 'filter_note_type' }, { tags: ['不限'], type: 'filter_note_time' }, { tags: ['不限'], type: 'filter_note_range' }, { tags: ['不限'], type: 'filter_pos_distance' }],
      geo: '', image_formats: IMG_FORMATS };
    const r = await signedPost(apiBase, '/api/sns/web/v1/search/notes', payload, cookieStr, ck);
    const items = (r?.data?.items || []).filter((it) => it.id && (it.note_card || it.model_type === 'note'));
    return { feeds: items.map(normItem), success: !!r?.success, msg: r?.msg, raw_error: r?.success ? undefined : r };
  }
  async function getFeedDetail(cookieStr, feedId, xsecToken, {
    xsecSource = 'pc_feed',
    loadComments = true,
    env,
    requestRnoteApiKey,
    platform = 'xhs',
  } = {}) {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { source_note_id: feedId, image_formats: IMG_FORMATS, extra: { need_body_topic: '1' }, xsec_source: xsecSource || 'pc_feed', xsec_token: xsecToken || '' };
    const r = await signedPost(apiBase, '/api/sns/web/v1/feed', payload, cookieStr, ck, { 'xy-direction': '13' });
    const nc = r?.data?.items?.[0]?.note_card || {};
    const note = { note_id: feedId, title: nc.title || '', content: nc.desc || '', desc: nc.desc || '', user: nc.user || {}, interact_info: nc.interact_info || {}, image_list: nc.image_list || [], xsec_token: xsecToken || '' };
    const embeddedComments = findCommentArray(nc?.comments) || [];
    let comments = embeddedComments.map(normComment).filter((comment) => comment.content);
    let commentsStatus = comments.length ? 'loaded' : 'not_requested';
    let commentsError;
    let commentsProvider;
    if (loadComments && comments.length === 0) {
      const managed = await getManagedComments(feedId, env, requestRnoteApiKey);
      if (managed.success) {
        comments = managed.comments;
        commentsProvider = managed.provider;
        commentsStatus = comments.length ? 'loaded' : 'empty';
      } else {
        commentsStatus = 'unavailable';
        commentsError = managed.error;
      }
    }
    return {
      data: {
        note,
        comments: { list: comments },
        comments_status: commentsStatus,
        comments_provider: commentsProvider,
        comments_error: commentsError,
      },
      success: !!r?.success,
      msg: r?.msg,
      raw_error: r?.success ? undefined : r,
    };
  }
  async function userProfile(cookieStr, userId, xsecToken, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    let info = null;
    let infoError = '';
    try {
      info = await signedGet(apiBase, '/api/sns/web/v1/user/otherinfo', { target_user_id: userId }, cookieStr, ck);
      if (!info?.success) infoError = info?.msg || `HTTP ${info?.http_status || 'unknown'}`;
    } catch (e) {
      infoError = e?.message || String(e);
    }
    let notes = [];
    let notesLoaded = false;
    let notesError = '';
    try {
      // Spider_XHS 将 user_posted 列入 RAP 白名单；GET 的 RAP 摘要包含完整 query，body 为空串。
      const posted = await signedGet(apiBase, '/api/sns/web/v1/user_posted', { num: 30, cursor: '', user_id: userId, image_formats: 'jpg,webp,avif', xsec_token: xsecToken || '', xsec_source: 'pc_user' }, cookieStr, ck, {}, 'xys', true);
      notesLoaded = !!posted?.success;
      notes = (posted?.data?.notes || []).map(normItem);
      if (!notesLoaded) notesError = posted?.msg || `HTTP ${posted?.http_status || 'unknown'}`;
    } catch (e) {
      notesError = e?.message || String(e);
    }
    if (!info?.success && !notesLoaded) {
      return { error: `获取主页失败: ${notesError || infoError || '上游未返回成功状态'}` };
    }
    return {
      basic_info: info?.data?.basic_info || {},
      notes,
      feeds: notes,
      success: true,
      profile_status: info?.success ? 'loaded' : 'unavailable',
      profile_error: info?.success ? undefined : infoError,
      notes_status: notesLoaded ? 'loaded' : 'unavailable',
      notes_error: notesLoaded ? undefined : notesError,
    };
  }
  async function likeFeed(cookieStr, feedId, unlike = false, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const r = await signedPost(apiBase, unlike ? '/api/sns/web/v1/note/dislike' : '/api/sns/web/v1/note/like', { note_oid: feedId }, cookieStr, ck);
    return { success: !!r?.success, msg: r?.msg, raw: r };
  }
  async function favoriteFeed(cookieStr, feedId, unfavorite = false, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const r = await signedPost(apiBase, unfavorite ? '/api/sns/web/v1/note/uncollect' : '/api/sns/web/v1/note/collect', unfavorite ? { note_ids: feedId } : { note_id: feedId }, cookieStr, ck);
    return { success: !!r?.success, msg: r?.msg, raw: r };
  }
  async function postComment(cookieStr, feedId, content, { targetCommentId = null, xsecToken = '', platform = 'xhs' } = {}) {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { note_id: feedId, content, at_users: [] };
    if (xsecToken) payload.xsec_token = xsecToken;
    if (targetCommentId) payload.target_comment_id = targetCommentId;
    // Spider_XHS 的 RAP 白名单同样包含 comment/post。
    const r = await signedPost(apiBase, '/api/sns/web/v1/comment/post', payload, cookieStr, ck, {}, true);
    if (!r?.success) {
      return { error: `评论失败: ${r?.msg || `HTTP ${r?.http_status || 'unknown'}`}`, raw: r };
    }
    return { success: true, msg: r?.msg, comment: r?.data?.comment, raw: r };
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function hmacSha1Hex(key, msg) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function cosUploadSignature(message, fileId, contentLength, host) {
    host = host || 'ros-upload.xiaohongshu.com';
    const signKey = await hmacSha1Hex('null', message);
    const params = await sha1Hex(`put\n/spectrum/${fileId}\n\ncontent-length=${contentLength}&host=${host}\n`);
    return hmacSha1Hex(signKey, `sha1\n${message}\n${params}\n`);
  }
  function imageSize(buf) {
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50) { const dv = new DataView(buf.buffer); return { width: dv.getUint32(16), height: dv.getUint32(20) }; }
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        let o = 2;
        while (o < buf.length) {
          if (buf[o] !== 0xff) { o++; continue; }
          const marker = buf[o + 1];
          if (marker >= 0xc0 && marker <= 0xc3) { const dv = new DataView(buf.buffer); return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) }; }
          o += 2 + ((buf[o + 2] << 8) | buf[o + 3]);
        }
      }
      if (buf[8] === 0x57 && buf[9] === 0x45 && buf[12] === 0x56 && buf[15] === 0x20) {
        return { width: ((buf[27] << 8) | buf[26]) & 0x3fff, height: ((buf[29] << 8) | buf[28]) & 0x3fff };
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  // 上传凭证：不同登录态/版本接口名不同，依次尝试，取第一个成功的
  async function getUploadPermit(cookieStr, ck) {
    const params = { biz_name: 'spectrum', scene: 'image', file_count: '1', version: '1', source: 'web' };
    const candidates = [
      { host: EDITH, path: '/api/media/v1/upload/web/permit', origin: WWW, referer: WWW + '/' },
      { host: CREATOR, path: '/api/media/v1/upload/creator/permit', origin: CREATOR, referer: CREATOR + '/publish/publish' },
      { host: EDITH, path: '/api/media/v1/upload/creator/permit', origin: CREATOR, referer: CREATOR + '/publish/publish' },
      { host: CREATOR, path: '/api/media/v1/upload/web/permit', origin: WWW, referer: WWW + '/' },
    ];
    let lastErr = '';
    for (const c of candidates) {
      try {
        const sig = signHeaders('GET', c.path, ck, { params });
        const resp = await fetch(c.host + c.path + '?' + buildSignedQuery(params), { method: 'GET', headers: { ...baseHeaders(cookieStr), ...sig, origin: c.origin, referer: c.referer } });
        const j = await resp.json().catch(() => ({}));
        const permit = j?.data?.uploadTempPermits?.[0];
        if (permit) return { permit, xt: sig['x-t'] };
        lastErr = `${c.path}@${c.host.replace('https://', '')} -> ${JSON.stringify(j).slice(0, 120)}`;
      } catch (e) { lastErr = `${c.path}: ${e.message}`; }
    }
    throw new Error('获取上传凭证失败（已试多种接口）: ' + lastErr);
  }
  async function uploadImageFromUrl(cookieStr, ck, imgUrl) {
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`图片下载失败 ${imgResp.status}: ${imgUrl}`);
    const buf = new Uint8Array(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get('content-type') || 'image/png';
    const { width, height } = imageSize(buf) || { width: 1080, height: 1080 };
    const { permit, xt } = await getUploadPermit(cookieStr, ck);
    const fileIds = permit.fileIds[0].split('/').pop();
    const uploadAddr = permit.uploadAddr || 'ros-upload.xiaohongshu.com';
    const uploadHost = uploadAddr.replace(/^https?:\/\//, '');
    const uploadBase = uploadAddr.startsWith('http') ? uploadAddr : `https://${uploadAddr}`;
    const message = `${String(xt).slice(0, 10)};${String(permit.expireTime).slice(0, 10)}`;
    const signature = await cosUploadSignature(message, fileIds, buf.length, uploadHost);
    const putResp = await fetch(`${uploadBase}/spectrum/${fileIds}`, {
      method: 'PUT',
      headers: { accept: '*/*', authorization: `q-sign-algorithm=sha1&q-ak=null&q-sign-time=${message}&q-key-time=${message}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`, origin: CREATOR, referer: CREATOR + '/', 'user-agent': UA, 'x-cos-security-token': permit.token, cookie: cookieStr },
      body: buf,
    });
    if (!putResp.ok) throw new Error(`图片上传失败 ${putResp.status}`);
    return { fileIds, width, height, file_size: buf.length, mime_type: mime };
  }
  function buildImageNoteData(title, desc, privacyType, fileInfos, hashTags) {
    const images = fileInfos.map((f) => ({
      file_id: `spectrum/${f.fileIds}`, width: f.width, height: f.height, metadata: { source: -1 }, stickers: { version: 2, floating: [] },
      extra_info_json: JSON.stringify({ mimeType: f.mime_type || 'image/png', image_metadata: { bg_color: '', origin_size: (f.file_size || 0) / 1024 } }),
    }));
    const contextJson = JSON.stringify({ recommend_title: { recommend_title_id: '', is_use: 3, used_index: -1 }, recommendTitle: [], recommend_topics: { used: [] } });
    return {
      common: { type: 'normal', title, note_id: '', desc, source: '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\",\\"systemId\\":\\"web\\"}"}', ats: [], hash_tag: hashTags, post_loc: {}, privacy_info: { op_type: 1, type: privacyType, user_ids: [] }, goods_info: {}, biz_relations: [], capa_trace_info: { contextJson } },
      image_info: { images }, video_info: null,
    };
  }
  async function publishNote(cookieStr, { title = '', content = '', images = [], tags = [], isPrivate = false }) {
    const ck = parseCookies(cookieStr);
    const fileInfos = [];
    for (const imgUrl of images) fileInfos.push(await uploadImageFromUrl(cookieStr, ck, imgUrl));
    if (!fileInfos.length) return { error: '小红书发帖至少需要一张图片，请提供 images（图床 URL 数组）' };
    let desc = content;
    const hashTags = [];
    for (const t of tags) { const name = String(t).replace(/^#/, ''); desc += ` #${name}[话题]#`; hashTags.push({ id: '', link: '', name, type: 'topic' }); }
    const r = await signedPost(EDITH, '/web_api/sns/v2/note', buildImageNoteData(title, desc, isPrivate ? 1 : 0, fileInfos, hashTags), cookieStr, ck);
    const noteId = r?.data?.id || r?.data?.note_id || r?.data?.note?.id || '';
    // 失败用 error 字段：bridgePost 会据此判定 success=false（无需改 useChatAI）
    if (!(r?.success && noteId)) {
      return { error: `发布失败（小红书未确认）: ${JSON.stringify(r).slice(0, 300)}` };
    }
    return { success: true, note_id: noteId, noteId, msg: '发布成功', raw: r };
  }

  async function handle(command, body, cookie, env, requestContext = {}) {
    const requestedPlatform = requestContext.platform || body.platform || 'auto';
    if (command === 'check-login') return checkLogin(cookie, requestedPlatform);

    const resolved = await resolvePlatform(cookie, requestedPlatform);
    if (!resolved.platform) {
      return {
        error: '这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。',
        checked_platforms: resolved.login?.checked_platforms || ['xhs', 'rednote'],
      };
    }
    const platform = resolved.platform;
    let result;
    switch (command) {
      case 'search': result = await search(cookie, body.keyword || '', { sort: body.sort_by, page: body.page }, platform); break;
      case 'list-feeds': result = await listFeeds(cookie, { category: body.category, cursorScore: body.cursor_score, noteIndex: body.note_index }, platform); break;
      case 'get-feed-detail': result = await getFeedDetail(cookie, body.feed_id, body.xsec_token, {
        xsecSource: body.xsec_source,
        loadComments: body.load_all_comments !== false,
        env,
        requestRnoteApiKey: requestContext.rnoteApiKey,
        platform,
      }); break;
      case 'xhs-experimental-comments':
        result = platform === 'rednote'
          ? { error: 'Spider v3 评论实验目前只支持 xiaohongshu.com 国内后端。' }
          : await experimentalComments(cookie, body);
        break;
      case 'post-comment': result = await postComment(cookie, body.feed_id, body.content, { xsecToken: body.xsec_token, platform }); break;
      case 'reply-comment': result = await postComment(cookie, body.feed_id, body.content, { targetCommentId: body.comment_id, xsecToken: body.xsec_token, platform }); break;
      case 'like-feed': result = await likeFeed(cookie, body.feed_id, !!body.unlike, platform); break;
      case 'favorite-feed': result = await favoriteFeed(cookie, body.feed_id, !!body.unfavorite, platform); break;
      case 'user-profile': result = await userProfile(cookie, body.user_id, body.xsec_token, platform); break;
      case 'publish':
        result = platform === 'rednote'
          ? { error: 'RedNote 全球后端的图片发布链路尚未验证；搜索、浏览、详情和互动已支持。' }
          : await publishNote(cookie, { title: body.title, content: body.content, images: body.images || [], tags: body.tags || [], isPrivate: body.visibility === 'private' || !!body.is_private });
        break;
      case 'login': result = { error: 'lite 模式用 cookie 登录，无需扫码。请在设置里粘贴 cookie。' }; break;
      case 'get-qrcode': result = { error: 'lite 模式不支持二维码登录，请粘贴 cookie。' }; break;
      case 'delete-cookies': result = { ok: true }; break;
      case 'publish-video': result = { error: '视频发布暂未在 lite 模式实现。' }; break;
      case 'long-article': result = { error: '长文发布暂未在 lite 模式实现。' }; break;
      default: return null;
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ...result, platform };
    return result;
  }

  return {
    handle,
    __test: {
      RNG,
      signXs,
      signXyw,
      signXsCommon,
      generateB1,
      xRapParam,
      spiderV3: {
        normalizeState: normalizeSpiderV3State,
        signComment: signSpiderV3Comment,
        generateB1: generateSpiderV3B1,
        parseCookies,
        resetDslCache() { spiderV3DslCache = { value: '', expiresAt: 0 }; },
        resetPlatformCache() { platformCache.clear(); },
      },
      _internals: { md5Hex, encodeCustomStr, crc32JsInt, xrapEncryptBlock, xrapXxh32 },
    },
  };
})();

// ============================================================================
//  第 2 部分：MCP 服务器层
//  把上面的核心包成标准 MCP 服务器（JSON-RPC 2.0），供 ai-virtual-phone 的
//  MCP 客户端（lib/tool-executor.ts）自动发现与调用。
// ============================================================================

const SERVER_INFO = { name: "xhs-mcp", version: "1.1.0" };
// 客户端会把单次工具结果截到 2000 字符，这里主动压到 1800 以内，保证不丢尾巴。
const MAX_TEXT = 1800;

// ── 工具清单 ────────────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: "xhs_check_login",
        description: "检查小红书登录态是否有效，返回当前登录账号昵称。调其它工具报错时先用它确认 cookie 过期没有。",
        inputSchema: { type: "object", properties: {}, required: [] },
        command: "check-login",
        build: () => ({}),
    },
    {
        name: "xhs_search",
        description: "按关键词搜索小红书笔记，返回笔记列表（含 note_id 与 xsec_token）。看详情或评论前先搜索，把这里返回的 xsec_token 传给后续工具。",
        inputSchema: {
            type: "object",
            properties: {
                keyword: { type: "string", description: "搜索关键词" },
                sort_by: { type: "string", description: "排序方式：general 综合 / time_descending 最新 / popularity_descending 最热" },
                page: { type: "number", description: "页码，默认 1" },
            },
            required: ["keyword"],
        },
        command: "search",
        build: a => ({ keyword: a.keyword, sort_by: a.sort_by, page: a.page }),
    },
    {
        name: "xhs_list_feeds",
        description: "获取小红书首页推荐流，相当于「刷小红书」。返回笔记列表（含 note_id 与 xsec_token）。",
        inputSchema: {
            type: "object",
            properties: {
                category: { type: "string", description: "可选分类，如 food / travel / fashion，不填为综合推荐" },
                cursor_score: { type: "string", description: "翻页游标，用上次返回的 cursor_score" },
            },
            required: [],
        },
        command: "list-feeds",
        build: a => ({ category: a.category, cursor_score: a.cursor_score }),
    },
    {
        name: "xhs_get_feed_detail",
        description: "查看一篇小红书笔记的正文与评论。必须提供 note_id，强烈建议同时提供搜索时拿到的 xsec_token，否则拿不到评论区。",
        inputSchema: {
            type: "object",
            properties: {
                feed_id: { type: "string", description: "笔记 ID（note_id）" },
                xsec_token: { type: "string", description: "该笔记的 xsec_token，来自搜索/首页/主页的返回结果" },
            },
            required: ["feed_id"],
        },
        command: "get-feed-detail",
        build: a => ({ feed_id: a.feed_id, xsec_token: a.xsec_token, load_all_comments: true }),
    },
    {
        name: "xhs_post_comment",
        description: "在一篇笔记下发表评论。必须提供 note_id 与对应的 xsec_token，否则小红书会拒绝。",
        inputSchema: {
            type: "object",
            properties: {
                feed_id: { type: "string", description: "笔记 ID" },
                content: { type: "string", description: "评论内容" },
                xsec_token: { type: "string", description: "该笔记的 xsec_token" },
            },
            required: ["feed_id", "content"],
        },
        command: "post-comment",
        build: a => ({ feed_id: a.feed_id, content: a.content, xsec_token: a.xsec_token }),
    },
    {
        name: "xhs_reply_comment",
        description: "回复某条已有评论。需要提供笔记 ID、被回复评论的 comment_id，以及该笔记的 xsec_token。",
        inputSchema: {
            type: "object",
            properties: {
                feed_id: { type: "string", description: "笔记 ID" },
                comment_id: { type: "string", description: "被回复评论的 ID" },
                content: { type: "string", description: "回复内容" },
                xsec_token: { type: "string", description: "该笔记的 xsec_token" },
            },
            required: ["feed_id", "comment_id", "content"],
        },
        command: "reply-comment",
        build: a => ({ feed_id: a.feed_id, comment_id: a.comment_id, content: a.content, xsec_token: a.xsec_token }),
    },
    {
        name: "xhs_like_feed",
        description: "给笔记点赞或取消点赞。",
        inputSchema: {
            type: "object",
            properties: {
                feed_id: { type: "string", description: "笔记 ID" },
                unlike: { type: "boolean", description: "true 表示取消点赞，默认 false" },
            },
            required: ["feed_id"],
        },
        command: "like-feed",
        build: a => ({ feed_id: a.feed_id, unlike: a.unlike === true }),
    },
    {
        name: "xhs_favorite_feed",
        description: "收藏笔记或取消收藏。",
        inputSchema: {
            type: "object",
            properties: {
                feed_id: { type: "string", description: "笔记 ID" },
                unfavorite: { type: "boolean", description: "true 表示取消收藏，默认 false" },
            },
            required: ["feed_id"],
        },
        command: "favorite-feed",
        build: a => ({ feed_id: a.feed_id, unfavorite: a.unfavorite === true }),
    },
    {
        name: "xhs_user_profile",
        description: "查看某个小红书用户的主页信息与 TA 的笔记列表。",
        inputSchema: {
            type: "object",
            properties: {
                user_id: { type: "string", description: "用户 ID" },
                xsec_token: { type: "string", description: "可选，用户主页的 xsec_token" },
            },
            required: ["user_id"],
        },
        command: "user-profile",
        build: a => ({ user_id: a.user_id, xsec_token: a.xsec_token }),
    },
    {
        name: "xhs_publish",
        description: "发布一篇小红书图文笔记。至少需要一张图片（传公网可访问的图片 URL）。",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "标题" },
                content: { type: "string", description: "正文" },
                images: { type: "array", items: { type: "string" }, description: "图片 URL 数组，至少一张" },
                tags: { type: "array", items: { type: "string" }, description: "话题标签，如 [\"日常\",\"美食\"]" },
                visibility: { type: "string", description: "public 公开 / private 仅自己可见，默认 public" },
            },
            required: ["title", "content", "images"],
        },
        command: "publish",
        build: a => ({
            title: a.title,
            content: a.content,
            images: Array.isArray(a.images) ? a.images : [],
            tags: Array.isArray(a.tags) ? a.tags : [],
            visibility: a.visibility,
        }),
    },
];

const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extraHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(extraHeaders || {}) },
    });
}

function rpcResult(id, result) {
    return json({ jsonrpc: "2.0", id: id === undefined ? null : id, result });
}

function rpcError(id, code, message, data) {
    return json({
        jsonrpc: "2.0",
        id: id === undefined ? null : id,
        error: { code, message, ...(data ? { data } : {}) },
    });
}

// ── 结果渲染（压到 MAX_TEXT 以内）────────────────────────────────────────────

function clipLines(header, lines, footer) {
    const out = [header];
    let used = header.length;
    let shown = 0;
    for (const line of lines) {
        if (used + line.length + 1 > MAX_TEXT - 60) break;
        out.push(line);
        used += line.length + 1;
        shown += 1;
    }
    if (shown < lines.length) out.push(`…（还有 ${lines.length - shown} 条未显示，可翻页或缩小关键词）`);
    if (footer) out.push(footer);
    return out.join("\n");
}

function oneLine(text, max) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + "…" : s;
}

function pickNotes(payload) {
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.feeds)) return payload.feeds;
    if (Array.isArray(payload.notes)) return payload.notes;
    const d = payload.data;
    if (d && typeof d === "object") {
        if (Array.isArray(d.feeds)) return d.feeds;
        if (Array.isArray(d.notes)) return d.notes;
    }
    return [];
}

function renderNote(note, index) {
    const id = note.note_id || note.noteId || note.id || "";
    const title = oneLine(note.display_title || note.title || note.desc || "", 38);
    const author = note.author || note.nickname || (note.user && (note.user.nickname || note.user.name)) || "";
    const likes = note.liked_count || (note.interact_info && note.interact_info.liked_count) || "0";
    const token = note.xsec_token || note.xsecToken || "";
    let line = `${index}. [${id}] ${title} | 作者:${author} | 赞:${likes}`;
    if (token) line += `\n   xsec_token: ${token}`;
    return line;
}

function renderNotes(payload, label) {
    const notes = pickNotes(payload);
    if (notes.length === 0) {
        const hint = payload && payload.error ? payload.error : (payload && payload.msg ? `小红书返回：${oneLine(payload.msg, 120)}` : "");
        return `${label}没有拿到笔记。${hint}\n常见原因：cookie 过期（先调 xhs_check_login）、关键词太窄、或触发了风控。`;
    }
    const lines = notes.map((n, i) => renderNote(n, i + 1));
    const cursor = payload && typeof payload.cursor_score === "string" ? payload.cursor_score : "";
    return clipLines(
        `${label}共 ${notes.length} 条：`,
        lines,
        cursor ? `翻页请把 cursor_score 传为：${cursor}` : undefined,
    );
}

function renderDetail(payload) {
    if (payload && payload.error) return { text: payload.error, isError: true };
    const data = (payload && payload.data) || {};
    const note = data.note || payload.note || {};
    const id = note.note_id || note.noteId || "";
    const title = oneLine(note.title || note.display_title || "(无标题)", 60);
    const user = note.user || {};
    const interact = note.interact_info || {};
    const body = oneLine(note.desc || note.content || "", 700);
    const images = Array.isArray(note.image_list) ? note.image_list.length : 0;

    const comments = (data.comments && Array.isArray(data.comments.list)) ? data.comments.list : [];
    const status = data.comments_status || "unknown";

    const out = [];
    out.push(`笔记 [${id}] ${title}`);
    out.push(`作者: ${user.nickname || user.nick_name || "(未知)"}${user.user_id ? ` (${user.user_id})` : ""}`);
    out.push(`赞: ${interact.liked_count || interact.likedCount || "0"} | 藏: ${interact.collected_count || "0"} | 评: ${interact.comment_count || "0"} | 图: ${images} 张`);
    out.push("");
    out.push("正文：");
    out.push(body || "(无正文)");

    if (comments.length > 0) {
        out.push("");
        out.push(`评论区（共 ${comments.length} 条，显示前 5 条）：`);
        for (const c of comments.slice(0, 5)) {
            const who = c.nickname || c.author_name || (c.user && c.user.nickname) || "(匿名)";
            const likes = c.like_count != null ? c.like_count : "";
            out.push(`- ${who}${likes !== "" ? `（赞${likes}）` : ""}: ${oneLine(c.content, 90)}`);
        }
    } else {
        out.push("");
        out.push(`评论区：${status === "unavailable" ? `当前拿不到（${oneLine(data.comments_error || "上游未开放评论接口", 80)}）` : "为空"}`);
    }

    const text = out.join("\n");
    return { text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 20) + "\n…（已截断）" : text, isError: false };
}

function renderProfile(payload) {
    if (payload && payload.error) return { text: payload.error, isError: true };
    const p = payload || {};
    const info = p.data && p.data.basic_info ? p.data.basic_info : (p.basic_info || p);
    const name = info.nickname || info.nick_name || "(未知)";
    const desc = oneLine(info.desc || info.description || "", 160);
    const head = [`用户 ${name}${info.user_id ? ` (${info.user_id})` : ""}`];
    if (desc) head.push(`简介：${desc}`);
    if (info.fans || info.fans_count) head.push(`粉丝：${info.fans || info.fans_count}`);
    return { text: renderNotes(payload, head.join("\n") + "\nTA 的笔记："), isError: false };
}

function renderAction(payload, okText) {
    const p = payload || {};
    if (p.error) return { text: p.error, isError: true };
    if (p.success === false) {
        return { text: `失败：${oneLine(p.msg || "小红书未确认操作成功", 200)}`, isError: true };
    }
    let text = okText;
    if (p.msg) text += `（${oneLine(p.msg, 80)}）`;
    if (p.note_id || p.noteId) text += ` note_id: ${p.note_id || p.noteId}`;
    return { text, isError: false };
}

function renderCheckLogin(payload) {
    const p = payload || {};
    if (p.error) return { text: p.error, isError: true };
    const ok = p.success !== false && (p.nickname || p.user_id || p.userId || p.logged_in);
    if (!ok) return { text: `登录态看起来无效：${oneLine(JSON.stringify(p), 300)}`, isError: true };
    const name = p.nickname || p.nick_name || "";
    const uid = p.user_id || p.userId || "";
    return { text: `登录有效${name ? `，账号：${name}` : ""}${uid ? ` (${uid})` : ""}${p.platform ? `，后端：${p.platform}` : ""}`, isError: false };
}

function renderToolResult(toolName, payload) {
    switch (toolName) {
        case "xhs_check_login":
            return renderCheckLogin(payload);
        case "xhs_search":
            return { text: renderNotes(payload, "搜索结果"), isError: false };
        case "xhs_list_feeds":
            return { text: renderNotes(payload, "首页推荐"), isError: false };
        case "xhs_user_profile":
            return renderProfile(payload);
        case "xhs_get_feed_detail":
            return renderDetail(payload);
        case "xhs_post_comment":
            return renderAction(payload, "评论已发布");
        case "xhs_reply_comment":
            return renderAction(payload, "回复已发出");
        case "xhs_like_feed":
            return renderAction(payload, "点赞操作已完成");
        case "xhs_favorite_feed":
            return renderAction(payload, "收藏操作已完成");
        case "xhs_publish":
            return renderAction(payload, "笔记已发布");
        default: {
            const text = JSON.stringify(payload);
            return { text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 20) + "…（已截断）" : text, isError: false };
        }
    }
}

// ── 调核心 ──────────────────────────────────────────────────────────────────

function resolveCookie(env) {
    const cookie = (env && env.XHS_COOKIE) || "";
    if (!cookie.trim()) {
        throw new Error(
            "服务器还没配置 XHS_COOKIE。请到 Netlify 站点 -> Site configuration -> "
            + "Environment variables 里添加 XHS_COOKIE，填小红书完整 cookie，然后重新部署。",
        );
    }
    if (!cookie.includes("a1=")) {
        throw new Error("XHS_COOKIE 里缺少 a1= 字段，说明 cookie 复制得不完整，请重新复制一次完整的请求 Cookie。");
    }
    return cookie.trim();
}

async function callCore(command, body, env) {
    const cookie = resolveCookie(env);
    const result = await XHSLite.handle(command, body || {}, cookie, env || {}, {
        rnoteApiKey: (env && env.RNOTE_API_KEY) || "",
        platform: "auto",
    });
    if (result === null) throw new Error(`内核不认识这个命令：${command}`);
    return result;
}

// ── JSON-RPC 分发 ───────────────────────────────────────────────────────────

async function handleRpc(msg, env) {
    if (!msg || typeof msg !== "object") return rpcError(undefined, -32600, "Invalid Request");

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === "initialize") {
        const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
        return rpcResult(id, {
            // 原样回传客户端要的版本：ai-virtual-phone 发的是 2024-11-05，
            // 我们只用到 tools 能力，任何 handshake-era 版本都能跑。
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
        });
    }

    if (typeof method === "string" && method.startsWith("notifications/")) {
        // 通知没有响应体，返回 202 空响应即可（客户端不解析通知的返回）。
        return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    if (method === "ping") return rpcResult(id, {});

    if (method === "tools/list") {
        return rpcResult(id, {
            tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
    }

    if (method === "tools/call") {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const tool = TOOL_BY_NAME.get(name);
        if (!tool) return rpcError(id, -32602, `未知工具：${name}`);

        try {
            const payload = await callCore(tool.command, tool.build(args), env);
            const rendered = renderToolResult(name, payload);
            return rpcResult(id, {
                content: [{ type: "text", text: rendered.text }],
                ...(rendered.isError ? { isError: true } : {}),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // 用 isError 结果而不是 JSON-RPC error：客户端会把两者都当失败处理，
            // 但 isError 路径能给模型一段可读的说明，模型还能自己纠正（比如先 check_login）。
            return rpcResult(id, { content: [{ type: "text", text: `调用失败：${message}` }], isError: true });
        }
    }

    if (isNotification) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return rpcError(id, -32601, `Method not found: ${method}`);
}

// ── Netlify Function 入口 ───────────────────────────────────────────────────

export default async function handler(request, context) {
    const env = (typeof process !== "undefined" && process.env) ? process.env : {};
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 探活：浏览器直接打开这个地址能看到的页面，用来确认部署成功。
    if (request.method === "GET") {
        return json({
            status: "ok",
            server: SERVER_INFO,
            tools: TOOLS.length,
            tool_names: TOOLS.map(t => t.name),
            cookie_configured: !!(env && env.XHS_COOKIE),
            auth_required: !!(env && env.MCP_KEY),
            mcp_endpoint: url.origin + url.pathname,
            hint: "把这个地址填进 ai-virtual-phone 的设置 -> 工具(MCP) -> 服务器 URL",
        });
    }

    if (request.method !== "POST") {
        return json({ error: "只接受 POST（MCP 协议）。GET 可以用来探活。" }, 405);
    }

    if (env && env.MCP_KEY) {
        const auth = request.headers.get("Authorization") || "";
        if (auth !== `Bearer ${env.MCP_KEY}`) {
            return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="xhs-mcp"' });
        }
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return rpcError(undefined, -32700, "Parse error");
    }

    try {
        if (Array.isArray(body)) {
            const results = [];
            for (const msg of body) {
                const res = await handleRpc(msg, env);
                if (res.status !== 202) results.push(await res.json());
            }
            if (results.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
            return json(results);
        }
        return await handleRpc(body, env);
    } catch (err) {
        return rpcError(body && body.id, -32603, err instanceof Error ? err.message : String(err));
    }
}
