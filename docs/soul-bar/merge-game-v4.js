/**
 * merge-game-v4.js — 直接同文档融合（稳定版，用户要求：不要 iframe/转移，直接融进游戏里）
 *
 * 与 v3 的关键区别：
 *  1. 提取游戏 <body> 后【剔除其内部的 <script>】，否则游戏 JS 会被注入两份
 *     （一份裸文本 HTML、一份 IIFE），导致重复定义 + 黑屏 + 语法错误。
 *  2. CSS 作用域化到 #kissa-game-root，并且：
 *     - HTML 的 id 加 kg- 前缀（避免与酒吧全局 id 冲突）
 *     - CSS 里的 #id 选择器也加 kg- 前缀（精确匹配游戏内真实 id，绝不误伤十六进制颜色）
 *     - @keyframes 名称加 kg- 前缀，且对应的 animation / animation-name 引用也加 kg- 前缀
 *  3. JS 只给 getElementById / querySelector(All)('#id') 加 kg- 前缀（含 'X' + expr 形式）。
 *     不重命名 init、不删除 DOMContentLoaded —— 游戏通过自身的
 *     window.addEventListener('DOMContentLoaded', () => waitForAiPhoneGame().then(init))
 *     自行初始化，只要 window.AiPhoneGame 被设置即可。
 *  4. 融合层覆盖原 iframe 版 mountGame：直接显示 #kissa-game-root，并在加载时
 *     直接 window.AiPhoneGame = buildGameBridge()（复用酒吧已有的正确桥接）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BAR_PATH = path.join(__dirname, 'app', 'index.html');
const GAME_PATH = path.join(__dirname, 'app', 'bartend-game.html');
const OUT_PATH = path.join(__dirname, 'app', 'index.html');

let barHtml = fs.readFileSync(BAR_PATH, 'utf8');
const gameHtmlRaw = fs.readFileSync(GAME_PATH, 'utf8');

// 1. 去除旧 srcdoc 模板（不再用 iframe）
barHtml = barHtml.replace(/<!--GAME_SRCDOC_START-->[\s\S]*?<!--GAME_SRCDOC_END-->/g,
  '<!-- [merged] old srcdoc removed -->');

// 2. 提取游戏 CSS / HTML / JS
const gameCssRaw = gameHtmlRaw.match(/<style>([\s\S]*?)<\/style>/)[1];
let gameBodyRaw = gameHtmlRaw.match(/<body>([\s\S]*?)<\/body>/)[1];
// ★ 关键修复：剔除 body 内的 <script>（游戏自身脚本），否则 JS 会被注入两份
gameBodyRaw = gameBodyRaw.replace(/<script[\s\S]*?<\/script>/gi, '');
gameBodyRaw = gameBodyRaw.replace(/<style[\s\S]*?<\/style>/gi, '');
const gameJsRaw = gameHtmlRaw.match(/<script>([\s\S]*?)<\/script>/)[1];

// 收集游戏内真实元素 id（仅用于 CSS 选择器精确加 kg- 前缀）
const gameIds = new Set();
{
  let m; const idRe = /\bid=["']([^"']+)["']/g;
  while ((m = idRe.exec(gameBodyRaw))) gameIds.add(m[1]);
}
// 收集 @keyframes 名称
const keyframesNames = new Set();
{
  let m; const kfRe = /@(?:-webkit-)?keyframes\s+([A-Za-z_-][\w-]*)/g;
  while ((m = kfRe.exec(gameCssRaw))) keyframesNames.add(m[1]);
}

// 3. CSS 作用域化
const scopedCss = scopeCss(gameCssRaw, '#kissa-game-root', gameIds, keyframesNames);

// 4. HTML ID 加 kg- 前缀（仅属性）
const gameIdHtml = prefixIds(gameBodyRaw, 'kg-');

// 5. JS：仅给 getElementById / querySelector(All)('#id') 加 kg- 前缀
const gameJsTransformed = minTransformJs(gameJsRaw);
const iifeJs = '(function(){\n' + gameJsTransformed + '\n})();';

// 6. 注入 CSS 到主 <style> 前
const styleIdx = barHtml.lastIndexOf('</style>');
let out = barHtml.slice(0, styleIdx);
out += '\n\n  /* ═══ 融合：灵魂调酒模拟器 #kissa-game-root ═══ */\n';
out += scopedCss;
out += '\n  /* ═══ end 游戏融合 CSS ═══ */\n';
out += barHtml.slice(styleIdx);

