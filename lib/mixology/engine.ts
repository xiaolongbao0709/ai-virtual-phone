// lib/mixology/engine.ts
// 独家特调 · 对局运行时：开局、出杯（生成回复）、重说、继续。
//
// 特调不走聊天预设/正则管线——一杯特调自带全部提示词，正文协议由 App 自有解析器处理。
// API 走全局默认接口配置（与角色绑定无关，特调对局是独立世界）。

import { ChatEngineError, sendLLMRequest, sendLLMStreamRequest } from "../chat-engine";
import type { LLMMessage } from "../llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "../settings-storage";
import type { ApiConfig } from "../settings-types";
import type { MixHookSection } from "./mechanism-protocol";
import { assembleMixPrompt, MIX_DEFAULT_USER_NAME, MIX_ENCORE_CLOSE, MIX_ENCORE_OPEN, MIX_TICKET_CLOSE, MIX_TICKET_OPEN, mixNamedOpen, type MixAssembledPrompt } from "./assembler";
import { applyMixFilterRules, extractMixBlocks, type MixExtractedBlock } from "./prose";
import {
    getMixMaterial,
    getMixSession,
    resolveMixRecipeMaterials,
    saveMixSession,
} from "./storage";
import {
    createMixId,
    mixSlotEntries,
    mixSlotFirstId,
    mixTurnEncoreBlocks,
    mixTurnTicketBlocks,
    type MixCharacterCard,
    type MixEncoreMaterial,
    type MixFilterRule,
    type MixMaterial,
    type MixMechanismMaterial,
    type MixState,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
    type MixTicketMaterial,
    type MixTurn,
    type MixTurnBlock,
} from "./types";
import {
    advanceMixState,
    buildMixConditionContext,
    initialMixState,
    pickActiveMixMaterials,
    rollbackMixState,
} from "./state";
import { mergeHookState, type MixHook, type MixHookPayload } from "./mechanism-protocol";
import { disposeMixSandboxes, runMixHook } from "./mechanism-runtime";
import { disposeMixTrusted, runMixTrustedHook } from "./trusted-runtime";

export const MIX_PROMPT_APP_ID = "mixology";
const MIX_PROMPT_TAGS = ["mixology"];

/** 对局用的 API 配置：全局默认接口 */
export function resolveMixApiConfig(): ApiConfig | null {
    const binding = loadBindingConfig();
    const configs = loadApiConfigs();
    const id = binding.globalDefaults.apiConfigId;
    if (id) {
        const found = configs.find((c) => c.id === id);
        if (found) return found;
    }
    return configs[0] ?? null;
}

/** 从方案快照装配提示词（材料从酒柜按 id 现取；角色卡被删则报错） */
function assembleFromSession(session: MixSession, sections?: MixHookSection[]): {
    prompt: MixAssembledPrompt;
    /** 本轮生效的小票/尾调（条件筛过、按槽位顺序）——每件各自成块 */
    tickets: MixTicketMaterial[];
    encores: MixEncoreMaterial[];
    active: Partial<Record<MixMaterialKind, MixMaterial[]>>;
} {
    const { entries } = resolveMixRecipeMaterials(session.recipe);
    const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
    const character = active.character?.[0];
    if (!character || character.kind !== "character") {
        throw new ChatEngineError("这杯特调的角色卡已不在酒柜里，无法继续对局。");
    }
    const prompt = assembleMixPrompt({
        character: character as MixCharacterCard,
        materials: active,
        userName: session.userName,
        openingIndex: session.openingIndex,
        state: session.state,
        sections,
    });
    const tickets = (active.ticket ?? []).filter((m): m is MixTicketMaterial => m.kind === "ticket");
    const encores = (active.encore ?? []).filter((m): m is MixEncoreMaterial => m.kind === "encore");
    return { prompt, tickets, encores, active };
}

/**
 * 一块壳内原文还原成带标记的整块。named = 这一轮不止一块，开标签要带名字
 * （名字按块的供稿材料 id 现取；材料被删就退回不具名的壳）。
 */
function blockText(open: string, close: string, block: MixTurnBlock, named: boolean): string {
    const name = named && block.id ? getMixMaterial(block.id)?.name?.trim() : undefined;
    return `${name ? mixNamedOpen(open, name) : open}\n${block.raw}\n${close}`;
}

/**
 * 一条消息的"原始输出"。存了真原文（rawText，新数据）就直接给——机括标记行、
 * 被滤网洗掉的字只存在于这一份里，拼装还原不出来。
 * 老数据没有 rawText，退回把剥掉的状态栏/小剧场块拼回去的近似还原。
 */
