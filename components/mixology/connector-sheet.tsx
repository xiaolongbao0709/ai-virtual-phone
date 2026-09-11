"use client";

// 独家特调 · 连接器管理（酒柜页头部打开的底部弹层）。
// 连接器是玩家自己的外部接口配置：名字、地址、请求头（密钥在这）、请求体模板。
// 机括材料只声明名字，界面里 mix.call(名字, 参数) 由宿主代调（见 lib/mixology/connectors）。
// 不是材料：不进酒柜列表、不导出、不上大厅，永远只留在本机。

import { useEffect, useState } from "react";
import { Plug, Trash2, X } from "lucide-react";
import type { MixConnector, MixConnectorResponse } from "@/lib/mixology/types";
import { createMixId, MIX_CONNECTOR_NAME_RE } from "@/lib/mixology/types";
import { deleteMixConnector, loadMixConnectors, MIX_CONNECTORS_UPDATED_EVENT, saveMixConnector } from "@/lib/mixology/storage";
import {
    formatMixConnectorHeaders,
    MIX_CONNECTOR_PRESETS,
    normalizeMixConnectorParams,
    parseMixConnectorHeaders,
    runMixConnector,
} from "@/lib/mixology/connectors";
import { MixConfirm } from "./mixology-shared";

type Draft = {
    id: string;
    name: string;
    note: string;
    url: string;
    method: "POST" | "GET";
    headersText: string;
    body: string;
    response: MixConnectorResponse;
    preset?: string;
    createdAt: number;
};

function draftOf(connector?: MixConnector): Draft {
    return {
        id: connector?.id ?? createMixId("mixconn"),
        name: connector?.name ?? "",
        note: connector?.note ?? "",
        url: connector?.url ?? "",
        method: connector?.method ?? "POST",
        headersText: formatMixConnectorHeaders(connector?.headers),
        body: connector?.body ?? "",
        response: connector?.response ?? "json",
        preset: connector?.preset,
        createdAt: connector?.createdAt ?? Date.now(),
    };
}

