// lib/chat-plugin-loader.ts
// 聊天插件系统 · 加载器：把插件 ES Module 源码经 Blob URL 动态 import 变成可执行模块。
// 方案 B：插件与宿主同环境执行（无沙盒）—— 安装时已向用户明示风险。

import type { ChatPluginModule } from "./chat-plugin-types";
import { loadChatPlugins, persistChatPlugin, validateChatPluginManifest } from "./chat-plugin-storage";

/**
 * 执行插件源码并校验模块形状。
 * 注意：import 即执行模块顶层代码 —— 安装校验与运行加载共用本函数。
 */
export async function loadChatPluginModule(code: string): Promise<{ module?: ChatPluginModule; error?: string }> {
    if (typeof window === "undefined") return { error: "插件只能在浏览器环境加载" };
    let url = "";
    try {
        const blob = new Blob([code], { type: "text/javascript" });
        url = URL.createObjectURL(blob);
        // webpackIgnore：这是运行时用户代码，不能让打包器静态分析
        const mod: unknown = await import(/* webpackIgnore: true */ url);
        const def = (mod as { default?: unknown })?.default;
        if (!def || typeof def !== "object") {
            return { error: "插件必须 export default { manifest, setup }" };
        }
        const candidate = def as Partial<ChatPluginModule>;
        const { manifest, error } = validateChatPluginManifest(candidate.manifest);
        if (!manifest) return { error };
        if (typeof candidate.setup !== "function") {
            return { error: "default 导出缺少 setup(ctx) 函数" };
        }
        return { module: { manifest, setup: candidate.setup } };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `插件脚本执行失败：${message}` };
    } finally {
        if (url) URL.revokeObjectURL(url);
    }
}

/** 安装（或同 id 升级）一个插件：执行校验 → 落库；运行时监听存储变化自动加载。
 * 同 id 覆盖安装 = 升级：settings 与插件私有数据全部保留（uninstall 才会清）。 */
export async function installChatPluginFromCode(code: string, opts?: {
    /** 更新场景：要求源码里的 manifest.id 必须等于该值，防止把别的插件误装成"更新" */
    expectedId?: string;
}): Promise<{
    ok: boolean; error?: string; name?: string;
    /** 同 id 覆盖升级（而非新装） */
    upgraded?: boolean; fromVersion?: string; toVersion?: string;
}> {
    const trimmed = code.trim();
    if (!trimmed) return { ok: false, error: "插件源码为空" };
    const { module, error } = await loadChatPluginModule(trimmed);
    if (!module) return { ok: false, error };
    if (opts?.expectedId && module.manifest.id !== opts.expectedId) {
        return { ok: false, error: `这份代码的插件 id（${module.manifest.id}）与当前插件（${opts.expectedId}）不一致，不是它的新版本` };
    }
    const existing = loadChatPlugins().find(p => p.manifest.id === module.manifest.id);
    const persisted = persistChatPlugin(module.manifest, trimmed);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    return {
        ok: true,
        name: module.manifest.name,
        upgraded: !!existing,
        fromVersion: existing?.manifest.version,
        toVersion: module.manifest.version,
    };
}
