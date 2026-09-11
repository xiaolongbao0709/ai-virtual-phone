"use client";

// 独家特调 · 小票渲染画布：小票材料的 renderHtml 在沙盒 iframe 里执行，
// AI 的 [状态栏] 壳内原文通过 window.TICKET_RAW（JS 取用）与 {{RAW}}（模板直插，已转义）注入。
// 高度自适应桥与自定义状态栏同款；allow-scripts 无 same-origin，碰不到宿主页面与数据。

import { useEffect, useMemo, useRef, useState } from "react";
import type { MixState } from "@/lib/mixology/types";
import { createMixFrameHeightTracker, nextMixFrameHeight } from "@/lib/mixology/frame-height";
import { buildMixTicketDoc } from "@/lib/mixology/ticket-doc";

const FRAME_MIN_HEIGHT = 36;
/**
 * 小票与尾调也是 scrolling="no"，超出即截断。它们每轮插在对话流里，
 * 不该像开场画布那样动辄十几屏，所以余量给得小一档：原来 2000（约两屏），
 * 一个稍微复杂的小剧场就顶到头，放宽到 5000（约五屏半）。
 */
const FRAME_MAX_HEIGHT = 5000;

export function MixTicketFrame({ html, raw, state }: { html: string; raw: string; state?: MixState }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameId] = useState(() => `mtf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
    const trackerRef = useRef(createMixFrameHeightTracker(FRAME_MIN_HEIGHT));

    const srcDoc = useMemo(() => {
        const doc = buildMixTicketDoc(html, raw, state);
        const bridge = `<script>(function(){
  var frameId=${JSON.stringify(frameId)};
  /* 只用内容包围盒测高（scrollHeight 会跟着 iframe 视口涨，会形成"越量越高"的回路） */
  function measure(){var b=document.body;if(!b)return ${FRAME_MIN_HEIGHT};
    var cs=window.getComputedStyle(b);var mt=parseFloat(cs.marginTop)||0;var mb=parseFloat(cs.marginBottom)||0;
    var h=b.getBoundingClientRect().height+mt+mb;
    for(var i=0;i<b.children.length;i++){var c=b.children[i].getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom+mb);}
    return Math.max(Math.ceil(h)+2,${FRAME_MIN_HEIGHT});}
  function send(){parent.postMessage({source:'mix-ticket-frame',type:'resize',id:frameId,height:measure()},'*');}
  function sched(){requestAnimationFrame(function(){send();requestAnimationFrame(send);});}
  window.addEventListener('load',sched);window.addEventListener('resize',sched);
  if(window.MutationObserver)new MutationObserver(sched).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});
  if(window.ResizeObserver&&document.body)new ResizeObserver(sched).observe(document.body);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(sched);
  setTimeout(send,60);setTimeout(send,400);setTimeout(send,1200);
})();</` + `script>`;
        return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${bridge}</body>`) : doc + bridge;
    }, [html, raw, state, frameId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-ticket-frame" || data.type !== "resize" || data.id !== frameId) return;
            const applied = nextMixFrameHeight(trackerRef.current, Number(data.height), {
                min: FRAME_MIN_HEIGHT,
                max: FRAME_MAX_HEIGHT,
            });
            if (applied !== null) setHeight(applied);
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameId]);

    return (
        <iframe
            ref={iframeRef}
            title="小票"
            sandbox="allow-scripts"
            scrolling="no"
            srcDoc={srcDoc}
            style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
        />
    );
}
