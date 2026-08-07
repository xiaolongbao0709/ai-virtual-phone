// ── 工坊可调偏好（叶子模块，避免循环依赖）─────────────
// 单页读取字符数：答疑文档翻页、本机内容/创作指南翻页、仓库文件单次读取共用。
// localStorage 键 ai_phone_qa_page_chars 覆盖（调参/测试用）。

export const QA_DEFAULT_PAGE_CHARS = 9000;
export const QA_PAGE_CHARS_MIN = 2_000;
export const QA_PAGE_CHARS_MAX = 100_000;

export function getQaPageChars(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_page_chars"));
        if (Number.isFinite(raw) && raw >= QA_PAGE_CHARS_MIN && raw <= QA_PAGE_CHARS_MAX) return Math.floor(raw);
    } catch {
        // ignore
    }
    return QA_DEFAULT_PAGE_CHARS;
}

/** 设置单页读取字符数（null = 恢复默认） */
export function setQaPageChars(chars: number | null): void {
    try {
        if (chars == null) localStorage.removeItem("ai_phone_qa_page_chars");
        else {
            const clamped = Math.min(QA_PAGE_CHARS_MAX, Math.max(QA_PAGE_CHARS_MIN, Math.floor(chars)));
            localStorage.setItem("ai_phone_qa_page_chars", String(clamped));
        }
    } catch {
        // ignore
    }
}

// 单轮工具调用上限：一次提问里 agent 最多连续执行多少轮工具，用完提示「回复继续」。
// localStorage 键 ai_phone_qa_max_rounds 覆盖（调参/测试用）。
export const QA_DEFAULT_MAX_ROUNDS = 8;
export const QA_MAX_ROUNDS_MIN = 1;
export const QA_MAX_ROUNDS_MAX = 50;

export function getQaMaxRounds(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_max_rounds"));
        if (Number.isFinite(raw) && raw >= QA_MAX_ROUNDS_MIN && raw <= QA_MAX_ROUNDS_MAX) return Math.floor(raw);
    } catch {
        // ignore
    }
    return QA_DEFAULT_MAX_ROUNDS;
}

/** 设置单轮工具调用上限（null = 恢复默认） */
export function setQaMaxRounds(rounds: number | null): void {
    try {
        if (rounds == null) localStorage.removeItem("ai_phone_qa_max_rounds");
        else {
            const clamped = Math.min(QA_MAX_ROUNDS_MAX, Math.max(QA_MAX_ROUNDS_MIN, Math.floor(rounds)));
            localStorage.setItem("ai_phone_qa_max_rounds", String(clamped));
        }
    } catch {
        // ignore
    }
}
