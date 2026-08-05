// ── iframe 运行时报错回传 ────────────────────────────
// 注入进游戏/剧场等 srcDoc iframe 的脚本：捕获 iframe 内的 JS 报错、
// 未处理 promise 拒绝、console.error，postMessage 给宿主。宿主侧由
// qa-error-log 统一收集，供工坊「最近报错」诊断工具读取。

export const IFRAME_ERROR_CAPTURE_SCRIPT = `<script>
(function(){
  function report(kind, message, source){
    try {
      parent.postMessage({
        source: 'ai-phone-iframe-error',
        kind: kind,
        message: String(message == null ? '' : message).slice(0, 500),
        origin: (document.title || location.hash || 'iframe'),
        source_loc: source || '',
      }, '*');
    } catch (e) {}
  }
  window.addEventListener('error', function(event){
    var loc = event.filename ? (String(event.filename).split('/').pop() + ':' + event.lineno) : '';
    report('error', event.message || (event.error && event.error.message) || 'script error', loc);
  });
  window.addEventListener('unhandledrejection', function(event){
    var reason = event.reason;
    var msg = reason && reason.message ? reason.message : reason;
    report('unhandledrejection', msg, '');
  });
  var origError = console.error;
  console.error = function(){
    try {
      var parts = Array.prototype.map.call(arguments, function(a){
        return (a && a.message) ? a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a));
      });
      report('console', parts.join(' '), '');
    } catch (e) {}
    return origError.apply(console, arguments);
  };
})();
</script>`;