export function mixTurnRawText(turn: MixTurn): string {
    if (turn.role !== "assistant") return turn.text;
    if (turn.rawText !== undefined) return turn.rawText;
    // 顺序与输出要求一致：状态栏在正文前、小剧场在正文后——历史回放就是模型的"输出习惯"示范
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    return [
        ...tickets.map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

/** 历史回传裁决：这一块的壳内原文要不要回传给模型（按块的供稿材料各自定） */
type MixFeedResolver = (kind: "ticket" | "encore", materialId: string | undefined) => "latest" | "all" | "none";

/**
 * 历史回放：默认只有最近一条 assistant 轮补回状态栏/小剧场块。
 * 模型需要的只有两样——最新状态的接续（契约的变化规则只依赖上一轮的值）
 * 和一份格式示范（防掉格式），最后一块两者都够；更旧的块随轮数线性膨胀，
 * 是纯 token 负担（按信息量基准每轮各两三百字，长局能省上万字符）。
 * 材料自己可改档（按块裁决，多块互不牵连）：all = 它的往期块逐轮回传；
 * none = 连最近一轮都不回传，一个字不占。存储不动：块原文原样留着，
 * 界面回放与编辑不受影响。
 */
function turnToHistoryContent(turn: MixTurn, isLast: boolean, feedOf?: MixFeedResolver): string {
    if (turn.role !== "assistant") return turn.text;
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    const keep = (kind: "ticket" | "encore") => (b: MixTurnBlock) => {
        const feed = feedOf?.(kind, b.id) ?? "latest";
        return feed === "all" || (isLast && feed !== "none");
    };
    return [
        ...tickets.filter(keep("ticket")).map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.filter(keep("encore")).map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

/**
 * 回传轮数上限：只保留最近 limit 轮（一轮 = 一条 assistant 回复，连同它前面的
 * 玩家发言）。默认不裁——玩家在对局设置里调了才生效；只裁发给模型的消息，
 * 存储与界面回放永远完整。
 */
export function limitMixTurns(turns: MixTurn[], limit: number | undefined): MixTurn[] {
    if (!limit || limit <= 0) return turns;
    let count = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role !== "assistant") continue;
        count += 1;
        if (count > limit) return turns.slice(i + 1);
    }
    return turns;
}

function buildMixMessages(
    session: MixSession,
    assembled: MixAssembledPrompt,
    extraUserNudge?: string,
    feedOf?: MixFeedResolver,
): LLMMessage[] {
    const messages: LLMMessage[] = [
        { role: "system", content: assembled.system, _debugMeta: { marker: "mixology_system" } },
    ];
    const turns = limitMixTurns(session.turns, session.historyLimit);
    let lastAssistantIdx = -1;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    for (const [i, turn] of turns.entries()) {
        messages.push({
            role: turn.role,
            content: turnToHistoryContent(turn, i === lastAssistantIdx, feedOf),
            _debugMeta: { marker: "mixology_history", _fromHistory: true },
        });
    }
    if (assembled.postHistory) {
        messages.push({
            role: "system",
            content: assembled.postHistory,
            _debugMeta: { marker: "mixology_strength" },
        });
    }
    if (extraUserNudge) {
        messages.push({
            role: "user",
            content: extraUserNudge,
            _debugMeta: { marker: "mixology_nudge" },
        });
    }
    return messages;
}

/** 开局：按方案快照建对局，开场白作为首条 assistant 消息 */
export function startMixSession(
    recipe: MixRecipe,
    options?: { openingIndex?: number; userName?: string },
): MixSession {
    const characterId = mixSlotFirstId(recipe.slots, "character");
    const card = characterId ? getMixMaterial(characterId) : null;
    if (!card || card.kind !== "character") {
        throw new ChatEngineError("特调里没有角色卡，装不满这一杯。");
    }
    // 用户的名字：显式传入 > 面具材料里填的（装配器同规则，这里快照进对局供界面用）
    const personaId = mixSlotFirstId(recipe.slots, "persona");
    const personaMat = personaId ? getMixMaterial(personaId) : null;
    const personaUserName = personaMat?.kind === "persona" ? personaMat.userName?.trim() : undefined;
    const openingIndex = options?.openingIndex ?? 0;
    // 记住的值的开局初值：全部小票里声明过初始值的项（同名先声明的优先）
    const ticketMats = mixSlotEntries(recipe.slots, "ticket")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixTicketMaterial => m?.kind === "ticket");
    const session: MixSession = {
        id: createMixId("mixsess"),
        recipe: { ...recipe, slots: { ...recipe.slots } },
        charName: card.charName.trim() || card.name,
        userName: options?.userName?.trim() || personaUserName || undefined,
        openingIndex,
        turns: [],
        state: initialMixState(ticketMats),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const assembled = assembleFromSession(session).prompt;
    if (assembled.opening) {
        session.turns.push({
            id: createMixId("mixturn"),
            role: "assistant",
            text: assembled.opening,
            // 开局这一刻机括存储是空的，照实拍一份：一路回溯到开局就该退回这个空
            //（开局钩子随后跑完会覆盖成它的结果，见 runMixSessionStart）
            mechanismStore: {},
            createdAt: Date.now(),
        });
    }
    saveMixSession(session);
    return session;
}

/**
 * 开局钩子：建局之后单独跑一次，让机括初始化自己的存储与记住的值。
 * 刻意不塞进 startMixSession——那是同步函数，界面靠它立刻拿到对局跳转；
 * 钩子是异步的，让它在后台补一笔，跑完再落库。跑失败也不影响开局。
 */
export async function runMixSessionStart(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (!session) return;
    const result = await runMechanismHooks(session, "sessionStart", {});
    const latest = getMixSession(sessionId);
    if (!latest) return;
    const nextState = mergeHookState(latest.state ?? {}, result.state);
    const changed = JSON.stringify(nextState) !== JSON.stringify(latest.state ?? {})
        || JSON.stringify(result.store) !== JSON.stringify(latest.mechanismStore ?? {});
    if (!changed) return;
    // 开场白那一轮也盖一份快照：一路回溯到开局时，取到的就是开局钩子跑完的样子
    const turns = latest.turns.map((t, i) => (
        i === 0 && t.role === "assistant" ? { ...t, mechanismStore: result.store } : t
    ));
    saveMixSession({ ...latest, turns, state: nextState, mechanismStore: result.store });
}

/**
 * 收摊钩子：退出对局时跑一次，顺手把这一局的沙盒全收掉。
 * 收摊的返回值只认存储与记住的值——这时候改正文已经没有意义了。
 */
export async function runMixSessionEnd(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (session) {
        try {
            const result = await runMechanismHooks(session, "sessionEnd", {});
            const latest = getMixSession(sessionId);
            if (latest) {
                saveMixSession({
                    ...latest,
                    state: mergeHookState(latest.state ?? {}, result.state),
                    mechanismStore: result.store,
                });
            }
        } catch {
            // 收摊失败无所谓，沙盒该收还是要收
        }
    }
    disposeMixSandboxes(sessionId);
    disposeMixTrusted(sessionId);
}

export type MixReplyResult = {
    session: MixSession;
    turn: MixTurn;
};

/**
 * 跑一轮机括钩子。机括这一格是累加型——条件命中的几件按顺序依次跑，
 * 前一件改过的文本会交给后一件继续加工（跟风味叠加是同一个心智）。
 * 单件出错、超时、返回垃圾都只是这一件不生效，不影响别的机括，也不影响这一轮生成。
 */
async function runMechanismHooks(
    session: MixSession,
    hook: MixHook,
    input: { text?: string; ticketRaws?: string[]; encoreRaws?: string[]; edited?: boolean },
    roster?: MixMechanismMaterial[],
): Promise<{ text?: string; notes: string[]; sections: MixHookSection[]; state: MixState; store: Record<string, Record<string, string>>; roster: MixMechanismMaterial[]; wrote: string[] }> {
    // roster：这一轮的机括名单。生效条件一轮只判一次（落杯前那次），之后
    // 由调用方原封传回来——否则小票一更新记住的值，条件在同一轮里翻脸，
    // 落杯前注入的标记行就没人回收，原样漏进正文。
    let mechanisms = roster;
    if (!mechanisms) {
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        mechanisms = (active.mechanism ?? []).filter((m): m is MixMechanismMaterial => m.kind === "mechanism");
    }
    const store = { ...(session.mechanismStore ?? {}) };
    // wrote：这一趟真正重新记了账的机括。调用方据此判断"谁没记"，别让它原来的账被连累
    const out = { text: input.text, notes: [] as string[], sections: [] as MixHookSection[], state: {} as MixState, store, roster: mechanisms, wrote: [] as string[] };
    if (!mechanisms.length) return out;
    for (const material of mechanisms) {
        const script = material.script?.trim();
        if (!script) continue;
        const payload: MixHookPayload = {
            hook,
            turnCount: session.turns.length,
            // 状态给的是当前值叠上前面几件机括刚写的——同一轮里后一件看得见前一件
            state: { ...(session.state ?? {}), ...out.state },
            store: store[material.id] ?? {},
            charName: session.charName,
            userName: session.userName || MIX_DEFAULT_USER_NAME,
            text: out.text,
            // 单块字段留给老机括脚本（多块时给第一块），全量走 ticketRaws/encoreRaws
            ticketRaw: input.ticketRaws?.[0],
            encoreRaw: input.encoreRaws?.[0],
            ticketRaws: input.ticketRaws,
            encoreRaws: input.encoreRaws,
            edited: input.edited || undefined,
        };
        // 信任模式的机括不进沙盒：钩子在页面里登记过的函数上跑，数据契约一样
        const result = material.trusted
            ? await runMixTrustedHook(session.id, material.id, hook, payload)
            : await runMixHook(session.id, material.id, script, hook, payload);
        if (typeof result.text === "string") out.text = result.text;
        if (result.note) out.notes.push(result.note);
        if (result.sections?.length) out.sections.push(...result.sections);
        if (result.state) out.state = mergeHookState(out.state, result.state);
        if (result.store) { store[material.id] = result.store; out.wrote.push(material.id); }
    }
    return out;
}

/** 落杯前：给机括一次改写玩家发言、追加临时提示的机会。返回本轮机括名单，出杯后照单回收 */
async function runBeforeSendHooks(session: MixSession, text?: string): Promise<{ session: MixSession; text?: string; note?: string; sections: MixHookSection[]; roster: MixMechanismMaterial[] }> {
    const result = await runMechanismHooks(session, "beforeSend", { text });
    const next: MixSession = {
        ...session,
        state: mergeHookState(session.state ?? {}, result.state),
        mechanismStore: result.store,
    };
    return { session: next, text: result.text, note: result.notes.join("\n") || undefined, sections: result.sections, roster: result.roster };
}

/**
 * 剥出来的块对号入座：先按开标签里的名字精确对（多块输出的正道），
 * 没名字/对不上名的按顺序补进还空着的位置（单块老格式、模型忘写名字）。
 * 块保持原文顺序返回；实在多出来的块不丢，只是没有归属（渲染退回第一件的皮）。
 */
function matchMixBlocks(blocks: MixExtractedBlock[], mats: { id: string; name: string }[]): MixTurnBlock[] {
    const used = new Set<number>();
    const assigned: (string | undefined)[] = new Array(blocks.length).fill(undefined);
    blocks.forEach((block, i) => {
        const name = block.name?.trim();
        if (!name) return;
        const at = mats.findIndex((m, j) => !used.has(j) && m.name.trim() === name);
        if (at >= 0) { used.add(at); assigned[i] = mats[at].id; }
    });
    blocks.forEach((_, i) => {
        if (assigned[i]) return;
        const at = mats.findIndex((_, j) => !used.has(j));
        if (at >= 0) { used.add(at); assigned[i] = mats[at].id; }
    });
    return blocks.map((block, i) => (assigned[i] ? { id: assigned[i], raw: block.raw } : { raw: block.raw }));
}

/** 落库前按槽位顺序归位（模型偶尔乱序）；没归属的块保持相对顺序垫在后面 */
function orderMixBlocks(blocks: MixTurnBlock[], mats: { id: string }[]): MixTurnBlock[] {
    if (blocks.length < 2) return blocks;
    const ordered: MixTurnBlock[] = [];
    for (const mat of mats) {
        const found = blocks.find((b) => b.id === mat.id);
        if (found) ordered.push(found);
    }
    for (const block of blocks) {
        if (!ordered.includes(block)) ordered.push(block);
    }
    return ordered;
}

/**
 * 把一份"模型原文"过一遍剥离管线：剥块 → 对号入座 → 按槽位归位 → 滤网清洗正文。
 * 出杯与「编辑原始输出」共用同一条管线——编辑保存等于拿新原文当一次模型输出重跑，
 * 剥离与渲染（渲染是块原文 + 渲染皮现算的）自然全部重来。
 */
function stripMixReply(
    raw: string,
    ticketPool: { id: string; name: string }[],
    encorePool: { id: string; name: string }[],
    filterRules: MixFilterRule[] | undefined,
): { text: string; ticketBlocks: MixTurnBlock[]; encoreBlocks: MixTurnBlock[] } {
    const extracted = extractMixBlocks(raw);
    const ticketBlocks = orderMixBlocks(matchMixBlocks(extracted.tickets, ticketPool), ticketPool);
    const encoreBlocks = orderMixBlocks(matchMixBlocks(extracted.encores, encorePool), encorePool);
    const text = applyMixFilterRules(extracted.text, filterRules?.length ? filterRules : undefined, "context");
    return { text, ticketBlocks, encoreBlocks };
}

/**
 * 用这一轮的块推进记住的值：每张小票只认自己那块的原文。
 * 单张小票时没归属的块也算它的（老格式输出没有名字）。
 */
function advanceMixStateWithBlocks(
    prev: MixState | undefined,
    tickets: MixTicketMaterial[],
    blocks: MixTurnBlock[],
): MixState {
    let state: MixState = { ...(prev ?? {}) };
    for (const ticket of tickets) {
        // 只有一张小票时不挑归属：块是谁供的稿都拿来抽值（老格式、退役皮的块照样认）
        const block = blocks.find((b) => b.id === ticket.id)
            ?? (tickets.length === 1 ? blocks[0] : undefined);
        state = advanceMixState(state, ticket, block?.raw);
    }
    return state;
}

/**
 * 历史回传裁决器：按块的供稿材料查它的 historyFeed 设置。
 * 材料从方案槽位全量收（不只本轮生效的）——往期块的供稿材料这一轮可能条件不满足，
 * 它的设置照样要认。没归属的块跟第一件生效材料走（老格式单块的老行为）。
 */
function buildFeedResolver(session: MixSession, tickets: MixTicketMaterial[], encores: MixEncoreMaterial[]): MixFeedResolver {
    const byId = new Map<string, "latest" | "all" | "none">();
    for (const kind of ["ticket", "encore"] as const) {
        for (const entry of mixSlotEntries(session.recipe.slots, kind)) {
            const mat = getMixMaterial(entry.materialId);
            if (mat?.kind === kind && mat.historyFeed && mat.historyFeed !== "latest") byId.set(mat.id, mat.historyFeed);
        }
    }
    const fallback: Record<"ticket" | "encore", "latest" | "all" | "none"> = {
        ticket: tickets[0]?.historyFeed ?? "latest",
        encore: encores.find((e) => e.contract?.trim())?.historyFeed ?? "latest",
    };
    return (kind, materialId) => (materialId ? byId.get(materialId) ?? "latest" : fallback[kind]);
}

/**
 * 一次生成。给了 onDelta 就走流式：模型吐一段就回调一段，界面能边写边看。
 * 流式只影响"过程怎么看"，落库、拆块、滤网、机括都还是拿到完整正文之后才做——
 * 半个状态栏块、写了一半的标记行都不该被当成结果。
 */
async function runMixGeneration(
    session: MixSession,
    nudge: string | undefined,
    signal?: AbortSignal,
    skipBeforeSend = false,
    onDelta?: (text: string) => void,
    roster?: MixMechanismMaterial[],
    sections?: MixHookSection[],
): Promise<MixReplyResult> {
    const apiConfig = resolveMixApiConfig();
    if (!apiConfig) {
        throw new ChatEngineError("还没有配置 API 接口，请先到设置里添加。");
    }
    // 落杯前：这里覆盖继续/重说/编辑后重生成三条路径（玩家发言那条在 generateMixReply 里，
    // 因为改写要发生在发言落库之前）；这些路径没有新发言，机括只能追加临时提示
    let working = session;
    let extraNote: string | undefined;
    // 机括挂进系统提示词的段：与 note 一样只活这一轮，不落库
    let hookSections = sections;
    // 本轮机括名单：落杯前判一次条件，出杯后照同一份名单跑回收——
    // 中途小票改了记住的值也不换人，注入过格式要求的机括必须自己收尾
    let turnRoster = roster;
    if (!skipBeforeSend) {
        const before = await runBeforeSendHooks(session);
        working = before.session;
        extraNote = before.note;
        hookSections = before.sections;
        turnRoster = before.roster;
        if (working !== session) saveMixSession(working);
    }
    const combinedNudge = [nudge, extraNote].filter(Boolean).join("\n\n") || undefined;
    const { prompt: assembled, tickets, encores, active } = assembleFromSession(working, hookSections);
    const messages = buildMixMessages(working, assembled, combinedNudge, buildFeedResolver(working, tickets, encores));
    const meta = { characterName: working.charName, userName: working.userName || "你" };
    // skipTimestampStrip：特调是"所见即模型所写"，不走聊天那套幻觉时间戳剥离——
    // 那个剥离器在流式时会扣住尾部 64 字等括号闭合，机括的末尾标记行会整行压在里面不出来
    const llmOptions = { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, skipTimestampStrip: true, signal };
    let raw: string;
    if (onDelta) {
        let got = false;
        try {
            const streamed = await sendLLMStreamRequest(apiConfig, null, messages, [], meta, llmOptions, {
                onDelta: (chunk) => { got = true; onDelta(chunk); },
            });
            raw = streamed.content;
        } catch (error) {
            // 一个字都没来就报错：多半是这条接口不支持 SSE（或者中间有代理把它拆了），
            // 退回一次性请求重试一遍；已经吐过字再断的话就是真出错了，照常抛出去
            if (got || (error instanceof Error && signal?.aborted)) throw error;
            raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
        }
    } else {
        raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
    }
    // 块对号入座：有契约的小票/尾调才是块的候选归属（纯静态小品不收块）
    const contractTickets = tickets.filter((t) => t.contract.trim());
    const contractEncores = encores.filter((e) => e.contract?.trim());
    // 滤网「进上下文」模式：拆完块后清洗正文再入库，历史发回模型的就是洗过的。
    // 这一格是累加型，条件命中的几张滤网按顺序串联清洗。
    const filterRules = (active.filter ?? [])
        .flatMap((m) => (m.kind === "filter" ? m.rules : []));
    const stripped = stripMixReply(raw, contractTickets, contractEncores, filterRules);
    let ticketBlocks = stripped.ticketBlocks;
    const encoreBlocks = stripped.encoreBlocks;
    const text = stripped.text;
    if (!text && !ticketBlocks.length) {
        throw new ChatEngineError("模型没有给出内容，请再试一次。");
    }
    ticketBlocks = orderMixBlocks(ticketBlocks, contractTickets);
    // 记住的值：用这一轮各张小票自己的块更新，抽不到的保留上一轮；顺带把结果快照在这一轮上，
    // 回溯/重说/编辑时直接取剩下最后一轮的快照还原。
    const stateFromTicket = advanceMixStateWithBlocks(working.state, contractTickets, ticketBlocks);
    // 出杯后：机括能改正文、能写记住的值。放在小票抽值之后——机括是最后一道，
    // 它写的值压得过小票抽出来的
    const afterHook = await runMechanismHooks(
        { ...working, state: stateFromTicket },
        "afterReply",
        {
            text,
            ticketRaws: ticketBlocks.length ? ticketBlocks.map((b) => b.raw) : undefined,
            encoreRaws: encoreBlocks.length ? encoreBlocks.map((b) => b.raw) : undefined,
        },
        turnRoster,
    );
    const finalText = typeof afterHook.text === "string" ? afterHook.text : text;
    const nextState = mergeHookState(stateFromTicket, afterHook.state);
    const keptTickets = assembled.hasTicket ? ticketBlocks : [];
    const keptEncores = assembled.hasEncore ? encoreBlocks : [];
    const turn: MixTurn = {
        id: createMixId("mixturn"),
        role: "assistant",
        text: finalText,
        // 真原文存档：机括改写/摘标记行之前的那份，「编辑原始输出」展示的就是它
        rawText: raw,
        // 单块字段冗余存第一块：老读取路径与跨版本数据都还认得
        ticketRaw: keptTickets[0]?.raw,
        encoreRaw: keptEncores[0]?.raw,
        ticketRaws: keptTickets.length ? keptTickets : undefined,
        encoreRaws: keptEncores.length ? keptEncores : undefined,
        state: nextState,
        // 这一轮结束时的机括存储：回溯/重说/撤回回到这里，不必让机括自己复位
        mechanismStore: afterHook.store,
        createdAt: Date.now(),
    };
    const updated: MixSession = {
        ...working,
        turns: trimMixStoreSnapshots([...working.turns, turn]),
        state: nextState,
        mechanismStore: afterHook.store,
        // 记账前底稿：编辑这一轮原文后自动回滚重跑的基准
        mechanismStorePrev: working.mechanismStore ?? {},
        mechanismStorePrevTurn: turn.id,
    };
    saveMixSession(updated);
    return { session: updated, turn };
}

/** 玩家发言 → 生成回复 */
export async function generateMixReply(
    sessionId: string,
    userText: string,
    signal?: AbortSignal,
    onUserTurn?: () => void,
    onDelta?: (text: string) => void,
): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const trimmed = userText.trim();
    if (!trimmed) throw new ChatEngineError("先说点什么吧。");
    // 落杯前钩子放在发言落库之前跑：机括改写的是玩家这一句本身
    //（比如把「/掷骰」换成一段带随机数的指令），落库的就是改写后的版本
    const before = await runBeforeSendHooks(current, trimmed);
    const spoken = (before.text ?? trimmed).trim() || trimmed;
    const userTurn: MixTurn = {
        id: createMixId("mixturn"),
        role: "user",
        text: spoken,
        createdAt: Date.now(),
    };
    const withUser: MixSession = { ...before.session, turns: [...before.session.turns, userTurn] };
    saveMixSession(withUser);
    // 落杯前钩子是 await 的，这句落库比调用方那次「同步回读」晚一拍，
    // 所以得主动喊一声：用户气泡要在模型回来之前就上屏
    onUserTurn?.();
    // 这条路径的落杯前已经跑过了，别在 runMixGeneration 里重复触发；
    // 名单原封带过去，出杯后照单回收
    return runMixGeneration(withUser, before.note, signal, true, onDelta, before.roster, before.sections);
}

/** 本局全部小票材料（记住的值的声明来源），按槽位顺序 */
function sessionTickets(session: MixSession): MixTicketMaterial[] {
    return mixSlotEntries(session.recipe.slots, "ticket")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixTicketMaterial => m?.kind === "ticket");
}