/** 请求头里像密钥的值打码显示：列表页别把密钥亮出来 */
function maskSecrets(headers: Record<string, string>): string {
    return Object.entries(headers)
        .filter(([key]) => /authorization|key|token|secret/i.test(key))
        .map(([key, value]) => `${key}: ${value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-3)}` : "•••"}`)
        .join(" · ");
}

export function MixConnectorSheet({ onClose, onToast }: { onClose: () => void; onToast: (message: string) => void }) {
    const [list, setList] = useState<MixConnector[]>(() => loadMixConnectors());
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState("");
    const [removing, setRemoving] = useState<MixConnector | null>(null);
    // 试调用：参数 JSON + 结果摘要
    const [testParams, setTestParams] = useState('{ "text": "你好，这是一次连接器测试。" }');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState("");

    useEffect(() => {
        const refresh = () => setList(loadMixConnectors());
        window.addEventListener(MIX_CONNECTORS_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(MIX_CONNECTORS_UPDATED_EVENT, refresh);
    }, []);

    const openEditor = (connector?: MixConnector) => {
        setDraft(draftOf(connector));
        setError("");
        setTestResult("");
    };

    const applyPreset = (presetId: string) => {
        const preset = MIX_CONNECTOR_PRESETS.find((p) => p.id === presetId);
        if (!preset || !draft) return;
        const built = preset.build();
        setDraft({
            ...draft,
            name: draft.name || built.name,
            note: built.note ?? "",
            url: built.url,
            method: built.method,
            headersText: formatMixConnectorHeaders(built.headers),
            body: built.body,
            response: built.response,
            preset: preset.id,
        });
        setError("");
    };

    const toConnector = (): MixConnector | { err: string } => {
        if (!draft) return { err: "没有正在编辑的连接器。" };
        const name = draft.name.trim().toLowerCase();
        if (!MIX_CONNECTOR_NAME_RE.test(name)) return { err: "名字只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 位。" };
        const url = draft.url.trim();
        try {
            const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, "x"));
            if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad");
        } catch {
            return { err: "地址要是完整的 http(s) 链接。" };
        }
        return {
            id: draft.id,
            name,
            note: draft.note.trim() || undefined,
            url,
            method: draft.method,
            headers: parseMixConnectorHeaders(draft.headersText),
            body: draft.body,
            response: draft.response,
            preset: draft.preset,
            createdAt: draft.createdAt,
            updatedAt: Date.now(),
        };
    };

    const handleSave = () => {
        const connector = toConnector();
        if ("err" in connector) { setError(connector.err); return; }
        const clash = list.find((c) => c.name === connector.name && c.id !== connector.id);
        saveMixConnector(connector);
        setList(loadMixConnectors());
        setDraft(null);
        onToast(clash ? `「${connector.name}」已保存，顶掉了原来同名的那件。` : `连接器「${connector.name}」已保存。`);
    };

    const handleTest = async () => {
        const connector = toConnector();
        if ("err" in connector) { setError(connector.err); return; }
        let params: unknown;
        try {
            params = JSON.parse(testParams || "{}");
        } catch {
            setError("试调用的参数不是合法 JSON。");
            return;
        }
        const normalized = normalizeMixConnectorParams(params);
        if ("err" in normalized) { setError(normalized.err); return; }
        setError("");
        setTesting(true);
        setTestResult("请求中…");
        try {
            const result = await runMixConnector(connector, normalized.params);
            if (!result.ok) { setTestResult(`失败：${result.error}`); return; }
            const preview = typeof result.data === "string"
                ? result.data.slice(0, 300)
                : JSON.stringify(result.data).slice(0, 300);
            setTestResult(`HTTP ${result.status} · ${preview}${preview.length >= 300 ? "…" : ""}`);
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">{draft ? (list.some((c) => c.id === draft.id) ? "编辑连接器" : "新建连接器") : "连接器"}</div>
                    <button type="button" className="mix-icon-btn" onClick={draft ? () => setDraft(null) : onClose} aria-label={draft ? "返回" : "关闭"}><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    {!draft ? (
                        <>
                            <div className="mix-struct-note" style={{ marginTop: 4 }}>
                                连接器是你自己的外部接口（地址、密钥、请求体模板都只存在本机）。机括材料只声明要用的名字，
                                界面点击时由应用代为发请求，材料自己碰不到密钥，数据也只会发往你填的地址。
                            </div>
                            {list.length ? (
                                <div className="mix-conn-list">
                                    {list.map((connector) => (
                                        <button type="button" className="mix-conn-row" key={connector.id} onClick={() => openEditor(connector)}>
                                            <span className="mix-conn-icon"><Plug size={15} /></span>
                                            <span className="mix-conn-main">
                                                <span className="mix-conn-name">{connector.name}</span>
                                                <span className="mix-conn-sub">{connector.note || connector.url}</span>
                                                {maskSecrets(connector.headers) ? <span className="mix-conn-sub">{maskSecrets(connector.headers)}</span> : null}
                                            </span>
                                            <span
                                                role="button"
                                                tabIndex={0}
                                                className="mix-icon-btn"
                                                aria-label={`删除连接器 ${connector.name}`}
                                                onClick={(e) => { e.stopPropagation(); setRemoving(connector); }}
                                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setRemoving(connector); } }}
                                            >
                                                <Trash2 size={15} />
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="mix-empty" style={{ padding: "26px 0" }}>还没有连接器。官方机括「朗读」需要一个叫 tts 的，用下面的预设一键建好。</div>
                            )}
                            <div className="mix-conn-actions">
                                <button type="button" className="mix-pill-btn" onClick={() => openEditor()}>自己写一个</button>
                                {MIX_CONNECTOR_PRESETS.map((preset) => (
                                    <button
                                        type="button"
                                        className="mix-pill-btn"
                                        data-tone="gold"
                                        key={preset.id}
                                        onClick={() => {
                                            const built = preset.build();
                                            setDraft({ ...draftOf(), name: built.name, note: built.note ?? "", url: built.url, method: built.method, headersText: formatMixConnectorHeaders(built.headers), body: built.body, response: built.response, preset: preset.id });
                                            setError("");
                                            setTestResult("");
                                        }}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="mix-conn-actions" style={{ marginTop: 4 }}>
                                {MIX_CONNECTOR_PRESETS.map((preset) => (
                                    <button type="button" className="mix-pill-btn" data-tone={draft.preset === preset.id ? "gold" : "ghost"} key={preset.id} onClick={() => applyPreset(preset.id)}>
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                            {draft.preset ? (
                                <div className="mix-form-note">{MIX_CONNECTOR_PRESETS.find((p) => p.id === draft.preset)?.note}</div>
                            ) : null}
                            <label className="mix-form-label">名字 · <b>机括按它找</b></label>
                            <input className="mix-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例：tts（小写字母、数字、-、_）" spellCheck={false} autoCapitalize="none" />
                            <label className="mix-form-label">备注</label>
                            <input className="mix-input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="给自己看的说明，选填" />
                            <label className="mix-form-label">地址 · <b>必填</b></label>
                            <input className="mix-input" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" spellCheck={false} autoCapitalize="none" />
                            <div className="mix-conn-two">
                                <label className="mix-conn-field">
                                    <span className="mix-form-label">方法</span>
                                    <select className="mix-input" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value === "GET" ? "GET" : "POST" })}>
                                        <option value="POST">POST</option>
                                        <option value="GET">GET</option>
                                    </select>
                                </label>
                                <label className="mix-conn-field">
                                    <span className="mix-form-label">响应交给机括的形式</span>
                                    <select className="mix-input" value={draft.response} onChange={(e) => setDraft({ ...draft, response: (e.target.value as MixConnectorResponse) })}>
                                        <option value="json">JSON（解析成对象）</option>
                                        <option value="text">文本</option>
                                        <option value="blob">二进制（音频/图片，转成 data: URL）</option>
                                    </select>
                                </label>
                            </div>
                            <label className="mix-form-label">请求头 · <b>密钥写在这</b></label>
                            <textarea
                                className="mix-textarea"
                                data-code="true"
                                style={{ minHeight: 80 }}
                                value={draft.headersText}
                                onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                                placeholder={"一行一条「名字: 值」，例：\nContent-Type: application/json\nAuthorization: Bearer sk-…"}
                                spellCheck={false}
                                autoCapitalize="none"
                            />
                            {draft.method === "POST" ? (
                                <>
                                    <label className="mix-form-label">请求体模板</label>
                                    <textarea
                                        className="mix-textarea"
                                        data-code="true"
                                        style={{ minHeight: 150 }}
                                        value={draft.body}
                                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                                        placeholder={'{{参数名}} 会换成机括 mix.call 传来的参数，{{参数名|默认值}} 可给默认值。模板是 JSON 时，替进去的字符串会自动转义。\n例：{ "text": "{{text}}", "voice": "{{voice|default}}" }'}
                                        spellCheck={false}
                                        autoCapitalize="none"
                                    />
                                </>
                            ) : (
                                <div className="mix-form-note">GET 没有请求体；参数写进地址，例：https://api.example.com/say?text{"={{text}}"}</div>
                            )}
                            <label className="mix-form-label">试调用 · <b>参数 JSON</b></label>
                            <textarea
                                className="mix-textarea"
                                data-code="true"
                                style={{ minHeight: 56 }}
                                value={testParams}
                                onChange={(e) => setTestParams(e.target.value)}
                                spellCheck={false}
                                autoCapitalize="none"
                            />
                            <div className="mix-conn-actions">
                                <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => void handleTest()} disabled={testing}>{testing ? "请求中…" : "发一次试试"}</button>
                                <button type="button" className="mix-pill-btn" onClick={handleSave}>保存</button>
                            </div>
                            {testResult ? <div className="mix-form-note" style={{ wordBreak: "break-all" }}>{testResult}</div> : null}
                            {error ? <div className="mix-form-error">{error}</div> : null}
                            <div className="mix-struct-note" style={{ marginTop: 10 }}>
                                接口需要允许浏览器跨域访问（CORS），否则请求发不出去。密钥只存本机，不随材料导出，也不会上大厅。
                            </div>
                        </>
                    )}
                </div>
            </div>
            {removing ? (
                <MixConfirm
                    title={`删除连接器「${removing.name}」？`}
                    body="用到它的机括会在调用时报「本机没有这个连接器」。"
                    confirmText="删除"
                    tone="danger"
                    onConfirm={() => { deleteMixConnector(removing.id); setList(loadMixConnectors()); setRemoving(null); }}
                    onCancel={() => setRemoving(null)}
                />
            ) : null}
        </div>
    );
}
