"use client";

// lib/mixology/mechanism-runtime.ts
// 独家特调 · 机括钩子的沙盒宿主。
//
// 隔离靠三层，缺一不可：
// ① sandbox="allow-scripts" 且不给 allow-same-origin —— 沙盒拿到的是不透明源，
//    碰不到宿主页面的 DOM、localStorage、IndexedDB，也读不到别的 iframe。
// ② 文档内声明 default-src 'none' 的 CSP —— 断掉 fetch / XHR / WebSocket /
//    图片信标等一切出站途径。第①层挡的是"读宿主"，这一层挡的是"往外送"，
//    机括看得到对话内容，不能把它发到任何地方去。
// ③ 超时熔断 —— 到点没还结果就掐掉，这一轮当作没有机括。死循环拖不垮对局。
//
// 通道上只跑一件事：应用递一份数据包，沙盒还一份结果。没有别的指令。

import {
    normalizeHookResult,
    type MixHook,
    type MixHookPayload,
    type MixHookResult,
} from "./mechanism-protocol";

/** 单次钩子的执行上限：超时就掐，这一轮当作没有机括 */
export const MIX_HOOK_TIMEOUT_MS = 2_000;
/** 沙盒空闲多久后回收（同一局里连着几轮都会用到，不必每轮重建） */
const IDLE_DISPOSE_MS = 120_000;

type PendingCall = {
    resolve: (result: MixHookResult) => void;
    timer: number;
};

/**
 * 沙盒里跑的引导代码。
 * 机括作者写的是几个可选函数：
 *   function onSessionStart(ctx) {}
 *   function onBeforeSend(ctx) { return { text: ... } }
 *   function onAfterReply(ctx) { return { state: { 好感度: 61 } } }
 *   function onSessionEnd(ctx) {}
 * 返回值必须是能结构化克隆的普通对象；返回别的（函数、DOM、循环引用）会被
 * postMessage 拒绝，这里兜住并当作「没有返回」处理。
 */
/** 作者代码里出现 </script 会提前闭合标签，转义掉 */
function escapeScriptEnd(code: string): string {
    return code.replace(/<\/(script)/gi, "<\\/$1");
}

/** 内层 Worker 的超时：比宿主侧短一档，让"掐掉并回话"发生在宿主兜底之前 */
const WORKER_TIMEOUT_MS = 1_500;

/**
 * 沙盒是两层套的，各管一件事：
 * - 外层 iframe：sandbox="allow-scripts" 无 same-origin（不透明源，碰不到宿主），
 *   加 CSP 断掉一切出站。它只负责隔离与转发，自己不跑作者代码。
 * - 内层 Worker：真正跑作者代码的地方。选 Worker 是因为它能被 terminate() 强杀——
 *   iframe 里的 while(true) 就算把 iframe 从 DOM 摘掉也停不下来，会一直烧着 CPU
 *   把后面每一次调用都拖垮；Worker 是唯一能真正掐断死循环的办法。
 */
