// lib/code-span-utils.ts
// 反引号代码范围判定：行内 `…` 或 ``` 围栏。
// 流式碎片下未闭合的反引号 / 围栏一律视为延伸到当前文本末尾
// （模型引用协议标签时常用反引号包裹，示例文字不该被当成真协议处理）。
// 与 lib/qa-agent-engine.ts 里工坊流式过滤器的 insideCode 同语义，抽出来给聊天链路共用。

const CODE_FENCE = "`" + "`" + "`";

/** index 是否落在反引号代码范围内（行内反引号或三反引号围栏） */
export function isInsideCodeSpan(text: string, index: number): boolean {
    let inFence = false;
    let inInline = false;
    for (let i = 0; i < index; i += 1) {
        if (text.startsWith(CODE_FENCE, i)) {
            inFence = !inFence;
            inInline = false;
            i += 2;
            continue;
        }
        if (inFence) continue;
        const ch = text[i];
        if (ch === "`") inInline = !inInline;
        else if (ch === "\n") inInline = false;
    }
    return inFence || inInline;
}