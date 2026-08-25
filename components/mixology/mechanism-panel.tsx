"use client";

// 独家特调 · 机括的常驻界面。
//
// 跟钩子的沙盒是两回事：钩子是"被叫起来跑一下就结束"的纯函数，
// 这里是"一直挂在屏幕上、有自己状态"的东西，所以必须常驻不重建——
// 每轮重新插一次的话，播放器会从头放、记忆区会滚回顶部、页签会跳回第一个。
//
// 摆放全交给创作者：画在哪、画多大、要不要应用画的外壳与底板，都是材料自己写的
// 百分比坐标（见 MixPanelLayout）。宿主只保留两条底线——面板不许被拖到画面外找不回来，
// 层级不许压过应用自己的弹窗。除此之外不干涉排版。
//
// 能做的事仍是一张白名单：写自己的存储、写记住的值、以玩家身份发一句话、
// 收起/展开、挪自己、改自己大小、报一下内容多高。白名单以外的消息一律不理会。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
    MIX_PANEL_KEEP_IN,
    MIX_PANEL_MAX_Z,
    MIX_PANEL_MIN_H,
    MIX_PANEL_MIN_W,
    type MixPanelLayout,
    type MixState,
} from "@/lib/mixology/types";
import { normalizeMechanismStore, type MixMechanismStore } from "@/lib/mixology/mechanism-protocol";

/** 界面能请求的动作，就这几条 */
type PanelCommand =
    | { name: "boot" }
    | { name: "setStore"; store: unknown }
    | { name: "setState"; state: unknown }
    | { name: "say"; text: unknown }
    | { name: "setOpen"; open: unknown }
    | { name: "box"; box: unknown }
    | { name: "fit"; px: unknown }
    | { name: "design"; px: unknown }
    | { name: "flag"; key: unknown; on: unknown }
    | { name: "flag"; key: unknown; on: unknown }
    | { name: "grab"; cx: unknown; cy: unknown }
    | { name: "drag"; cx: unknown; cy: unknown }
    | { name: "dragEnd" };

const MAX_SAY_LENGTH = 2_000;

type Box = { x: number; y: number; w: number; h: number };

function boxOf(layout: MixPanelLayout): Box {
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h };
}

function sameBox(a: Box | null, b: Box): boolean {
    return Boolean(a) && a!.x === b.x && a!.y === b.y && a!.w === b.w && a!.h === b.h;
}

/**
 * 夹回可用范围。刻意不要求面板整个留在画面里——一半探出屏幕的挂件是正当排版；
 * 只保证还有 MIX_PANEL_KEEP_IN 那么一块留得住，拖出去还能拖回来。
 */
function clampBox(box: Box): Box {
    const w = Math.min(100, Math.max(MIX_PANEL_MIN_W, box.w));
    const h = Math.min(100, Math.max(MIX_PANEL_MIN_H, box.h));
    return {
        w,
        h,
        x: Math.min(100 - MIX_PANEL_KEEP_IN, Math.max(MIX_PANEL_KEEP_IN - w, box.x)),
        y: Math.min(100 - MIX_PANEL_KEEP_IN, Math.max(MIX_PANEL_KEEP_IN - h, box.y)),
    };
}

