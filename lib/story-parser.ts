import type { RegexConfig } from "./settings-types";
import { applyAllOutputRegex, applyAllReasoningRegex } from "./llm-prompt-assembler";
import type { MacroEngine } from "./macro-engine";

export const STORY_PARSER_VERSION = 7;

export type ParsedStoryResponse = {
  rawText: string;
  renderedText: string;
  summaryText: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractXmlField(rawText: string, preferredTag?: string): string {
  const candidates = [preferredTag?.trim(), "summary"]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index) as string[];

  for (const tag of candidates) {
    const match = rawText.match(new RegExp(`<${escapeTagName(tag)}>([\\s\\S]*?)</${escapeTagName(tag)}>`, "i"));
    const content = match?.[1]?.trim();
    if (content) return content;
  }
  return "";
}

/** Convert `<tagname>...</tagname>` into renderer fold markers for each configured fold tag. */
function applyFoldTags(text: string, foldTags?: string): string {
  if (!foldTags) return text;
  const tags = Array.from(new Set(foldTags.split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const placeholders: { placeholder: string; label: string; content: string }[] = [];
  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>([\\s\\S]*?)<\\/\\1>`, "gi");
  const protectedText = text.replace(rx, (_match, tag: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return "";
    const placeholder = `\x00STORY_FOLD_${placeholders.length}\x00`;
    placeholders.push({
      placeholder,
      label: tag.toLowerCase(),
      content: trimmed,
    });
    return placeholder;
  });

  let result = protectedText;
  for (const { placeholder, label, content } of placeholders) {
    const replacement = `\n<!--RHR-FOLD:${label}-->\n${content}\n<!--/RHR-FOLD-->\n`;
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

export function parseStoryResponse(
  rawText: string,
  regexes: RegexConfig[],
  options?: { summaryTag?: string; foldTags?: string; macroEngine?: MacroEngine; activeTags?: string[] },
): ParsedStoryResponse {
  const trimmed = rawText.trim();
  // Strip fold-tag blocks (thinking/think) BEFORE extracting summary,
  // so that <summary> mentioned inside thinking content isn't matched first.
  // 注意跳过摘要标签本身——summary 也可以配进折叠标签（默认已包含），
  // 若在此被剥掉，摘要就提取不到了（recent_story/记忆会断）。
  const effectiveSummaryTag = (options?.summaryTag?.trim() || "summary").toLowerCase();
  let textForSummary = trimmed;
  if (options?.foldTags) {
    for (const tag of options.foldTags.split(",").map(t => t.trim()).filter(Boolean)) {
      if (tag.toLowerCase() === effectiveSummaryTag) continue;
      const escaped = escapeTagName(tag);
      textForSummary = textForSummary.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "");
    }
  }
  const summaryText = extractXmlField(textForSummary, options?.summaryTag);

  // Temporarily replace fold-tag blocks with placeholders before output regex,
  // so that <content>/<summary> mentioned inside thinking aren't matched by regex rules
  let textForRegex = trimmed;
  const foldPlaceholders: { placeholder: string; original: string }[] = [];
  if (options?.foldTags) {
    for (const tag of options.foldTags.split(",").map(t => t.trim()).filter(Boolean)) {
      const escaped = escapeTagName(tag);
      const rx = new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi");
      textForRegex = textForRegex.replace(rx, (match) => {
        const placeholder = `\x00FOLD_${foldPlaceholders.length}\x00`;
        foldPlaceholders.push({ placeholder, original: match });
        return placeholder;
      });
    }
  }
  const regexRendered = applyAllOutputRegex(textForRegex, regexes, {
    macroEngine: options?.macroEngine,
    activeTags: options?.activeTags,
  });
  // Restore fold blocks and apply reasoning regex inside them
  let reasoningProcessed = regexRendered;
  for (const { placeholder, original } of foldPlaceholders) {
    let restored = original;
    // Apply placement=6 (reasoning) regex inside the fold block
    if (regexes.length > 0) {
      // Extract tag name and content from the original fold block
      const tagMatch = original.match(/^<(\w+)>([\s\S]*)<\/\1>$/i);
      if (tagMatch) {
        const [, tagName, content] = tagMatch;
        const regexed = applyAllReasoningRegex(content.trim(), regexes, {
          macroEngine: options?.macroEngine,
          activeTags: options?.activeTags,
        });
        restored = `<${tagName}>${regexed}</${tagName}>`;
      }
    }
    reasoningProcessed = reasoningProcessed.replace(placeholder, restored);
  }

  const folded = applyFoldTags(reasoningProcessed, options?.foldTags);
  const renderedText = folded
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return {
    rawText: trimmed,
    renderedText,
    summaryText,
  };
}