/** 本局全部尾调材料，按槽位顺序 */
function sessionEncores(session: MixSession): MixEncoreMaterial[] {
    return mixSlotEntries(session.recipe.slots, "encore")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixEncoreMaterial => m?.kind === "encore");
}

/**
 * 机括存储逐轮快照的保留轮数。
 * 存储桶单件上限 100KB，逐轮全留会把对局存档撑爆；只留最近这么多轮，
 * 成本与对局长度无关（30 × 实际桶大小，通常几十 KB 封顶）。
 */
export const MIX_STORE_SNAPSHOT_TURNS = 30;

/** 落库前修剪：只保留最近 N 份机括存储快照，更早的删掉 */
function trimMixStoreSnapshots(turns: MixTurn[]): MixTurn[] {
    let kept = 0;
    let cutAt = -1;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (!turns[i].mechanismStore) continue;
        kept += 1;
        if (kept > MIX_STORE_SNAPSHOT_TURNS) { cutAt = i; break; }
    }
    if (cutAt < 0) return turns;
    return turns.map((t, i) => (i <= cutAt && t.mechanismStore ? { ...t, mechanismStore: undefined } : t));
}

/**
 * 取这一串轮次末尾的机括存储快照。
 * 修剪永远从最旧的删起，所以"有快照的轮次"是连续的一段后缀——往回找不到快照，
 * 就是真的没留（老对局，或回溯得比保留窗口还早），返回 null 让调用方维持现状。
 */