export function buildPanelDoc(html: string, state: MixState, store: MixMechanismStore, autoHeight: boolean): string {
    const bridge = `
<script>
(function(){
  "use strict";
  window.MIX_STATE = ${JSON.stringify(state)};
  window.MIX_STORE = ${JSON.stringify(store)};
  function send(name, extra){
    var msg = { source: "mix-panel", name: name };
    for (var k in extra) msg[k] = extra[k];
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }
  // 界面能请求的全部动作
  window.mix = {
    setStore: function(obj){ send("setStore", { store: obj }); },
    setState: function(obj){ send("setState", { state: obj }); },
    say: function(text){ send("say", { text: String(text == null ? "" : text) }); },
    open: function(){ send("setOpen", { open: true }); },
    close: function(){ send("setOpen", { open: false }); },
    // 挪自己 / 改自己大小：都是占对局画面的百分比，越界会被应用夹回来
    move: function(x, y){ send("box", { box: { x: x, y: y } }); },
    size: function(w, h){ send("box", { box: { w: w, h: h } }); },
    // 报一下内容有多高（像素）。摆放里开了 autoHeight 才有用
    fit: function(px){ send("fit", { px: px }); },
    // 改「按多宽排版」：收起成一颗小把手时要按小尺寸排，展开成一整台手机时要按 390 排，
    // 一份摆放写死一个宽度不够用，所以留给界面自己在两种形态之间换
    design: function(px){ send("design", { px: px }); },
    // 下面几条原来是编辑器上的开关。每件机括的形态都不一样，摆一排开关只会让人
    // 以为只有那几种搭法，所以一并交给界面自己说。
    drag: function(on){ send("flag", { key: "drag", on: on !== false }); },
    resize: function(on){ send("flag", { key: "resize", on: on !== false }); },
    chrome: function(on){ send("flag", { key: "chrome", on: on !== false }); },
    plate: function(on){ send("flag", { key: "plate", on: on !== false }); },
    z: function(n){ send("flag", { key: "z", on: n }); },
    // 从界面内部起拖：在自己画的标题条上 pointerdown 时调一下
    grab: startDrag
  };

  // 界面内部起拖：手指按在 iframe 里时，这一串移动事件会被锁在 iframe 上，
  // 宿主那边一条都收不到，所以这里自己听一份报上去。
  // 报的是「在自己这一格里的坐标」，不是屏幕坐标——沙盒是不透明源，
  // screenX 在这种 iframe 里拿到的是本格坐标而不是屏幕坐标，跨框架对不上。
  // 本格坐标会随面板一起动，宿主那边按「当前这一格在画面里的位置」换算回去，正好抵掉。
  var lastDown = null, dragFrom = null, savedTouch = "", held = null;
  document.addEventListener("pointerdown", function(e){
    lastDown = { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
  }, true);
  function onDragMove(e){
    if (!dragFrom) return;
    send("drag", { cx: e.clientX, cy: e.clientY });
  }
  function onDragEnd(){
    if (!dragFrom) return;
    dragFrom = null;
    if (held) {
      try { held.el.releasePointerCapture(held.id); } catch (err) {}
      held = null;
    }
    document.documentElement.style.touchAction = savedTouch;
    document.removeEventListener("pointermove", onDragMove, true);
    document.removeEventListener("pointerup", onDragEnd, true);
    document.removeEventListener("pointercancel", onDragEnd, true);
    send("dragEnd", {});
  }
  function startDrag(){
    if (dragFrom || !lastDown) return;
    dragFrom = lastDown;
    // 指针一旦离开这一小块界面就不再命中它，事件会停——所以把这个指针锁到
    // 按下的那个元素上。锁住之后指针跑到 iframe 外面，事件也照样回到这里。
    var el = lastDown.target;
    if (el && el.setPointerCapture) {
      try { el.setPointerCapture(lastDown.id); held = { el: el, id: lastDown.id }; } catch (err) { held = null; }
    }
    // 手指拖的时候不许页面顺带滚起来
    savedTouch = document.documentElement.style.touchAction;
    document.documentElement.style.touchAction = "none";
    document.addEventListener("pointermove", onDragMove, true);
    document.addEventListener("pointerup", onDragEnd, true);
    document.addEventListener("pointercancel", onDragEnd, true);
    send("grab", { cx: dragFrom.x, cy: dragFrom.y });
  }
  // 记住的值有变化时，应用会推一份新的过来；界面可定义 onMixSync 接收
  window.addEventListener("message", function(event){
    var data = event.data;
    if (!data || data.source !== "mix-panel-host") return;
    window.MIX_STATE = data.state || {};
    window.MIX_STORE = data.store || {};
    if (typeof window.onMixSync === "function") {
      try { window.onMixSync(window.MIX_STATE, window.MIX_STORE); } catch (e) {}
    }
  });
  // 启动握手：上面烘进文档的 MIX_STATE/MIX_STORE 是宿主生成这份文档时的快照。
  // 手机浏览器退后台会回收沙盒 iframe 的进程，回前台时 iframe 拿这份旧文档重启，
  // 快照就成了旧账——喊一声让宿主把当前值无条件补推一份，界面永远从最新值起步。
  send("boot", {});
  ${autoHeight ? `
  // 开了「高度随内容」就自动量，作者不用自己调 mix.fit
  var last = -1;
  function measure(){
    var b = document.body; if (!b) return;
    var r = b.getBoundingClientRect(); var px = r.height;
    for (var i = 0; i < b.children.length; i++) {
      var c = b.children[i].getBoundingClientRect();
      if (c.width || c.height) px = Math.max(px, c.bottom - r.top);
    }
    px = Math.ceil(px);
    if (px !== last) { last = px; send("fit", { px: px }); }
  }
  window.addEventListener("load", measure);
  window.addEventListener("resize", measure);
  if (window.MutationObserver) new MutationObserver(measure).observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
  setTimeout(measure, 60); setTimeout(measure, 400);
  ` : ""}
})();
</` + `script>`;
    const body = /<html[\s>]/i.test(html)
        ? html
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>`
          // 界面要能显示图片、播放音频，所以比钩子的沙盒松一档；
          // 但依然没有 connect-src——fetch / XHR / WebSocket 发不出去。
          + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:"/>`
          // html/body 给满高：面板的高度是宿主给的定值，作者写 height:100% 就该铺满，
          // 而不是塌成内容高——不给这一行的话「靠底对齐」「撑满一列」全都不成立
          + `<style>*{box-sizing:border-box}html,body{height:100%}html,body{margin:0;padding:0;background:transparent;color:#f2f0f7;font-family:system-ui,-apple-system,sans-serif;font-size:12px}input,textarea,button,select{max-width:100%;font-family:inherit;font-size:inherit}</style>`
          + `</head><body>${html}</body></html>`;
    // 桥接必须排在作者代码之前：放到 body 末尾的话，面板首屏读不到 MIX_STATE，
    // 要等第一次推送才显示出值来。
    return /<head[\s>]/i.test(body)
        ? body.replace(/<head([^>]*)>/i, `<head$1>${bridge}`)
        : bridge + body;
}