// 7. 替换 bar room（恢复 #bartop 点单菜单 + 注入 #kissa-game-root 游戏容器）
out = out.replace(
  /<div class="room bar"[^>]*id="room-bar"[^>]*>[\s\S]*?<!-- 相册/,
  `<div class="room bar" id="room-bar">
      <div class="zonehead"><b>🎮 调酒台</b> · 完整调酒游戏，和在场角色一起共调一杯。</div>
      <div id="bartop" style="padding:6px 10px 2px;flex:0 0 auto"></div>
      <div id="kissa-game-root" style="flex:1;min-height:0;position:relative;display:flex;overflow:hidden">
${gameIdHtml}
      </div>
    </div>
    <!-- 相册`
);

// 8. 注入融合层（覆盖原 iframe 版 mountGame，直接设 window.AiPhoneGame）+ 游戏 IIFE
const bodyIdx = out.indexOf('</body>');
const lastScriptIdx = out.lastIndexOf('</script>', bodyIdx);
const injPoint = lastScriptIdx + '</script>'.length;

const fusionCode = `
<script>
/* ═══ 调酒游戏融合层：直接同文档运行（覆盖原 iframe 版 mountGame）═══ */
function mountGame(){
  var r = document.getElementById('kissa-game-root');
  if(r) r.style.display = 'flex';
  if(typeof buildGameBridge === 'function' && !window.AiPhoneGame){
    try{ var b = buildGameBridge(); if(b) window.AiPhoneGame = b; }catch(e){}
  }
}
/* 立即提供桥接，游戏 DOMContentLoaded 后即可初始化（无需等切到调酒台） */
if(typeof buildGameBridge === 'function' && !window.AiPhoneGame){
  try{ var _b = buildGameBridge(); if(_b) window.AiPhoneGame = _b; }catch(e){}
}
</script>

<script>
${iifeJs}
</script>`;

out = out.slice(0, injPoint) + fusionCode + out.slice(injPoint);

// 9. switchRoom：切到 bar 时显示游戏 + 渲染点单菜单
out = out.replace(/if\(r==="bar"\)\{[^}]*\}/g, 'if(r==="bar"){ mountGame(); renderBartop(); }');

// 10. 写出 + 校验
fs.writeFileSync(OUT_PATH, out, 'utf8');

// ── 校验 ──
function fail(msg){ console.error('[check] ' + msg); process.exit(1); }

