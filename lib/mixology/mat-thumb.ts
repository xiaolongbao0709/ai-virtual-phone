"use client";

// lib/mixology/mat-thumb.ts
// 上架前把材料的自动封面拍成一张很小的 WebP 缩略图。
//
// 为什么要拍图：大厅列表是全网共享一份 CDN 缓存的摘要，不下发 payload
// （创作者的整卡源数据不做匿名裸发），所以列表里渲染不出小票/尾调的样子，
// 只能退回图标占位。拍一张几 KB 的缩略图随条目上架，列表就有得看了——
// 它随发布走 Storage 公开桶（哈希文件名 + 一年不可变），浏览器直连拉图，
// 列表接口与 PostgREST 都不背这几个字节。
//
// 怎么拍：渲染代码本来就跑在无 same-origin 的沙盒 iframe 里，宿主读不到它的 DOM，
// 所以让沙盒自己拍——把自己渲染完的 DOM 序列化进 SVG 的 foreignObject，
// 画到 canvas 上再导出。整个过程在沙盒内部完成，宿主只收一张 dataURL。
//
// 拍不成就返回空串，条目照旧没有封面、列表退回图标——绝不因为拍图失败拦住上架。

import { buildMixTicketDoc } from "./ticket-doc";
import { mixEncoreRenderHtml, type MixMaterial } from "./types";

/**
 * 按手机宽度排版再降采样输出：直接用小宽度渲染会让排版和对局里看到的不一样。
 * 保留透明底（卡片自己的背景透上来更整体），代价是 WebP 只能走无损——
 * 实测带 alpha 时 quality 参数完全不起作用，所以省体积只能靠缩尺寸。
 * quality 留着给退化到 JPEG 的那条路用。
 */
const RENDER_W = 360;
const MAX_W = 300;
const MAX_H = 420;
const QUALITY = 0.72;
/** 拍出来大得离谱就不要了（渲染代码里塞了大图之类），别把这种东西传上去 */
const MAX_BYTES = 300 * 1024;
/** 等渲染代码跑完再拍；到点还没回话就放弃 */
const SETTLE_MS = 420;
const TIMEOUT_MS = 6_000;

/** 这件材料有没有可拍的自动封面（与 mixMatHasAutoCover 的小票/尾调分支同口径） */
function thumbSource(material: MixMaterial): { html: string; raw: string } | null {
    if (material.kind === "ticket") {
        const html = material.renderHtml?.trim() ?? "";
        const raw = material.previewRaw?.trim() ?? "";
        return html && raw ? { html, raw } : null;
    }
    if (material.kind === "encore") {
        const html = mixEncoreRenderHtml(material).trim();
        if (!html) return null;
        const raw = material.previewRaw?.trim() ?? "";
        // AI 供稿型没留示例数据就渲染不出内容，别拍一张空壳
        if (material.contract?.trim() && !raw) return null;
        return { html, raw };
    }
    return null;
}

/** 沙盒内部的抓拍脚本：序列化自己 → SVG foreignObject → canvas → WebP */
function shotBridge(token: string): string {
    return `<script>(function(){
  var TOKEN=${JSON.stringify(token)};
  function send(url){try{parent.postMessage({source:"mix-mat-thumb",token:TOKEN,url:url||""},"*");}catch(e){}}
  function measure(){
    var b=document.body;if(!b)return 1;
    var cs=window.getComputedStyle(b);var mt=parseFloat(cs.marginTop)||0;var mb=parseFloat(cs.marginBottom)||0;
    var h=b.getBoundingClientRect().height+mt+mb;
    for(var i=0;i<b.children.length;i++){var c=b.children[i].getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom+mb);}
    return Math.max(1,Math.ceil(h));
  }
  function shoot(){
    try{
      /* 折叠件保持收起状态原样拍：酒柜卡的实时缩样就是自然状态，两边长一个样。
         自定义 JS 折叠（非 details）本来也展不开，干脆统一所见即渲染 */
      var w=Math.max(1,Math.ceil(document.documentElement.getBoundingClientRect().width||${RENDER_W}));
      var h=measure();
      /* 脚本标签不必带进图里，去掉省体积（SVG 里本来也不执行） */
      var clone=document.documentElement.cloneNode(true);
      var s=clone.querySelectorAll("script");
      for(var i=0;i<s.length;i++){if(s[i].parentNode)s[i].parentNode.removeChild(s[i]);}
      var doc=new XMLSerializer().serializeToString(clone);
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'
            +'<foreignObject x="0" y="0" width="'+w+'" height="'+h+'">'+doc+'</foreignObject></svg>';
      var img=new Image();
      img.onload=function(){
        try{
          /* 只按宽度缩放；太高的渲染裁掉下半截，不整体压成一根细条 */
          var k=Math.min(1,${MAX_W}/w);
          var fullH=Math.max(1,Math.round(h*k));
          var cv=document.createElement("canvas");
          cv.width=Math.max(1,Math.round(w*k));cv.height=Math.min(fullH,${MAX_H});
          var cx=cv.getContext("2d");
          if(!cx){send("");return;}
          cx.drawImage(img,0,0,cv.width,fullH);
          /* 外链图片会污染画布，导出这一步直接抛错——兜住，当作没拍成 */
          var url=cv.toDataURL("image/webp",${QUALITY});
          if(url.indexOf("data:image/webp")!==0)url=cv.toDataURL("image/jpeg",${QUALITY});
          send(url);
        }catch(e){send("");}
      };
      img.onerror=function(){send("");};
      img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
    }catch(e){send("");}
  }
  /* 等渲染代码把 DOM 画完（它可能在 load 之后才填内容），再多给一拍 */
  function go(){setTimeout(shoot,${SETTLE_MS});}
  if(document.readyState==="complete")go();else window.addEventListener("load",go);
})();</` + `script>`;
}

/**
 * 拍一张缩略图。拿不到就返回空串（不是错误：调用方照常上架，只是没有封面）。
 * 只在浏览器里有意义；服务端渲染时直接返回空串。
 */
export async function captureMixMatThumb(material: MixMaterial): Promise<string> {
    if (typeof window === "undefined" || typeof document === "undefined") return "";
    const source = thumbSource(material);
    if (!source) return "";
    const token = `thumb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const doc = buildMixTicketDoc(source.html, source.raw);
    const withShot = /<\/body>/i.test(doc)
        ? doc.replace(/<\/body>/i, `${shotBridge(token)}</body>`)
        : doc + shotBridge(token);

    const frame = document.createElement("iframe");
    // 离屏但不能 display:none —— 隐藏元素量不出尺寸，也画不出内容
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${RENDER_W}px;height:${MAX_H}px;border:0;opacity:0;pointer-events:none`;
    frame.srcdoc = withShot;

    return new Promise<string>((resolve) => {
        let done = false;
        const finish = (url: string) => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            frame.remove();
            resolve(url);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-mat-thumb" || data.token !== token) return;
            const url = typeof data.url === "string" ? data.url : "";
            // dataURL 的 base64 大约是原始字节的 4/3
            finish(url.length * 3 / 4 > MAX_BYTES ? "" : url);
        };
        const timer = window.setTimeout(() => finish(""), TIMEOUT_MS);
        window.addEventListener("message", onMessage);
        document.body.appendChild(frame);
    });
}
