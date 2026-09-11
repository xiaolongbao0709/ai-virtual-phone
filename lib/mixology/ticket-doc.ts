// lib/mixology/ticket-doc.ts
// 小票 / 小剧场渲染文档的装配：renderHtml + 这一轮的壳内原文 → 一份完整 HTML。
// 对局里的实时渲染（ticket-frame）与发布前的缩略图抓拍（mat-thumb）共用同一份，
// 免得两边各拼各的，出来的东西对不上。

import type { MixState } from "./types";

function escapeHtmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * raw 经 {{RAW}} 模板直插（已转义）与 window.TICKET_RAW（JS 取用）两条路注入；
 * MIX_STATE 是这一局记住的值，渲染代码可以据此画血条、换配色。
 */
export function buildMixTicketDoc(html: string, raw: string, state?: MixState): string {
    const withRaw = html.split("{{RAW}}").join(escapeHtmlText(raw));
    const base = /<html[\s>]/i.test(withRaw)
        ? withRaw
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${withRaw}</body></html>`;
    const inject = `<script>window.TICKET_RAW=${JSON.stringify(raw)};window.ENCORE_RAW=window.TICKET_RAW;window.MIX_STATE=${JSON.stringify(state ?? {})};</` + `script>`;
    return /<head[\s>]/i.test(base)
        ? base.replace(/<head([^>]*)>/i, `<head$1>${inject}`)
        : inject + base;
}