// 10a. JS 语法检查（逐块）
const scripts = [...out.matchAll(/<script(?![^>]*\btype=["']?text\/html\b)[^>]*>([\s\S]*?)<\/script>/gi)];
let combined = '', n = 0, ok = 0;
for (const s of scripts) {
  if (!s[1].trim().length) continue;
  combined += ';\n' + s[1]; n++;
  try { new vm.Script('(function(){' + s[1] + '\n})()', { filename: 'block' + n }); ok++; }
  catch (e) { console.error('[check] JS SYNTAX ERROR in block #' + n + ': ' + e.message); fail('JS 语法错误，已中止写出校验'); }
}
console.log('[check] JS OK (' + ok + '/' + n + ' blocks)');

// 10b. 健全性检查
if (!out.includes('id="bartop"')) fail('未注入 #bartop 点单菜单');
if (!out.includes('id="kissa-game-root"')) fail('未注入 #kissa-game-root 游戏容器');
// 游戏 JS 只应出现一次（IIFE 形式），body 内不应再含裸 <script>
if (out.includes("getElementById('userMiniAvatar')")) fail('存在未加 kg- 前缀的 getElementById 引用');
if (out.includes('id="userMiniAvatar"')) fail('存在未加 kg- 前缀的 HTML id');
if (!out.includes("getElementById('kg-userMiniAvatar')")) fail('kg- 前缀的 getElementById 引用缺失');
if (!out.includes('id="kg-userMiniAvatar"')) fail('kg- 前缀的 HTML id 缺失');
// #fullScreenLoader 选择器应被加 kg-
if (out.includes('#fullScreenLoader') && !out.includes('#kg-fullScreenLoader')) {
  // 允许：若 CSS 中确实漏了，则报错
  fail('#fullScreenLoader CSS 选择器未加 kg- 前缀');
}
console.log('[check] sanity OK (bartop + game-root + kg- 前缀)');

console.log('[merge] SUCCESS! written bytes =', out.length);

// ───────────────────────── 工具函数 ─────────────────────────

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scopeCss(css, scope, gameIds, keyframesNames) {
  const lines = css.split('\n'), out = [];
  let selBuf = '', inRule = false, depth = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { out.push(''); continue; }
    if (line.startsWith('/*') || line.startsWith('*')) { out.push(rawLine); continue; }
    if (line.startsWith('@')) {
      if (line.startsWith('@import')) { out.push(line); continue; }
      if (/^@(?:-webkit-)?keyframes\s/.test(line)) {
        out.push(line.replace(/(@(?:-webkit-)?keyframes)\s+([A-Za-z_-][\w-]*)/, '$1 kg-$2')); continue;
      }
      out.push(line); continue;
    }
    const opens = (line.match(/\{/g) || []).length, closes = (line.match(/\}/g) || []).length;
    if (!inRule && opens === 0 && closes === 0) { selBuf = selBuf ? selBuf + '\n' + line : line; continue; }
    if (!inRule && opens > 0) {
      const selPart = line.replace(/\{.*$/, ''), rest = line.substring(selPart.length);
      const fullSel = selBuf ? (selBuf + '\n' + selPart).trim() : selPart.trim();
      out.push(prefixSel(fullSel, scope) + '{' + rest.substring(1));
      selBuf = ''; inRule = true; depth = opens - closes; continue;
    }
    if (inRule) { out.push(rawLine); depth += opens - closes; if (depth <= 0) { inRule = false; depth = 0; } continue; }
    out.push(rawLine);
  }
  let result = out.join('\n');
  // 精确给 CSS 中的 #id 选择器加 kg- 前缀（仅真实游戏 id，避免误伤十六进制颜色）
  for (const id of gameIds) {
    result = result.replace(new RegExp('#' + escapeRegExp(id) + '\\b', 'g'), '#kg-' + id);
  }
  // 给 animation / animation-name 引用的 keyframes 名加 kg- 前缀
  for (const name of keyframesNames) {
    result = result.replace(new RegExp('animation:\\s*' + escapeRegExp(name) + '\\b', 'g'), 'animation: kg-' + name);
    result = result.replace(new RegExp('animation-name:\\s*' + escapeRegExp(name) + '\\b', 'g'), 'animation-name: kg-' + name);
  }
  return result;
}

function prefixSel(sel, scope) {
  return sel.split(',').map(p => {
    p = p.trim(); if (!p) return '';
    if (/^(html|body)$/i.test(p)) return scope;
    if (/^(html|body)\s/i.test(p)) return scope + p.replace(/^(html|body)\s*/i, ' ');
    if (p === ':root') return scope;
    if (p.startsWith(':root ')) return scope + p.substring(5);
    if (p === '*') return scope + ' *';
    if (p.startsWith(scope)) return p;
    return scope + ' ' + p;
  }).join(', ');
}

function prefixIds(html, p) {
  return html.replace(/\bid=(["'])([^"']+)\1/g, (m, q, id) => `id=${q}${p}${id}${q}`)
    .replace(/\bfor=(["'])([^"']+)\1/g, (m, q, id) => `for=${q}${p}${id}${q}`);
}

function minTransformJs(js) {
  let t = js;
  // getElementById('X') 或 getElementById('X' + expr) → kg- 前缀
  t = t.replace(/getElementById\((['"])([^'"]*)\1(\s*\+\s*[^)]*)?\)/g,
    (m, q, lit, tail) => `getElementById(${q}kg-${lit}${q}${tail || ''})`);
  // querySelector / querySelectorAll('#id')
  t = t.replace(/querySelector\(['"]#([^'"]+)['"]\)/g, (m, id) => `querySelector('#kg-${id}')`);
  t = t.replace(/querySelectorAll\(['"]#([^'"]+)['"]\)/g, (m, id) => `querySelectorAll('#kg-${id}')`);
  return t;
}