function lastMixStoreSnapshot(turns: MixTurn[]): Record<string, Record<string, string>> | null {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const snapshot = turns[i].mechanismStore;
        if (snapshot) return { ...snapshot };
    }
    return null;
}

/**
 * 现存最早的一份机括存储快照。
 * 回溯到保留窗口之外时用它——那一轮当时的样子已经没了，但退到现存最早的那份
 * （约 MIX_STORE_SNAPSHOT_TURNS 轮前）总好过让机括停在被丢掉的未来上。
 */
function firstMixStoreSnapshot(turns: MixTurn[]): Record<string, Record<string, string>> | null {
    for (let i = 0; i < turns.length; i += 1) {
        const snapshot = turns[i].mechanismStore;
        if (snapshot) return { ...snapshot };
    }
    return null;
}

/**
 * 截断历史之后把记住的值与机括存储一起退回去：各取剩下最后一轮的快照。
 * 不做这一步的话，回溯三轮重打，好感度还停在被丢掉的那个未来上，
 * 机括面板里也还留着那三轮记下的东西。
 */
function withRolledBackState(session: MixSession, turns: MixTurn[]): MixSession {
    const initial = initialMixState(sessionTickets(session));
    // 记住的值全删光退回开局初值。机括存储：目标轮次之内有快照就精确退回；
    // 目标比保留窗口还早，就退到现存最早的那份（能退多远退多远）。
    // 一份快照都没有（更新前的老对局）才维持现状——没记过的东西造不出来，
    // 而清空会把玩家在面板里手写的内容一起抹掉。
    const store = lastMixStoreSnapshot(turns) ?? firstMixStoreSnapshot(session.turns);
    return {
        ...session,
        turns,
        state: rollbackMixState(turns, initial),
        mechanismStore: store ?? session.mechanismStore,
    };
}

