/**
 * 思维链翻译：调用绑定的「思维链翻译 API」（未设置时回退全局默认 API）
 * 把思考过程文本翻译成简体中文。带内存级缓存，避免重复请求计费。
 */
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const TRANSLATE_INSTRUCTION = [
    "你是专业翻译。把下面【待翻译内容】里的文字忠实翻译成自然、地道的简体中文。",
    "",
    "铁律（最重要，违反即失败）：",
    "- 这是「翻译」，不是「改写」「续写」或「表演」。原文表达什么意思，就译成什么意思，逐句对应。",
    "- 待翻译内容往往是 AI 的分析性思考过程（例如「用户发了张图，我应该自然地回应……」）。必须照实翻译这段分析本身，严禁把它演绎成角色的对白或内心戏，严禁添加原文没有的情绪、动作、神态、语气词或台词（如「轻笑」「歪头」「宝宝」之类原文没写的东西一律不许加）。",
    "- 只输出译文本身，不要复述以上要求，不删减、不扩写、不脑补、不解释、不评论。",
    "",
    "表达要求：",
    "- 用自然的中文，避免明显的翻译腔（欧化句式），但不得为了「读起来自然」而偏离、增删原意。",
    "- 人名、称呼、专有名词沿用原文或上下文中已有的译法，不要另起译名。",
    "- 保留原有段落结构与 Markdown 格式（加粗、列表等）。",
].join("\n");

/** 把指令和原文合并成一条 user 消息：有些模型对 system 服从度低，内联更可靠 */
function buildTranslateUserMessage(text: string): string {
    return `${TRANSLATE_INSTRUCTION}\n\n【待翻译内容】\n"""\n${text}\n"""`;
}

const cache = new Map<string, string>();
const CACHE_MAX = 50;

export async function translateReasoningText(
    text: string,
    options?: { signal?: AbortSignal },
): Promise<{ content?: string; error?: string }> {
    const trimmed = (text || "").trim();
    if (!trimmed) return { error: "没有可翻译的内容" };

    const cached = cache.get(trimmed);
    if (cached) return { content: cached };

    const apiConfig = resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId");
    if (!apiConfig) {
        return { error: "请先在设置 → 绑定配置 → 辅助 API 中设置思维链翻译 API（或设置全局默认 API）" };
    }

    // 默认 90 秒超时，避免请求挂死导致调用方一直处于「翻译中」状态
    const controller = options?.signal ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 90_000) : null;
    try {
        const result = await simpleLLMCall(apiConfig, [
            { role: "user", content: buildTranslateUserMessage(trimmed) },
        ], { temperature: 0.2, signal: options?.signal ?? controller?.signal });

        if (!result.content?.trim()) {
            return { error: result.error || "翻译失败，请重试" };
        }

        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(trimmed, result.content.trim());
        return { content: result.content.trim() };
    } catch (e) {
        if (controller?.signal.aborted) return { error: "翻译超时，请重试" };
        return { error: e instanceof Error ? e.message : "翻译失败，请重试" };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