function buildBootstrap(script: string): string {
    const tag = "script";
    // Worker 里跑的东西：作者代码 + 一个派发器。作者代码单独成段拼进去，
    // 语法错误只让 Worker 起不来，外层通道照常活着。
    // 出网能力在作者代码之前就删掉。实测 CSP 的 connect-src 不能可靠地继承进
    // blob: Worker（fetch 照样发得出去），所以不能只靠 CSP。
    // Worker 里没有 DOM，拿不到新的 realm，删掉就是真的没有——这也是选 Worker
    // 而不是在 iframe 里跑作者代码的又一个理由：iframe 里可以再开一个 iframe 把
    // 原版函数偷回来，Worker 里没有这条路。嵌套 Worker 同理必须堵死。
    const lockdown = `(function(){
  var gone = ["fetch","XMLHttpRequest","WebSocket","EventSource","importScripts",
              "Worker","SharedWorker","BroadcastChannel","indexedDB","caches",
              "Request","Response","openDatabase"];
  for (var i = 0; i < gone.length; i++) {
    try { delete self[gone[i]]; } catch (e) {}
    try { Object.defineProperty(self, gone[i], { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  try { delete self.navigator.sendBeacon; } catch (e) {}
  try { Object.defineProperty(self.navigator, "sendBeacon", { value: undefined, configurable: false, writable: false }); } catch (e) {}
})();`;
    const workerSource = `${lockdown}
${script}
;self.onmessage = function (event) {
  var data = event.data || {};
  var names = { sessionStart: "onSessionStart", beforeSend: "onBeforeSend", rawReply: "onRawReply", afterReply: "onAfterReply", sessionEnd: "onSessionEnd" };
  var fn = self[names[data.hook]];
  if (typeof fn !== "function") { self.postMessage({ callId: data.callId, json: "" }); return; }
  function done(value) {
    var json = "";
    // 统一走 JSON：函数、undefined、DOM 残留会被自然丢掉，循环引用在这里抛错
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { json = ""; }
    self.postMessage({ callId: data.callId, json: json || "" });
  }
  var out = null;
  try { out = fn(data.payload); } catch (err) { self.postMessage({ callId: data.callId, json: "" }); return; }
  if (out && typeof out.then === "function") { out.then(done, function () { done(null); }); return; }
  done(out);
};`;
    const boot = `(function(){"use strict";
  var worker = null, url = "", timers = {};
  function spawn(){
    try{
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], {type:"text/javascript"}));
      worker = new Worker(url);
      worker.onmessage = function(e){
        var d = e.data || {};
        if (timers[d.callId]) { clearTimeout(timers[d.callId]); delete timers[d.callId]; }
        reply(d.callId, d.json);
      };
      worker.onerror = function(){ /* 作者代码起不来：后续调用一律走超时兜底 */ };
    }catch(err){ worker = null; }
  }
  function reply(callId, json){
    var result = null;
    try{ result = json ? JSON.parse(json) : null; }catch(e){ result = null; }
    try{ parent.postMessage({source:"mix-mechanism",callId:callId,result:result},"*"); }catch(e){}
  }
  function kill(){
    try{ worker && worker.terminate(); }catch(e){}
    try{ url && URL.revokeObjectURL(url); }catch(e){}
    worker = null;
    spawn();
  }
  window.addEventListener("message", function(event){
    var data = event.data;
    if(!data || data.source !== "mix-mechanism-host" || typeof data.callId !== "number") return;
    if(!worker){ reply(data.callId, ""); return; }
    timers[data.callId] = setTimeout(function(){
      delete timers[data.callId];
      // 到点没回话：多半是死循环，强杀并立刻重建，下一次调用还能用
      kill();
      reply(data.callId, "");
    }, ${WORKER_TIMEOUT_MS});
    try{ worker.postMessage({ callId: data.callId, hook: data.hook, payload: data.payload }); }
    catch(e){ clearTimeout(timers[data.callId]); delete timers[data.callId]; reply(data.callId, ""); }
  });
  spawn();
  parent.postMessage({source:"mix-mechanism",ready:true},"*");
})();`;
    return [
        '<!doctype html><html><head><meta charset="utf-8"/>',
        // default-src 'none' 断掉一切出站（fetch / XHR / WebSocket / 图片信标）；
        // 只额外放行 blob: 的脚本与 worker，否则内层 Worker 起不来。
        // 注意不给 'unsafe-eval'：作者代码是当成脚本文本喂给 Worker 的，不需要 eval。
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; worker-src blob:; child-src blob:; style-src \'unsafe-inline\'"/>',
        "</head><body>",
        `<${tag}>var WORKER_SOURCE = ${JSON.stringify(workerSource)};</${tag}>`,
        `<${tag}>${escapeScriptEnd(boot)}</${tag}>`,
        "</body></html>",
    ].join("");
}

/** 一件机括在一个对局里的沙盒实例 */
class MechanismSandbox {
    private frame: HTMLIFrameElement | null = null;
    private pending = new Map<number, PendingCall>();
    private nextCallId = 1;
    private idleTimer = 0;
    /** 沙盒引导完成的信号：srcdoc 解析完之前 postMessage 会丢，必须等它先说话 */
    private ready: Promise<void> | null = null;
    private markReady: (() => void) | null = null;
    private readonly onMessage: (event: MessageEvent) => void;

