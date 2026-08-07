/* 打包前构建：把调酒游戏(bartend-game.html)内联进酒吧 index.html，
   以 <script type="text/html"> 模板存放，运行时切到「调酒台」时用 srcdoc 还原成同源 iframe。
   - 转义 </script> 防止提前闭合模板
   - 幂等：每次重跑先移除旧嵌入块
   - 顺便做 JS 语法检查（提取所有非 text/html 的 <script> 用 new Function 解析） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appDir = path.join(__dirname, 'app');
const gamePath = path.join(appDir, 'bartend-game.html');
const indexPath = path.join(appDir, 'index.html');

// ---- 1. 嵌入游戏 ----
let game = fs.readFileSync(gamePath, 'utf8');
game = game.replace(/<\/script/gi, '<\\/script'); // 防止提前闭合模板脚本

let html = fs.readFileSync(indexPath, 'utf8');
// 移除旧嵌入块（幂等）
html = html.replace(/<!--GAME_SRCDOC_START-->[\s\S]*?<!--GAME_SRCDOC_END-->/, '');
const block =
  '\n<!--GAME_SRCDOC_START-->\n<script type="text/html" id="__game_srcdoc__">\n' +
  game +
  '\n</script>\n<!--GAME_SRCDOC_END-->\n';
if (html.includes('</body>')) {
  html = html.replace('</body>', block + '</body>');
} else {
  html += block;
}
fs.writeFileSync(indexPath, html, 'utf8');
console.log('[embed] game inlined, index.html bytes =', Buffer.byteLength(html));

// ---- 2. JS 语法检查（排除 text/html 模板） ----
// 先去掉游戏模板块，避免其内部被当作独立 <script> 误抓
const htmlCheck = html.replace(/<!--GAME_SRCDOC_START-->[\s\S]*?<!--GAME_SRCDOC_END-->/, '');
const re = /<script(?![^>]*\btype=["']?text\/html\b)[^>]*>([\s\S]*?)<\/script>/gi;
let m, n = 0, ok = 0, bad = 0;
while ((m = re.exec(htmlCheck))) {
  const code = m[1];
  if (!code.trim().length) continue; // 跳过 <script src=...></script>
  n++;
  try {
    new vm.Script('(function(){\n' + code + '\n})();', { filename: 'block' + n + '.js' });
    ok++;
  } catch (e) {
    bad++;
    console.error('[check] JS SYNTAX ERROR in block #' + n + ': ' + e.message);
  }
}
if (bad) { console.error('[check] ' + bad + ' block(s) failed'); process.exit(1); }
console.log('[check] JS syntax OK (' + ok + ' real script block(s))');