export function MixMechanismPanel({
    materialId,
    name,
    layout,
    html,
    state,
    store,
    onStore,
    onState,
    onSay,
    onBox,
}: {
    materialId: string;
    name: string;
    layout: MixPanelLayout;
    html: string;
    state: MixState;
    store: MixMechanismStore;
    onStore: (materialId: string, store: MixMechanismStore) => void;
    onState: (state: MixState) => void;
    onSay: (text: string) => void;
    /** 玩家拖动/缩放之后落库，只影响这一局 */
    onBox: (materialId: string, box: Box) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    /** 真正留给界面的那一块（把手条以下）：缩放按它算，不含应用自己画的外壳 */
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(!layout.collapsed);
    const [box, setBox] = useState<Box>(() => clampBox(boxOf(layout)));
    /** 最近一次上报给宿主的几何：同一个值不重复上报，免得来回激起重渲染 */
    const boxRef = useRef<Box | null>(null);
    /** 高度随内容时，界面量出来的像素高 */
    const [fitPx, setFitPx] = useState(0);
    /** 界面自己要求的排版宽度；没要求就用摆放里写的那个 */
    const [designPx, setDesignPx] = useState<number | null>(null);
    /**
     * 界面自己要求的宿主行为（能不能拖、要不要应用画外壳……）。
     * 没要求的项沿用摆放里写的——老材料照旧，新材料一律在代码里说。
     */
    const [flags, setFlags] = useState<{ drag?: boolean; resize?: boolean; chrome?: boolean; plate?: boolean; z?: number }>({});
    /** 正在拖 / 正在拉大小：拖动期间盖一层透明的捕获层，指针跑出 iframe 也不丢事件 */
    const [grabbing, setGrabbing] = useState<"" | "move" | "size">("");
    /** 正在拖的那一次。from 是起点，坐标都在「对局画面」这一层里算 */
    const dragRef = useRef<{ mode: "move" | "size"; from: { x: number; y: number } | null; box: Box } | null>(null);
    /** 界面内部起的拖，沙盒那一路：手指拖时事件被锁在 iframe 里，宿主收不到，只能由它报 */
    const frameDragRef = useRef<{ box: Box; layer: DOMRect; from: { x: number; y: number } } | null>(null);
    /** 面板此刻的实际像素宽高：按设计宽度缩放要用它 */
    const [size, setSize] = useState({ w: 0, h: 0 });

    // 界面说了算，界面没说才看摆放里写的
    const chrome = (flags.chrome ?? (layout.chrome ?? "bar") === "bar") ? "bar" : "none";
    const plate = flags.plate ?? layout.plate !== false;
    const canDrag = flags.drag ?? layout.drag !== false;
    const canResize = flags.resize ?? layout.resize === true;
    const zIndex = Math.min(MIX_PANEL_MAX_Z, Math.max(0, flags.z ?? layout.z ?? 0));

    // 材料被改过（编辑器里保存）时按新摆放重新落位；玩家在局内拖过的位置由 layout 带进来
    useEffect(() => { setBox(clampBox(boxOf(layout))); }, [layout.x, layout.y, layout.w, layout.h]);

    // 面板实际有多大：换机型、拖动、缩放都会变，得一直盯着
    useEffect(() => {
        const node = stageRef.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const read = () => {
            const rect = node.getBoundingClientRect();
            setSize((prev) => (Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5
                ? prev
                : { w: rect.width, h: rect.height }));
        };
        read();
        const observer = new ResizeObserver(read);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    /**
     * 界面按多宽排版。作者填了设计宽度就按那个宽度排，再整体缩放到面板实际大小——
     * 一台 390 宽的手机塞进 180 宽的面板里，靠的是缩小，不是让字挤成一团。
     */
    const designWidth = designPx === null ? layout.designWidth ?? 0 : designPx;
    const scale = designWidth && size.w > 0 ? size.w / designWidth : 1;

    // srcDoc 只在界面代码变化时重算：state/store 走消息推送，不能进这里，
    // 否则每次值一变 iframe 就重新加载，等于没有"常驻"
    const srcDoc = useMemo(
        () => buildPanelDoc(html, state, store, layout.autoHeight === true),
        [html, layout.autoHeight], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const post = useCallback((payload: Record<string, unknown>) => {
        try {
            frameRef.current?.contentWindow?.postMessage({ source: "mix-panel-host", ...payload }, "*");
        } catch {
            // 递不进去就算了，下一次同步还会再试
        }
    }, []);

    const syncedRef = useRef("");
    useEffect(() => {
        // 只在内容真的变了才推。宿主每次重渲染都推一次的话，界面在 onMixSync 里
        // 顺手改一下自己（挪位置、写存储）就会绕回来，转成停不下来的循环。
        const snapshot = JSON.stringify({ state, store });
        if (snapshot === syncedRef.current) return;
        syncedRef.current = snapshot;
        post({ state, store });
    }, [state, store, post]);

    /** 最新的 state/store：boot 补推发生在消息回调里，闭包里的是旧引用，得走 ref */
    const latestSyncRef = useRef({ state, store });
    latestSyncRef.current = { state, store };

    /** 把一次几何变化落到面板上；拖完（commit）才写进对局 */
    const applyBox = useCallback((next: Box, commit: boolean) => {
        const clamped = clampBox(next);
        setBox((current) => (current.x === clamped.x && current.y === clamped.y
            && current.w === clamped.w && current.h === clamped.h ? current : clamped));
        // 值没变就不用惊动宿主——界面反复调 mix.size 求同一个尺寸是常事
        if (commit && !sameBox(boxRef.current, clamped)) { boxRef.current = clamped; onBox(materialId, clamped); }
    }, [materialId, onBox]);

    // ── 拖动与缩放 ──────────────────────────────────────
    // 指针一旦按下就盖一层覆盖全画面的透明层：iframe 会吃掉落在它身上的
    // pointermove，隔着它拖会走走停停，只有把事件收到宿主自己的元素上才顺。
    const startGrab = useCallback((mode: "move" | "size", from?: { x: number; y: number }) => {
        dragRef.current = { mode, from: from ?? null, box };
        setGrabbing(mode);
    }, [box]);

    useEffect(() => {
        if (!grabbing) return;
        const layer = rootRef.current?.parentElement;
        const rect = layer?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) { setGrabbing(""); return; }

        const move = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (!drag.from) { drag.from = { x: event.clientX, y: event.clientY }; return; }
            const dx = (event.clientX - drag.from.x) / rect.width * 100;
            const dy = (event.clientY - drag.from.y) / rect.height * 100;
            if (drag.mode === "move") {
                applyBox({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }, false);
            } else {
                applyBox({ ...drag.box, w: drag.box.w + dx, h: drag.box.h + dy }, false);
            }
        };
        const stop = () => {
            dragRef.current = null;
            setGrabbing("");
            setBox((current) => {
                if (!sameBox(boxRef.current, current)) { boxRef.current = current; onBox(materialId, current); }
                return current;
            });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
        };
    }, [grabbing, applyBox, materialId, onBox]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data as (Record<string, unknown> & { source?: string }) | null;
            if (!data || data.source !== "mix-panel") return;
            const command = data as unknown as PanelCommand;
            switch (command.name) {
                case "boot": {
                    // iframe（重）启动完成。退后台被系统回收的面板回前台时会拿旧文档重启，
                    // 文档里烘的快照已经过期——这里无条件把当前值补推一份，别管变没变。
                    const fresh = latestSyncRef.current;
                    syncedRef.current = JSON.stringify(fresh);
                    post({ ...fresh });
                    break;
                }
                case "setStore":
                    onStore(materialId, normalizeMechanismStore(command.store));
                    break;
                case "setState": {
                    // 与钩子同一套把关：只收数字与短文本，其余丢掉
                    const raw = command.state;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch: MixState = {};
                    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                        const name2 = key.trim().slice(0, 40);
                        if (!name2) continue;
                        if (typeof value === "number" && Number.isFinite(value)) patch[name2] = value;
                        else if (typeof value === "string" && value.trim()) patch[name2] = value.trim().slice(0, 200);
                        if (Object.keys(patch).length >= 50) break;
                    }
                    if (Object.keys(patch).length) onState(patch);
                    break;
                }
                case "say": {
                    const text = String(command.text ?? "").trim().slice(0, MAX_SAY_LENGTH);
                    if (text) onSay(text);
                    break;
                }
                case "setOpen":
                    setOpen(command.open !== false);
                    break;
                case "box": {
                    // 界面自己挪自己：只认数字，缺的那一维保持原样，越界照样夹
                    const raw = command.box;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch = raw as Record<string, unknown>;
                    setBox((current) => {
                        const pick = (key: keyof Box) => {
                            const value = Number(patch[key]);
                            return Number.isFinite(value) ? value : current[key];
                        };
                        const next = clampBox({ x: pick("x"), y: pick("y"), w: pick("w"), h: pick("h") });
                        if (sameBox(current, next)) return current;
                        if (!sameBox(boxRef.current, next)) { boxRef.current = next; onBox(materialId, next); }
                        return next;
                    });
                    break;
                }
                case "flag": {
                    const key = String(command.key ?? "");
                    if (key === "z") {
                        const n = Number(command.on);
                        if (Number.isFinite(n)) setFlags((prev) => ({ ...prev, z: Math.min(MIX_PANEL_MAX_Z, Math.max(0, Math.round(n))) }));
                        break;
                    }
                    if (key !== "drag" && key !== "resize" && key !== "chrome" && key !== "plate") break;
                    const on = command.on !== false;
                    setFlags((prev) => (prev[key] === on ? prev : { ...prev, [key]: on }));
                    break;
                }
                case "design": {
                    const px = Number(command.px);
                    // 0 表示"不按固定宽度排，直接跟着面板走"
                    if (!Number.isFinite(px)) break;
                    setDesignPx(px <= 0 ? 0 : Math.min(1600, Math.max(120, Math.round(px))));
                    break;
                }
                case "fit": {
                    const px = Number(command.px);
                    // 上限拦一手：界面里写出高度反馈环时，别让宿主去布局一个几十万像素高的元素
                    if (Number.isFinite(px) && px >= 0) setFitPx(Math.min(4000, Math.ceil(px)));
                    break;
                }
                case "grab": {
                    if (!canDrag) break;
                    const layer = rootRef.current?.parentElement?.getBoundingClientRect();
                    const frame = frameRef.current?.getBoundingClientRect();
                    if (!layer?.width || !layer.height || !frame) break;
                    const cx = Number(command.cx);
                    const cy = Number(command.cy);
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) break;
                    // 起点换算到「对局画面」这一层：这一格左上角的位置 + 在这一格里的坐标
                    const from = { x: frame.left - layer.left + cx * scale, y: frame.top - layer.top + cy * scale };
                    // 两路一起开：鼠标走宿主那一路（盖一层捕获层把事件收上来），
                    // 手指走沙盒那一路（事件被锁在 iframe 里，只能由它报）。
                    // 两边都用同一个起点、同一份快照，同时到也只会算出同一个位置。
                    setBox((current) => {
                        frameDragRef.current = { box: current, layer, from };
                        dragRef.current = {
                            mode: "move",
                            from: { x: layer.left + from.x, y: layer.top + from.y },
                            box: current,
                        };
                        return current;
                    });
                    setGrabbing("move");
                    break;
                }
                case "drag": {
                    const drag = frameDragRef.current;
                    if (!drag) break;
                    const cx = Number(command.cx);
                    const cy = Number(command.cy);
                    const frame = frameRef.current?.getBoundingClientRect();
                    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !frame) break;
                    // 这一格已经跟着面板挪过了，所以「这一格现在在哪 + 格内坐标」
                    // 得到的就是指针此刻的真实位置，面板挪多少都不会自我追尾
                    const nowX = frame.left - drag.layer.left + cx * scale;
                    const nowY = frame.top - drag.layer.top + cy * scale;
                    applyBox({
                        ...drag.box,
                        x: drag.box.x + (nowX - drag.from.x) / drag.layer.width * 100,
                        y: drag.box.y + (nowY - drag.from.y) / drag.layer.height * 100,
                    }, false);
                    break;
                }
                case "dragEnd":
                    if (!frameDragRef.current) break;
                    frameDragRef.current = null;
                    dragRef.current = null;
                    setGrabbing("");
                    setBox((current) => {
                        if (!sameBox(boxRef.current, current)) { boxRef.current = current; onBox(materialId, current); }
                        return current;
                    });
                    break;
                default:
                    // 白名单以外一律不理会
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [materialId, onStore, onState, onSay, onBox, canDrag, applyBox, scale, post]);

    const style: React.CSSProperties = {
        left: `${box.x}%`,
        top: `${box.y}%`,
        width: `${box.w}%`,
        zIndex,
    };
    if (!open && chrome === "bar") {
        // 收起来就只剩那条把手，高度跟着缩掉——否则原地留一个空盒子，等于没收起来
        style.height = "auto";
    } else if (layout.autoHeight) {
        // 高度随内容：h 退化成上限，量出来之前先给一点点高度免得闪一大块
        style.height = "auto";
        style.maxHeight = `${box.h}%`;
    } else {
        style.height = `${box.h}%`;
    }

    return (
        <div
            ref={rootRef}
            className="mix-panel"
            data-open={open ? "true" : undefined}
            data-plate={plate ? undefined : "false"}
            data-chrome={chrome}
            data-grabbing={grabbing || undefined}
            style={style}
        >
            {chrome === "bar" ? (
                <div
                    className="mix-panel-bar"
                    onPointerDown={(event) => {
                        if (!canDrag || event.button !== 0) return;
                        startGrab("move", { x: event.clientX, y: event.clientY });
                    }}
                >
                    <span className="mix-panel-tab-name">{name}</span>
                    <button
                        type="button"
                        className="mix-panel-fold"
                        onClick={() => setOpen((v) => !v)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={`${open ? "收起" : "展开"}${name}`}
                    >
                        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                    </button>
                </div>
            ) : null}
            {open || chrome === "none" ? (
                <div
                    ref={stageRef}
                    className="mix-panel-stage"
                    style={layout.autoHeight && fitPx ? { flex: "0 0 auto", height: fitPx } : undefined}
                >
                    <iframe
                        ref={frameRef}
                        className="mix-panel-frame"
                        title={name}
                        sandbox="allow-scripts"
                        srcDoc={srcDoc}
                        style={
                            scale !== 1
                                ? {
                                    // 按设计宽度铺开再整体缩回来：iframe 里的一切都以为自己在
                                    // designWidth 宽的屏幕上，排版才不会随面板大小走样
                                    width: designWidth,
                                    height: size.h > 0 ? size.h / scale : "100%",
                                    transform: `scale(${scale})`,
                                    transformOrigin: "top left",
                                }
                                : undefined
                        }
                    />
                </div>
            ) : null}
            {canResize && open ? (
                <div
                    className="mix-panel-grip"
                    aria-hidden="true"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        startGrab("size", { x: event.clientX, y: event.clientY });
                    }}
                />
            ) : null}
            {/*
              * 拖动期间盖一层透明的捕获层。必须挂到 body 上：面板自己开了
              * backdrop-filter，会成为 fixed 子元素的包含块，挂在里面会被面板裁掉。
              */}
            {grabbing && typeof document !== "undefined"
                ? createPortal(<div className="mix-panel-catch" data-mode={grabbing} aria-hidden="true" />, document.body)
                : null}
        </div>
    );
}