/** 重说：丢弃最后一条 assistant 回复重新生成（开场白除外） */
export async function rerollMixReply(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const last = current.turns[current.turns.length - 1];
    if (!last || last.role !== "assistant" || current.turns.length <= 1) {
        throw new ChatEngineError("现在没有可以重说的回复。");
    }
    const trimmedSession = withRolledBackState(current, current.turns.slice(0, -1));
    saveMixSession(trimmedSession);
    const beforeLast = trimmedSession.turns[trimmedSession.turns.length - 1];
    // 上一条也是 assistant（继续产生的），补一个不落库的推进指令避免连续 assistant 消息
    const nudge = beforeLast?.role === "assistant"
        ? "（请接着上文继续推进剧情，换一个写法，不要重复。）"
        : undefined;
    return runMixGeneration(trimmedSession, nudge, signal, false, onDelta);
}

/** 继续：不发言，让角色接着写（推进指令不落库） */
export async function continueMix(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    return runMixGeneration(current, "（请接着上文继续推进剧情，直接续写，不要重复已写过的内容。）", signal, false, onDelta);
}

/**
 * 还没开口的对局：进来时用当前角色卡重取开场白。
 *
 * 开场白是建局那一刻写进 turns[0] 的一条消息，不是对材料的引用——所以作者改完卡
 * 回到对局，看到的还是旧的那句。这里只在「这一局玩家一个字都还没说」时重取：
 * 已经聊过的对局绝不动，那是真实历史，改了界面就和发给模型的上下文对不上。
 *
 * 返回是否真的换了，调用方据此决定要不要提示一句。
 */