    constructor(private readonly script: string) {
        this.onMessage = (event: MessageEvent) => {
            if (!this.frame || event.source !== this.frame.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-mechanism") return;
            if (data.ready === true) { this.markReady?.(); return; }
            const callId = Number(data.callId);
            const call = this.pending.get(callId);
            if (!call) return;
            this.pending.delete(callId);
            window.clearTimeout(call.timer);
            call.resolve(normalizeHookResult(data.result));
        };
    }

    private ensureFrame(): HTMLIFrameElement {
        if (this.frame) return this.frame;
        this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px";
        frame.srcdoc = buildBootstrap(this.script);
        document.body.appendChild(frame);
        window.addEventListener("message", this.onMessage);
        this.frame = frame;
        return frame;
    }

    private touch(): void {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => this.dispose(), IDLE_DISPOSE_MS);
    }

    async invoke(hook: MixHook, payload: MixHookPayload): Promise<MixHookResult> {
        if (typeof window === "undefined" || typeof document === "undefined") return {};
        const frame = this.ensureFrame();
        this.touch();
        const callId = this.nextCallId++;
        return new Promise<MixHookResult>((resolve) => {
            const timer = window.setTimeout(() => {
                this.pending.delete(callId);
                // 超时通常意味着死循环，沙盒已经废了——整个回收，下次重建
                this.dispose();
                resolve({});
            }, MIX_HOOK_TIMEOUT_MS);
            this.pending.set(callId, { resolve, timer });
            // 注意不要去读 frame.contentWindow.document：沙盒没有 same-origin，
            // 那一下会抛跨域错误，整个调用会静默变成"没有机括"。
            void (this.ready ?? Promise.resolve()).then(() => {
                try {
                    frame.contentWindow?.postMessage({ source: "mix-mechanism-host", callId, hook, payload }, "*");
                } catch {
                    // 递不进去就当没有机括，超时兜底
                }
            });
        });
    }

    dispose(): void {
        window.clearTimeout(this.idleTimer);
        for (const call of this.pending.values()) {
            window.clearTimeout(call.timer);
            call.resolve({});
        }
        this.pending.clear();
        window.removeEventListener("message", this.onMessage);
        this.frame?.remove();
        this.frame = null;
        this.ready = null;
        this.markReady = null;
    }
}

/** 对局 × 机括 → 沙盒。同一局里连着几轮复用同一个实例 */
const sandboxes = new Map<string, MechanismSandbox>();

function sandboxKey(sessionId: string, materialId: string): string {
    return `${sessionId}::${materialId}`;
}

/** 跑一次钩子；沙盒没建就现建。任何异常都收敛成空结果 */
export async function runMixHook(
    sessionId: string,
    materialId: string,
    script: string,
    hook: MixHook,
    payload: MixHookPayload,
): Promise<MixHookResult> {
    if (!script.trim()) return {};
    const key = sandboxKey(sessionId, materialId);
    let sandbox = sandboxes.get(key);
    if (!sandbox) {
        sandbox = new MechanismSandbox(script);
        sandboxes.set(key, sandbox);
    }
    try {
        return await sandbox.invoke(hook, payload);
    } catch {
        return {};
    }
}

/** 退出对局时收掉这一局的全部沙盒 */
export function disposeMixSandboxes(sessionId: string): void {
    for (const [key, sandbox] of [...sandboxes.entries()]) {
        if (!key.startsWith(`${sessionId}::`)) continue;
        sandbox.dispose();
        sandboxes.delete(key);
    }
}

/** 材料被改过之后旧沙盒里跑的还是老代码，编辑保存时清掉 */
export function disposeMixSandboxesForMaterial(materialId: string): void {
    for (const [key, sandbox] of [...sandboxes.entries()]) {
        if (!key.endsWith(`::${materialId}`)) continue;
        sandbox.dispose();
        sandboxes.delete(key);
    }
}