/**
 * 内嵌形态的机括界面：按钮位（header/inputbar-*）打开的下拉/上升面板，
 * 与流内位（flow-top/flow-bottom）的内嵌卡共用这一个组件。
 * 与悬浮面板的差别只在"位置归宿主管"：宽度铺满容器、高度永远随内容（fit），
 * 拖动/缩放/挪位的白名单命令一律不理会；能做的事不变——写存储、写记住的值、
 * 以玩家身份发言、报高、要求设计宽度、开关底板。沙盒与消息协议完全同一套。
 */
export function MixMechanismInline({
    materialId,
    name,
    html,
    state,
    store,
    plateDefault,
    onStore,
    onState,
    onSay,
}: {
    materialId: string;
    name: string;
    html: string;
    state: MixState;
    store: MixMechanismStore;
    /** 摆放里的底板偏好（layout.plate），界面代码里 mix.plate() 说了算 */
    plateDefault?: boolean;
    onStore: (materialId: string, store: MixMechanismStore) => void;
    onState: (state: MixState) => void;
    onSay: (text: string) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [fitPx, setFitPx] = useState(0);
    const [designPx, setDesignPx] = useState<number | null>(null);
    const [plateFlag, setPlateFlag] = useState<boolean | null>(null);
    const [width, setWidth] = useState(0);

    const plate = plateFlag ?? plateDefault ?? false;

    useEffect(() => {
        const node = stageRef.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const read = () => {
            const rect = node.getBoundingClientRect();
            setWidth((prev) => (Math.abs(prev - rect.width) < 0.5 ? prev : rect.width));
        };
        read();
        const observer = new ResizeObserver(read);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // 内嵌卡的高度只能随内容走，所以量高桥永远开着
    const srcDoc = useMemo(() => buildPanelDoc(html, state, store, true), [html]); // eslint-disable-line react-hooks/exhaustive-deps

    const post = useCallback((payload: Record<string, unknown>) => {
        try {
            frameRef.current?.contentWindow?.postMessage({ source: "mix-panel-host", ...payload }, "*");
        } catch { /* 递不进去就等下一次同步 */ }
    }, []);

    const syncedRef = useRef("");
    useEffect(() => {
        const snapshot = JSON.stringify({ state, store });
        if (snapshot === syncedRef.current) return;
        syncedRef.current = snapshot;
        post({ state, store });
    }, [state, store, post]);

    /** 最新的 state/store：boot 补推发生在消息回调里，闭包里的是旧引用，得走 ref */
    const latestSyncRef = useRef({ state, store });
    latestSyncRef.current = { state, store };

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data as (Record<string, unknown> & { source?: string }) | null;
            if (!data || data.source !== "mix-panel") return;
            const command = data as unknown as PanelCommand;
            switch (command.name) {
                case "boot": {
                    // 同悬浮面板：iframe 重启后拿的是旧文档快照，无条件补推当前值
                    const fresh = latestSyncRef.current;
                    syncedRef.current = JSON.stringify(fresh);
                    post({ ...fresh });
                    break;
                }
                case "setStore":
                    onStore(materialId, normalizeMechanismStore(command.store));
                    break;
                case "setState": {
                    const raw = command.state;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch: MixState = {};
                    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                        const name2 = key.trim().slice(0, 40);
                        if (!name2) continue;
                        if (typeof value === "number" && Number.isFinite(value)) patch[name2] = value;
                        else if (typeof value === "string" && value.trim()) patch[name2] = value.trim().slice(0, 200);
                        if (Object.keys(patch).length >= 50) break;
                    }
                    if (Object.keys(patch).length) onState(patch);
                    break;
                }
                case "say": {
                    const text = String(command.text ?? "").trim().slice(0, MAX_SAY_LENGTH);
                    if (text) onSay(text);
                    break;
                }
                case "fit": {
                    const px = Number(command.px);
                    if (Number.isFinite(px) && px >= 0) setFitPx(Math.min(4000, Math.ceil(px)));
                    break;
                }
                case "design": {
                    const px = Number(command.px);
                    if (!Number.isFinite(px)) break;
                    setDesignPx(px <= 0 ? 0 : Math.min(1600, Math.max(120, Math.round(px))));
                    break;
                }
                case "flag": {
                    if (String(command.key ?? "") !== "plate") break;
                    setPlateFlag(command.on !== false);
                    break;
                }
                default:
                    // 位置类命令（box/grab/drag/setOpen…）在内嵌形态下没有意义，一律不理会
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [materialId, onStore, onState, onSay, post]);

    const designWidth = designPx === null ? 0 : designPx;
    const scale = designWidth && width > 0 ? width / designWidth : 1;
    const height = Math.max(24, fitPx || 48);

    return (
        <div className="mix-inline-panel" data-plate={plate ? "true" : undefined}>
            <div ref={stageRef} className="mix-inline-stage" style={{ height }}>
                <iframe
                    ref={frameRef}
                    className="mix-panel-frame"
                    title={name}
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                    style={
                        scale !== 1
                            ? { width: designWidth, height: height / scale, transform: `scale(${scale})`, transformOrigin: "top left" }
                            : undefined
                    }
                />
            </div>
        </div>
    );
}