export function refreshMixOpening(sessionId: string): { session: MixSession; changed: boolean } | null {
    const current = getMixSession(sessionId);
    if (!current) return null;
    const onlyOpening = current.turns.length === 1 && current.turns[0].role === "assistant";
    if (!onlyOpening) return { session: current, changed: false };
    let fresh: string;
    try {
        fresh = assembleFromSession(current).prompt.opening;
    } catch {
        // 卡被删了之类：留着原来那句，别把开场白弄没
        return { session: current, changed: false };
    }
    if (!fresh.trim() || fresh === current.turns[0].text) return { session: current, changed: false };
    const updated: MixSession = {
        ...current,
        turns: [{ ...current.turns[0], text: fresh }],
        updatedAt: Date.now(),
    };
    saveMixSession(updated);
    return { session: updated, changed: true };
}

/** 回溯到某条消息：保留它，删除其后的全部内容 */
export function truncateMixAfterTurn(sessionId: string, turnId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("消息不存在。");
    const updated = withRolledBackState(current, current.turns.slice(0, idx + 1));
    saveMixSession(updated);
    return updated;
}

/**
 * 编辑某条消息并删除其后的全部内容。
 * assistant 轮编辑的是"原始输出"（含 [状态栏]/[小剧场] 块）——保存时重新剥块解析，
 * 模型输出掉了格式也能手动修好重渲染；玩家发言仍是纯文本。
 * 编辑的是玩家发言时，调用方应随后用 regenerateMixTail 重新生成回复。
 */
/**
 * 对本局历史重跑「进上下文」滤网：把每一轮 AI 正文按当前配方里生效的规则再洗一遍。
 * 进上下文的滤网只在回复入库那一刻洗，中途新加或改了规则，旧轮次不会回头洗——
 * 这里补这一手。只动 text（存的和发回模型的都是它），不碰 rawText：原始输出留着，
 * 之后再编辑看到的仍是模型的原话。规则的生效条件按"那一轮之前的历史"重建现场判。
 * 返回洗动了几轮，好让界面说清楚发生了什么。
 */
export function rerunMixFilters(sessionId: string): { changed: number; total: number; rules: number } {
    const session = getMixSession(sessionId);
    if (!session) throw new ChatEngineError("对局不存在。");
    const entries = resolveMixRecipeMaterials(session.recipe).entries;
    let changed = 0;
    let total = 0;
    let rules = 0;
    const turns = session.turns.map((turn, idx) => {
        if (turn.role !== "assistant" || !turn.text) return turn;
        total += 1;
        const before = session.turns.slice(0, idx);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(withRolledBackState(session, before)));
        const filterRules = (active.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        rules = Math.max(rules, filterRules.filter((r) => r.mode === "context" && r.find).length);
        const next = applyMixFilterRules(turn.text, filterRules.length ? filterRules : undefined, "context");
        if (next === turn.text) return turn;
        changed += 1;
        return { ...turn, text: next };
    });
    if (changed > 0) saveMixSession({ ...session, turns });
    return { changed, total, rules };
}

export function editMixTurn(sessionId: string, turnId: string, newText: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("消息不存在。");
    const trimmed = newText.trim();
    if (!trimmed) throw new ChatEngineError("消息不能为空。");
    const kept = current.turns.slice(0, idx);
    let edited: MixTurn;
    if (current.turns[idx].role === "assistant") {
        // 块归属候选：这一轮原本的供稿材料在前（换过装的旧轮编辑后皮不跑偏），
        // 再补当前槽位里的材料（编辑时条件现场已不可考，名字对得上就认）
        const tickets = sessionTickets(current).filter((t) => t.contract.trim());
        const encores = sessionEncores(current).filter((e) => e.contract?.trim());
        const withPrior = (prior: { id?: string }[], mats: { id: string; name: string }[]) => {
            const pool: { id: string; name: string }[] = [];
            for (const block of prior) {
                if (!block.id || pool.some((p) => p.id === block.id)) continue;
                pool.push({ id: block.id, name: getMixMaterial(block.id)?.name ?? "" });
            }
            for (const mat of mats) {
                if (!pool.some((p) => p.id === mat.id)) pool.push(mat);
            }
            return pool;
        };
        // 编辑保存 = 拿新原文当一次模型输出重跑剥离管线（滤网也过，与出杯同一口径）。
        // 滤网条件按"这一轮之前的历史 + 回滚后的记住的值"重建的现场判——
        // 与真实出杯时判条件看到的现场同构（出杯时回复也还不存在）。
        const rolled = withRolledBackState(current, kept);
        const activeNow = pickActiveMixMaterials(
            resolveMixRecipeMaterials(current.recipe).entries,
            buildMixConditionContext(rolled),
        );
        const filterRules = (activeNow.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        const stripped = stripMixReply(
            trimmed,
            withPrior(mixTurnTicketBlocks(current.turns[idx]), tickets),
            withPrior(mixTurnEncoreBlocks(current.turns[idx]), encores),
            filterRules,
        );
        edited = {
            ...current.turns[idx],
            text: stripped.text,
            // 编辑后的正文就是新的"原始输出"：下次再编辑看到的还是这一份，
            // 机括标记行可往返改（本局带钩子机括时，调用方随后会跑 runMixEditSync 收数摘行）
            rawText: trimmed,
            ticketRaw: stripped.ticketBlocks[0]?.raw,
            encoreRaw: stripped.encoreBlocks[0]?.raw,
            ticketRaws: stripped.ticketBlocks.length ? stripped.ticketBlocks : undefined,
            encoreRaws: stripped.encoreBlocks.length ? stripped.encoreBlocks : undefined,
            // 换装戳作废：编辑后的块自带归属，旧戳留着会把渲染指错皮
            ticketId: undefined,
            encoreId: undefined,
            // 状态栏被手工改过，这一轮的快照要按新原文重算，否则数字和界面对不上
            state: advanceMixStateWithBlocks(rolled.state, tickets, stripped.ticketBlocks),
        };
    } else {
        edited = { ...current.turns[idx], text: trimmed };
    }
    // 后面的轮次：每一轮的原文都在，就照原样留着——调用方随后跑 runMixEditSync
    // 把这一轮连同后面每一轮按原文重画一遍（"换掉这一笔，后面的笔重画"）。
    // 重画不了（后面有更新前的老轮次没存原文，或这一轮之前没留快照）才截掉：
    // 它们的记住的值与机括存储都是从这一轮累积算出来的，重算不了就只能作废。
    const later = canReplayMixFrom(current, idx) ? current.turns.slice(idx + 1) : [];
    const updated = withRolledBackState(current, [...kept, edited, ...later]);
    saveMixSession(updated);
    return updated;
}

/**
 * 面板里手改了某件机括的存储：写进对局，同时记在当前这一轮上。
 * 记这一笔是为了重画——编辑早先某一轮会把后面每一轮按原文重跑，走到这一轮时
 * 拿这份手改再盖一次，玩家亲手定的事实不会被重画冲掉。
 */
export function recordMixPanelStore(
    session: MixSession,
    materialId: string,
    bucket: Record<string, string>,
): MixSession {
    const store = { ...(session.mechanismStore ?? {}), [materialId]: bucket };
    let at = -1;
    for (let i = session.turns.length - 1; i >= 0; i -= 1) {
        if (session.turns[i].role === "assistant") { at = i; break; }
    }
    if (at < 0) return { ...session, mechanismStore: store };
    const turns = [...session.turns];
    turns[at] = {
        ...turns[at],
        mechanismStore: store,
        mechanismStoreEdits: { ...(turns[at].mechanismStoreEdits ?? {}), [materialId]: bucket },
    };
    return { ...session, turns, mechanismStore: store };
}

/**
 * 编辑某一轮后，能不能把它和它之后的每一轮按原文重画一遍。
 * 要两个条件：这一轮之前留着快照（起跑点），后面每一轮都存着原文（笔怎么画的）。
 */
export function canReplayMixFrom(session: MixSession, idx: number): boolean {
    if (idx < 0 || idx >= session.turns.length) return false;
    if (session.turns[idx].role !== "assistant") return false;
    if (!lastMixStoreSnapshot(session.turns.slice(0, idx))) return false;
    // 这一轮自己的原文由 editMixTurn 现写，不在这里要求
    return session.turns.every((t, i) => i <= idx || t.role !== "assistant" || typeof t.rawText === "string");
}

/**
 * 编辑某一轮之后的机括补跑。
 *
 * 每一轮的原文都存着，所以能把这一轮连同它之后的每一轮按顺序重跑一遍——
 * 相当于"把这一笔换掉，后面的笔照原样重画"，一条消息都不用删（→ "replayed"）。
 * 面板里手改过的桶记在它发生的那一轮上（mechanismStoreEdits），重画走到那一轮时
 * 照样再盖一次：手改始终压过重画的结果，不会被冲掉。
 *
 * 重画不了（这一轮之前没留快照，或后面有更新前的老轮次没存原文）就退回老办法，
 * 只重跑这一轮（→ "appended"；调用方那边相应地把后文截掉）。
 *
 * 补跑名单是本局全部带脚本的机括，不判生效条件：生成时名单是落杯前判一次、出杯后
 * 照单回收，那份名单事后没留下，现场也早变了（关键词看的是不同的最近几轮，
 * 「随机 N%」重判必然翻脸）。重判等于换一份名单——漏掉的那件，它当初注入正文的
 * 标记行就再也没人回收。标记行只有写它的机括认得，所以宁可全员过一遍。
 */
export async function runMixEditSync(sessionId: string, turnId: string): Promise<"replayed" | "appended" | false> {
    const session = getMixSession(sessionId);
    if (!session) return false;
    const idx = session.turns.findIndex((t) => t.id === turnId);
    if (idx < 0 || session.turns[idx].role !== "assistant") return false;
    const roster = mixSlotEntries(session.recipe.slots, "mechanism")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixMechanismMaterial => m?.kind === "mechanism" && Boolean(m.script?.trim()));

    const replay = canReplayMixFrom(session, idx);
    const allTickets = sessionTickets(session);
    const tickets = allTickets.filter((t) => t.contract.trim());
    const encores = sessionEncores(session).filter((e) => e.contract?.trim());
    // 块归属候选：那一轮原本的供稿材料在前，再补当前槽位里的（同 editMixTurn）
    const poolOf = (prior: { id?: string }[], mats: { id: string; name: string }[]) => {
        const pool: { id: string; name: string }[] = [];
        for (const block of prior) {
            if (!block.id || pool.some((p) => p.id === block.id)) continue;
            pool.push({ id: block.id, name: getMixMaterial(block.id)?.name ?? "" });
        }
        for (const mat of mats) {
            if (!pool.some((p) => p.id === mat.id)) pool.push(mat);
        }
        return pool;
    };
    const before = session.turns.slice(0, idx);
    const filterRules = (pickActiveMixMaterials(
        resolveMixRecipeMaterials(session.recipe).entries,
        buildMixConditionContext(withRolledBackState(session, before)),
    ).filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));

    // 起跑点：重画从这一轮之前那份快照起；快照没留就试记账前底稿；都没有就在当前存储上补记
    let store = (replay ? lastMixStoreSnapshot(before) : null)
        ?? (session.mechanismStorePrevTurn === turnId ? session.mechanismStorePrev ?? null : null)
        ?? { ...(session.mechanismStore ?? {}) };
    let state = rollbackMixState(before, initialMixState(allTickets));
    const turns = [...session.turns];
    const last = replay ? turns.length - 1 : idx;

    for (let i = idx; i <= last; i += 1) {
        const turn = turns[i];
        if (turn.role !== "assistant") continue;
        // 这一轮的正文已由 editMixTurn 按新原文剥好；后面几轮各自按自己的原文重剥
        const stripped = i === idx
            ? { text: turn.text, ticketBlocks: mixTurnTicketBlocks(turn), encoreBlocks: mixTurnEncoreBlocks(turn) }
            : stripMixReply(
                turn.rawText ?? turn.text,
                poolOf(mixTurnTicketBlocks(turn), tickets),
                poolOf(mixTurnEncoreBlocks(turn), encores),
                filterRules,
            );
        const ticketRaws = stripped.ticketBlocks.map((b) => b.raw);
        const encoreRaws = stripped.encoreBlocks.map((b) => b.raw);
        const result = await runMechanismHooks(
            { ...session, turns: turns.slice(0, i), state, mechanismStore: store },
            "afterReply",
            {
                text: stripped.text,
                ticketRaws: ticketRaws.length ? ticketRaws : undefined,
                encoreRaws: encoreRaws.length ? encoreRaws : undefined,
                edited: true,
            },
            roster,
        );
        // 这一趟没重新记账的机括保留它原来的账，不跟着起跑点一起退回去——钩子出错、
        // 超时、或者自己决定这一轮不记，都不该让面板上已有的内容凭空消失。
        const next = { ...result.store };
        for (const [id, bucket] of Object.entries(turn.mechanismStore ?? session.mechanismStore ?? {})) {
            if (!result.wrote.includes(id)) next[id] = bucket;
        }
        // 面板手改过的桶：走到它发生的那一轮就再盖一次，手改永远是权威
        Object.assign(next, turn.mechanismStoreEdits ?? {});
        state = mergeHookState(advanceMixStateWithBlocks(state, tickets, stripped.ticketBlocks), result.state);
        store = next;
        turns[i] = {
            ...turn,
            text: typeof result.text === "string" ? result.text : stripped.text,
            ticketRaw: stripped.ticketBlocks[0]?.raw,
            encoreRaw: stripped.encoreBlocks[0]?.raw,
            ticketRaws: stripped.ticketBlocks.length ? stripped.ticketBlocks : undefined,
            encoreRaws: stripped.encoreBlocks.length ? stripped.encoreBlocks : undefined,
            state,
            mechanismStore: store,
        };
    }

    // 钩子是异步的，落库前重读一遍：这期间玩家动过历史（回溯、又编辑一条）就整趟作废，
    // 别把算了一半的旧账盖上去
    const latest = getMixSession(sessionId);
    if (!latest || latest.turns.length !== turns.length) return false;
    if (latest.turns.some((t, i) => t.id !== turns[i].id)) return false;
    const tail = turns[turns.length - 1];
    saveMixSession({
        ...latest,
        turns: trimMixStoreSnapshots(turns),
        state: tail?.state ?? latest.state,
        mechanismStore: tail?.mechanismStore ?? latest.mechanismStore,
    });
    return replay ? "replayed" : "appended";
}

/** 对当前历史直接生成回复（编辑玩家发言后的重新生成） */
export async function regenerateMixTail(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    return runMixGeneration(current, undefined, signal, false, onDelta);
}

/** 撤回最后一轮：删掉最后一条玩家发言及其后的全部回复 */
export function undoMixLastRound(sessionId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    let lastUserIdx = -1;
    for (let i = current.turns.length - 1; i >= 0; i -= 1) {
        if (current.turns[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) throw new ChatEngineError("还没有可以撤回的发言。");
    const updated = withRolledBackState(current, current.turns.slice(0, lastUserIdx));
    saveMixSession(updated);
    return updated;
}
