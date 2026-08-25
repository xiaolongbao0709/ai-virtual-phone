// lib/mixology/types.ts
// 独家特调 · 领域类型：材料（七类）、特调方案、对局。
//
// 心智模型：角色卡也是一种材料；玩家把材料收进酒柜，在吧台给每个槽位
// 各挑一件调成「特调」，特调可命名保存/分享。对局 = 角色卡 + 特调的一次运行。
// 本文件只定义数据形状，装配见 assembler.ts，存取见 storage.ts。

/** 材料十类（槽位一一对应） */
export type MixMaterialKind =
    | "character" // 角色卡
    | "persona"   // 面具：用户人设（{{user}} 的名字与设定）
    | "base"      // 基底：扮演总纲
    | "flavor"    // 风味：文风
    | "glass"     // 杯型：输出格式
    | "strength"  // 苦精：尾部强化（离生成最近、权重最高）
    | "ticket"    // 小票：状态数据卡（输出契约 + 渲染代码）
    | "garnish"   // 外观：界面美化 CSS
    | "encore"    // 尾调：随卡互动 HTML 小品
    | "filter"    // 滤网：正则清洗正文（不进提示词）
    | "mechanism"; // 机括：沙盒里跑的钩子逻辑 + 常驻界面

export const MIX_KIND_LABELS: Record<MixMaterialKind, string> = {
    character: "角色卡",
    persona: "面具",
    base: "基底",
    flavor: "风味",
    glass: "杯型",
    strength: "苦精",
    ticket: "小票",
    garnish: "外观",
    encore: "尾调",
    filter: "滤网",
    mechanism: "机括",
};

/** 吧台槽位顺序（角色卡永远第一槽） */
export const MIX_SLOT_ORDER: MixMaterialKind[] = [
    "character", "persona", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore", "filter", "mechanism",
];

/** TAB 上大字下面那行小字：说明这一类到底干什么（不进提示词的种类标它的实际职责） */
export const MIX_KIND_SECTION_LABELS: Record<MixMaterialKind, string> = {
    character: "角色资料",
    persona: "用户资料",
    base: "扮演总纲",
    flavor: "文风",
    glass: "正文输出要求",
    strength: "最高优先级",
    ticket: "状态栏",
    garnish: "界面样式",
    encore: "小剧场",
    filter: "正则替换",
    mechanism: "可执行逻辑",
};

/** 必选槽：没配齐不能开局；其余槽可留空 */
export const MIX_REQUIRED_KINDS: MixMaterialKind[] = ["character"];

/**
 * 叠放语义：
 * concat = 这一格里条件满足的全部生效，按顺序依次拼接（多段文风叠加、主装饰 + 补丁装饰；
 *          小票/尾调是"多块并行"——每件各自成块，一轮可同时带多个状态栏与小剧场）；
 * first  = 只用第一件条件满足的（一局只有一张角色卡、一副面具）。
 */
export const MIX_SLOT_STACK: Record<MixMaterialKind, "concat" | "first"> = {
    character: "first",
    persona: "first",
    base: "concat",
    flavor: "concat",
    glass: "concat",
    strength: "concat",
    ticket: "concat",
    garnish: "concat",
    encore: "concat",
    filter: "concat",
    mechanism: "concat",
};

/** 不给设生效条件的格：这两格没了这一局就不成立 */
export const MIX_NO_CONDITION_KINDS: MixMaterialKind[] = ["character", "persona"];

/**
 * 会在下载方设备上「按轮执行、且能改写对话」的材料。
 * 小票与尾调也带 JS，但它们只在沙盒 iframe 里画自己那一块，动不了对话内容；
 * 机括不一样——它能改你发出去的话、改你看到的正文、以你的身份发言，
 * 所以上架与入柜两头都要单独说明白，不能混在普通材料里悄悄过。
 */
export const MIX_ACTIVE_CODE_KINDS: MixMaterialKind[] = ["mechanism"];

export function mixKindRunsActiveCode(kind: MixMaterialKind): boolean {
    return MIX_ACTIVE_CODE_KINDS.includes(kind);
}

export function mixKindAllowsCondition(kind: MixMaterialKind): boolean {
    return !MIX_NO_CONDITION_KINDS.includes(kind);
}

/**
 * 支持配图的种类：角色卡 + 三类"看效果"的视觉材料（小票/装饰/尾调），
 * 列表里走双列海报瀑布；其余纯文本材料不配图，走单列列表。
 */
export const MIX_VISUAL_KINDS: MixMaterialKind[] = ["character", "ticket", "garnish", "encore"];

export function mixKindHasCover(kind: MixMaterialKind): boolean {
    return MIX_VISUAL_KINDS.includes(kind);
}

/** 一件材料最多几个标签 / 每个标签最长几个字：与云端 normalizeTags 同口径 */
export const MIX_TAG_MAX = 8;
export const MIX_TAG_LEN = 24;

/**
 * 标签规整：去空白、去重、掐长度、掐个数。
 * 本地和云端必须同一套口径——否则本地看着有九个标签，发布上去只剩八个，
 * 作者会以为发布把标签吞了。
 */
export function normalizeMixTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") continue;
        const tag = item.trim().replace(/\s+/g, " ").slice(0, MIX_TAG_LEN);
        if (!tag || out.includes(tag)) continue;
        out.push(tag);
        if (out.length >= MIX_TAG_MAX) break;
    }
    return out;
}

/** 编辑器里一行文本拆成标签：逗号、顿号、竖线、井号、空格都算分隔 */
export function parseMixTags(text: string): string[] {
    return normalizeMixTags(text.split(/[,，、|｜#＃\s]+/));
}

/** 标签回填到编辑器那一行文本 */
export function formatMixTags(tags: string[] | undefined): string {
    return (tags ?? []).join("、");
}

/** 所有材料共有的元信息 */
export type MixMaterialMeta = {
    id: string;
    kind: MixMaterialKind;
    name: string;
    /** 一句话介绍（列表页钩子文案） */
    hook?: string;
    /** 创作者署名（本地自建可空） */
    author?: string;
    /** 创作者头像 dataURL：入柜时随线上条目带回；自己的材料展示本地创作者资料，不用这个字段 */
    authorAvatar?: string;
    tags?: string[];
    /** 封面图 dataURL 或远端地址（角色卡强烈建议有） */
    cover?: string;
    /** 已上架到酒材页时的线上 id：有它才谈得上"更新已发布版本" */
    publishedId?: string;
    /** 最近一次同步到云端成功时的 updatedAt 快照；本地 updatedAt 比它新 = 有未上架修改 */
    publishedAt?: number;
    /**
     * 来自酒材页/配方页的别人的作品。与应用市场、游戏大厅同规矩：
     * 能拿来开局，但站内不展示正文、不能编辑、不能导出、不能二次发布。
     */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/** 角色卡：AI 读的字段全部可选（空字段装配时整段消失），只有名字必填 */
export type MixCharacterCard = MixMaterialMeta & {
    kind: "character";
    /** 角色名（对局中的 {{char}}） */
    charName: string;
    /** 基础信息：年龄/身高/职业等，自由文本或键值行 */
    baseInfo?: string;
    personality?: string;
    appearance?: string;
    background?: string;
    /** 世界观：所处世界的公共设定 */
    worldview?: string;
    /** 对 user 的初始认知：开局时角色"知道"user 什么 */
    cognition?: string;
    /** 关系与身份推荐：user 可代入哪些身份、各身份下关系如何 */
    relations?: string;
    /** 当前剧情：开局时间点的情境 */
    plot?: string;
    /** 开场白（可多个，玩家开局挑一个；纯文本，进对局与提示词） */
    openings: string[];
    /** 开场画布：点进卡详情时铺在封面蒙版上的门面页（HTML，沙盒渲染，不进提示词） */
    canvas?: string;
    /** 示例对话：文风锚点（user/char 轮次） */
    examples?: { role: "user" | "char"; text: string }[];
    /** 附加设定：NPC、私设名词表等自由区 */
    extra?: string;
    /** @deprecated 已被开场画布取代，仅为兼容旧数据保留 */
    authorNote?: string;
};

/** 纯文本类材料：基底 / 风味 / 杯型 / 苦精 */
export type MixTextMaterial = MixMaterialMeta & {
    kind: "base" | "flavor" | "glass" | "strength";
    content: string;
};

/** 面具（用户人设）：{{user}} 是谁——名字 + 人设正文，装配成「用户资料」段 */
export type MixPersonaMaterial = MixMaterialMeta & {
    kind: "persona";
    /** 用户的名字，替换 {{user}}；留空用默认「你」 */
    userName?: string;
    content: string;
};

/**
 * 小票里被标成「记住」的一项：每轮从小票原文里按键名抽出来，跨轮留存。
 * 抽不到就保留上一轮的值——宁可停滞，不能跳变。
 */
export type MixTicketVar = {
    /** 变量名，同时就是小票原文里的键名 */
    name: string;
    /** 开局时的初始值 */
    initial?: string;
};

/** 小票：输出契约进提示词，渲染代码在沙盒 iframe 接管展示 */
export type MixTicketMaterial = MixMaterialMeta & {
    kind: "ticket";
    /** 告诉 AI 每轮在 [小票] 壳内输出什么 */
    contract: string;
    /** 完整 HTML（可含 JS），数据经 window.TICKET_RAW / {{RAW}} 注入 */
    renderHtml: string;
    /** 编辑器预览用示例数据 */
    previewRaw?: string;
    /** 这张小票里哪几项要记住（记住的值可被条件判断、可被 {{状态.X}} 取用） */
    vars?: MixTicketVar[];
    /**
     * 历史回传策略：往期轮次的壳内原文要不要回传给模型。
     * latest（默认）= 只回传最近一轮——状态接续与格式示范都够用，token 不随轮数涨；
     * all = 全部回传——契约需要引用往期内容时用，token 随轮数线性增长；
     * none = 完全不回传——纯展示、不需要接续也不怕掉格式时最省 token。
     */
    historyFeed?: "latest" | "all" | "none";
};

/** 外观：对局界面美化（官方语义类 + 界面定位符的 CSS） */
export type MixGarnishMaterial = MixMaterialMeta & {
    kind: "garnish";
    css: string;
};

/** 尾调（小剧场）：AI 按契约输出加演内容，渲染代码负责画出来；契约留空则为纯静态小品 */
export type MixEncoreMaterial = MixMaterialMeta & {
    kind: "encore";
    /** 告诉 AI 小剧场何时出现、写什么；留空则不进提示词，渲染代码作为静态小品直接展示 */
    contract?: string;
    /** 完整 HTML（可含 JS），AI 输出经 window.ENCORE_RAW / {{RAW}} 注入 */
    renderHtml?: string;
    /** @deprecated 旧字段（纯静态 HTML），读取时等价于 renderHtml */
    html?: string;
    /** 编辑器预览用示例数据 */
    previewRaw?: string;
    /** 历史回传策略（同小票）：latest（默认）只回传最近一轮，all 全部回传，none 完全不回传 */
    historyFeed?: "latest" | "all" | "none";
};

/** 尾调渲染代码：新旧字段统一出口 */
export function mixEncoreRenderHtml(material: MixEncoreMaterial): string {
    return material.renderHtml ?? material.html ?? "";
}

/** 滤网单条规则：正则查找 + 替换文本 + 作用模式 */
export type MixFilterRule = {
    /** 查找（JS 正则，自动带 g 标志） */
    find: string;
    /** 替换文本（支持 $1 等捕获组引用；空串即删除） */
    replace: string;
    /**
     * display = 仅显示：存的和发给模型的都是原文，只在渲染前替换，对全部历史即时生效；
     * context = 进上下文：回复拆完块后清洗一遍再入库，历史发回模型的是洗过的，只对新回复生效。
     */
    mode: "display" | "context";
};

/** 滤网：对 AI 正文做正则清洗（拆完状态栏/小剧场块之后才执行，不碰块数据，不进提示词） */
export type MixFilterMaterial = MixMaterialMeta & {
    kind: "filter";
    rules: MixFilterRule[];
};

/**
 * 机括的停靠位。这是第一版的摆放方式——四个写死的位置，创作者只能挑一个。
 * 现在留着只为了两件事：认得出老材料，以及给自由摆放提供几个顺手的起手式。
 * 新材料一律用下面的 MixPanelLayout。
 */
export type MixDock = "left" | "right" | "bottom" | "float";

export const MIX_DOCK_LABELS: Record<MixDock, string> = {
    left: "左侧栏",
    right: "右侧栏",
    bottom: "底部条",
    float: "悬浮球",
};

/**
 * 常驻界面的摆放。位置与尺寸都是「占对局画面的百分比」，不是像素——
 * 同一件机括在 iPhone SE 和 iPad 上要落在同一个相对位置，写死像素做不到这件事。
 *
 * 边界只剩两条，都是为了「别把对局锁死」，不是为了限制排版：
 * ① 面板至少有 MIX_PANEL_KEEP_IN 那么大一块留在画面里，拖不丢；
 * ② 层级压在应用自己的弹窗之下。
 * 除此之外画在哪、画多大、能不能拖、要不要应用画的外壳，全是创作者说了算。
 */
export type MixPanelLayout = {
    /** 左上角，占对局画面宽/高的百分比 */
    x: number;
    y: number;
    /** 宽高，同样是百分比 */
    w: number;
    h: number;
    /** 高度跟着内容走，h 退化成上限：写「小胶囊」这类随内容伸缩的面板用 */
    autoHeight?: boolean;
    /** 玩家能不能拖着走（拖过的位置记在这一局里，不改材料本身） */
    drag?: boolean;
    /** 玩家能不能拉大小 */
    resize?: boolean;
    /** 应用要不要画那条带名字和收起箭头的把手；none = 外壳全交给创作者 */
    chrome?: "bar" | "none";
    /** 应用要不要画底板（圆角暗底、描边、投影）。自己画背景的关掉它 */
    plate?: boolean;
    /**
     * 按多宽来画（像素）。填了之后界面里的一切按这个宽度排版，应用再整体缩放到面板实际大小——
     * 画一台 390 宽的手机、一张卡片时必须用它，否则同一份 CSS 在小面板里会挤成一团、
     * 在大面板里又稀稀拉拉，预览与实际也对不上。不填则界面直接按面板的实际像素排版。
     */
    designWidth?: number;
    /** 同屏几件互相压时的次序，0–9 */
    z?: number;
    /** 开局时收起（只有 chrome 为 bar 时才有收起这回事） */
    collapsed?: boolean;
    /** 挂点（见 MIX_PANEL_SLOTS）；不写 = float 自由悬浮，老材料全部落在这档 */
    slot?: MixPanelSlot;
    /** 按钮位（header/inputbar-*）的图标：一两个 emoji 或单字，宿主画在按钮上 */
    icon?: string;
};

/**
 * 机括挂点：面板长在对局画面的哪儿。
 * float（默认）= 自由悬浮层，位置尺寸全由摆放/mix API 说了算；
 * header / inputbar-left / inputbar-right = 宿主在标题栏或输入栏画一颗图标按钮，
 *   点击开合面板（按钮由宿主渲染，样式统一、位置精确，沙盒碰不到宿主排版）；
 * flow-top / flow-bottom = 面板作为一张内嵌卡直接进滚动流（画布之下 / 轮次流末尾），
 *   随内容滚动，autoHeight 常开，不可拖不可缩。
 */
export const MIX_PANEL_SLOTS = ["float", "header", "inputbar-left", "inputbar-right", "flow-top", "flow-bottom"] as const;
export type MixPanelSlot = (typeof MIX_PANEL_SLOTS)[number];

export const MIX_PANEL_SLOT_LABELS: Record<MixPanelSlot, string> = {
    float: "自由悬浮",
    header: "标题栏按钮",
    "inputbar-left": "输入栏左侧按钮",
    "inputbar-right": "输入栏右侧按钮",
    "flow-top": "正文顶部",
    "flow-bottom": "正文尾部",
};

/** 拖丢了捡不回来，所以无论怎么拖都至少留这么多在画面里（百分比） */
export const MIX_PANEL_KEEP_IN = 8;
/** 面板最小尺寸：再小就点不中了 */
export const MIX_PANEL_MIN_W = 8;
export const MIX_PANEL_MIN_H = 4;
/** 层级上限：再高会压到应用自己的弹窗上面去 */
export const MIX_PANEL_MAX_Z = 9;

/** 四个老停靠位对应的摆放：只用来把老材料换算过来，编辑器里不再提供选择 */
export const MIX_DOCK_PRESETS: Record<MixDock, MixPanelLayout> = {
    left: { x: 2, y: 12, w: 38, h: 52, drag: true, chrome: "bar", plate: true },
    right: { x: 60, y: 12, w: 38, h: 52, drag: true, chrome: "bar", plate: true },
    bottom: { x: 3, y: 58, w: 94, h: 34, drag: true, chrome: "bar", plate: true },
    float: { x: 55, y: 66, w: 45, h: 26, drag: true, chrome: "bar", plate: true, collapsed: true },
};

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
}

/**
 * 规整一份摆放。导入的 JSON、云端拿回来的记录、界面自己 postMessage 上来的请求
 * 都从这里过一遍——越界的夹回来，认不出的字段丢掉。
 */
export function normalizeMixPanelLayout(value: unknown): MixPanelLayout | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const w = clampNum(record.w, MIX_PANEL_MIN_W, 100, 40);
    const h = clampNum(record.h, MIX_PANEL_MIN_H, 100, 30);
    // 允许负数与超过 100：面板可以有一部分在画面外，只要留得下 KEEP_IN 那一块
    const x = clampNum(record.x, MIX_PANEL_KEEP_IN - w, 100 - MIX_PANEL_KEEP_IN, 4);
    const y = clampNum(record.y, MIX_PANEL_KEEP_IN - h, 100 - MIX_PANEL_KEEP_IN, 12);
    const layout: MixPanelLayout = { x, y, w, h };
    if (record.autoHeight === true) layout.autoHeight = true;
    if (record.drag !== false) layout.drag = true;
    if (record.resize === true) layout.resize = true;
    layout.chrome = record.chrome === "none" ? "none" : "bar";
    layout.plate = record.plate !== false;
    const design = clampNum(record.designWidth, 120, 1600, 0);
    if (design) layout.designWidth = Math.round(design);
    const z = clampNum(record.z, 0, MIX_PANEL_MAX_Z, 0);
    if (z) layout.z = z;
    if (record.collapsed === true) layout.collapsed = true;
    if (typeof record.slot === "string" && record.slot !== "float" && (MIX_PANEL_SLOTS as readonly string[]).includes(record.slot)) {
        layout.slot = record.slot as MixPanelSlot;
    }
    if (typeof record.icon === "string" && record.icon.trim()) layout.icon = record.icon.trim().slice(0, 4);
    return layout;
}

/** 一份摆放实际落在哪个挂点 */
export function mixPanelSlotOf(layout: MixPanelLayout | undefined): MixPanelSlot {
    return layout?.slot ?? "float";
}

/**
 * 写了界面代码但没写摆放时用的起始值。
 * 摆放是界面自己在代码里用 mix.move / mix.size / mix.chrome … 定的，
 * 这里只是「代码还没跑起来的那一帧」站的地方：应用一笔都不画，位置给个中性的框。
 */
export const MIX_PANEL_DEFAULT_LAYOUT: MixPanelLayout = {
    x: 6, y: 14, w: 88, h: 44, drag: true, chrome: "none", plate: false,
};

/**
 * 一件机括最终按哪份摆放画。
 * 自己写了就用自己的；只有老停靠位就换算过来；两样都没有但写了界面代码，
 * 就落在中性的起始值上，等界面代码自己挪走——有界面代码就有界面，不再另外声明一次。
 */
export function mixPanelLayoutOf(material: { layout?: MixPanelLayout; dock?: MixDock; panelHtml?: string }): MixPanelLayout | undefined {
    const own = normalizeMixPanelLayout(material.layout);
    if (own) return own;
    if (material.dock) return { ...MIX_DOCK_PRESETS[material.dock] };
    return material.panelHtml?.trim() ? { ...MIX_PANEL_DEFAULT_LAYOUT } : undefined;
}

/** 详情页上用一行字说清这份摆放 */
export function mixPanelLayoutSummary(layout: MixPanelLayout): string {
    const slot = mixPanelSlotOf(layout);
    if (slot !== "float") {
        return `${MIX_PANEL_SLOT_LABELS[slot]}${layout.icon ? ` · 图标 ${layout.icon}` : ""}`;
    }
    const parts = [
        `左 ${layout.x}% · 上 ${layout.y}%`,
        `${layout.w}% × ${layout.autoHeight ? "随内容" : `${layout.h}%`}`,
    ];
    if (layout.designWidth) parts.push(`按 ${layout.designWidth}px 宽排版`);
    const flags: string[] = [];
    if (layout.drag !== false) flags.push("可拖动");
    if (layout.resize) flags.push("可缩放");
    if ((layout.chrome ?? "bar") === "none") flags.push("无外壳");
    if (layout.plate === false) flags.push("无底板");
    if (flags.length) parts.push(flags.join("、"));
    return parts.join(" · ");
}

/**
 * 自由摆放换算回最接近的老停靠位。老材料改存时一起写上去，
 * 老版本客户端拿到这件机括时还能把它挂在个大致对的地方，而不是直接不显示。
 */
export function mixNearestDock(layout: MixPanelLayout): MixDock {
    if (layout.w >= 70) return "bottom";
    if (layout.h <= 34 && layout.y >= 50) return "float";
    return layout.x + layout.w / 2 < 50 ? "left" : "right";
}

/**
 * 机括：两个部分，任一半可留空。
 * - 钩子：在流水线的固定几个口子上被叫起来跑一下，收数据包、还数据包，
 *   跑在没有网络、碰不到宿主页面的沙盒里，还带超时熔断。
 * - 常驻界面：按自己写的坐标与尺寸挂一段 HTML，跨轮活着、有自己的存储。
 * 两半共用同一个存储桶，天然能互相看见。
 */
export type MixMechanismMaterial = MixMaterialMeta & {
    kind: "mechanism";
    /** 钩子代码：定义 onSessionStart / onBeforeSend / onAfterReply / onSessionEnd */
    script?: string;
    /** @deprecated 第一版的四个停靠位，只为认得出老材料而保留；新材料写 layout */
    dock?: MixDock;
    /**
     * 常驻界面的起始摆放。新材料一般没有这个字段——画在哪、多大、要不要应用画外壳，
     * 都在界面代码里用 mix.move / mix.size / mix.chrome … 写。有没有界面看 panelHtml。
     */
    layout?: MixPanelLayout;
    /** 常驻界面的 HTML（含 CSS/JS），在沙盒 iframe 里跑 */
    panelHtml?: string;
};

export type MixMaterial =
    | MixCharacterCard
    | MixPersonaMaterial
    | MixTextMaterial
    | MixTicketMaterial
    | MixGarnishMaterial
    | MixEncoreMaterial
    | MixFilterMaterial
    | MixMechanismMaterial;

/** 条件里的比较符 */
export type MixCompareOp = ">" | ">=" | "<" | "<=" | "=" | "!=";

/**
 * 一件材料的生效条件。不写 = 一直生效。
 * 刻意只做「一句话能说清」的四种，不支持嵌套、不做表达式求值——
 * 条件是纯数据，跟着材料分享出去也不会执行任何东西。
 */
export type MixCondition =
    /** 聊到第 N 轮之后 */
    | { type: "turn"; after: number }
    /** 记住的某个值满足比较（数字按数字比，其余按文字比） */
    | { type: "var"; name: string; op: MixCompareOp; value: string }
    /** 最近 within 轮里提到过其中任一个词（默认只看最近 1 轮） */
    | { type: "keyword"; words: string[]; within?: number }
    /** 随机 percent% 的轮次生效 */
    | { type: "chance"; percent: number };

/** 配方里的一条材料：材料 id + 生效条件 */
export type MixSlotEntry = {
    materialId: string;
    when?: MixCondition;
};

/** 对局记住的值：可能是数字（好感度 61），也可能是文字（时段 深夜） */
export type MixStateValue = string | number;
export type MixState = Record<string, MixStateValue>;

/** 兼容早期数据：那时一格只放一件，槽位存的是材料 id 字符串 */
export type MixSlotsRaw = Partial<Record<MixMaterialKind, string | MixSlotEntry[]>>;

/** 读一格里的材料清单（吃得下新旧两种形状） */
export function mixSlotEntries(slots: MixSlotsRaw | undefined, kind: MixMaterialKind): MixSlotEntry[] {
    const raw = slots?.[kind];
    if (!raw) return [];
    if (typeof raw === "string") return [{ materialId: raw }];
    return raw.filter((entry) => entry && typeof entry.materialId === "string" && entry.materialId);
}

/** 一格里第一件材料的 id（角色卡、面具这种单件格用） */
export function mixSlotFirstId(slots: MixSlotsRaw | undefined, kind: MixMaterialKind): string | undefined {
    return mixSlotEntries(slots, kind)[0]?.materialId;
}

/** 把任意形状的槽位统一成新形状（读盘时做一次，之后全程按新形状走） */
export function normalizeMixSlots(slots: MixSlotsRaw | undefined): Partial<Record<MixMaterialKind, MixSlotEntry[]>> {
    const out: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
    for (const kind of MIX_SLOT_ORDER) {
        const entries = mixSlotEntries(slots, kind);
        if (entries.length) out[kind] = entries;
    }
    return out;
}

/** 特调方案：每个槽位记录所用材料（材料本体在酒柜里） */
export type MixRecipe = {
    id: string;
    name: string;
    /** kind → 这一格叠的材料（有序，不设数量上限）；角色卡必有，其余可缺 */
    slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>>;
    /** 作者署名与头像：从配方页入柜时带回；自己的配方展示本地创作者资料 */
    author?: string;
    authorAvatar?: string;
    /** 已上架到配方页时的线上 id */
    publishedId?: string;
    /** 最近一次同步到云端成功时的 updatedAt 快照 */
    publishedAt?: number;
    /** 从配方页导入的别人的配方：不能二次发布 */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/**
 * 一轮里的一块壳内原文（状态栏或小剧场）。
 * id = 供稿材料：渲染时按它找皮（现役件 → 退役快照 → 酒柜同 id 件）；
 * 抽不到归属（旧格式输出、契约外的多余块）时缺省，渲染退回这一格的第一件。
 */
export type MixTurnBlock = {
    id?: string;
    raw: string;
};

/** 对局消息 */
export type MixTurn = {
    id: string;
    role: "user" | "assistant";
    /** 正文（assistant 侧已剥离小票块） */
    text: string;
    /**
     * 这一轮的原始输出（assistant 侧）：进剥离/滤网/机括之前的完整原文，
     * 含机括标记行与被滤网洗掉的字；状态栏补写的块也并在里面（它算这一轮产出的一部分）。
     * 「编辑原始输出」展示并回写的就是这一份；老数据没有这个字段，
     * 编辑时退回用产物拼装（mixTurnRawText 的兜底路径）。
     */
    rawText?: string;
    /** 该轮小票壳内原文（有小票材料且 AI 按契约输出时才有）；多块时为第一块，全量见 ticketRaws */
    ticketRaw?: string;
    /** 该轮小剧场壳内原文（尾调写了契约且 AI 输出时才有）；多块时为第一块，全量见 encoreRaws */
    encoreRaw?: string;
    /**
     * 多块并行（一轮多个状态栏/小剧场）时的全量块序列，按输出顺序排列。
     * 老数据没有这两个字段——读取一律走 mixTurnTicketBlocks / mixTurnEncoreBlocks，
     * 它们会把旧的单块字段包装成一块返回。
     */
    ticketRaws?: MixTurnBlock[];
    encoreRaws?: MixTurnBlock[];
    /**
     * 供稿材料戳（可选）：平时不写——历史轮跟着当前件的渲染代码走（整体换皮）。
     * 只在局中换小票/尾调那一刻，由旧件给已有的轮盖上自己的 id；
     * 渲染时有戳的轮用戳指向的皮（见 MixSession.retiredRender），新轮用新件。
     * 多块格式的轮不用戳——每块自带供稿材料 id。
     */
    ticketId?: string;
    encoreId?: string;
    /**
     * 这一轮结束时记住的值。回溯 / 重说 / 编辑某轮之后，
     * 直接取剩下最后一轮的这份快照还原，数字不会停留在被丢掉的未来。
     */
    state?: MixState;
    /**
     * 这一轮结束时的机括存储（与 state 同一套语义，只在 assistant 轮上）。
     * 有它才谈得上"干净回溯"：机括存储是任意可读写的，不像 turns 那样只增不改，
     * 砍掉几轮推不出过去的样子，只能当时拍照留档。
     *
     * 只留最近 MIX_STORE_SNAPSHOT_TURNS 轮（见 engine.ts）——存储桶单件上限 100KB，
     * 逐轮全留会把对局存档撑爆。窗口外的回溯退到现存最早的那份；老对局没有这个
     * 字段，回溯时维持现状，绝不清空。
     */
    mechanismStore?: Record<string, Record<string, string>>;
    /**
     * 玩家在机括面板里手改过的桶（materialId → 桶），记在手改发生的那一轮上。
     * 编辑早先某一轮后要把后面每一轮按原文重画一遍，重画走到这一轮时会拿它再盖一次：
     * 手改是玩家亲手定的事实，永远压过重画算出来的结果。
     */
    mechanismStoreEdits?: Record<string, Record<string, string>>;
    createdAt: number;
};

/** 对局：一次「角色卡 + 特调」的运行 */
export type MixSession = {
    id: string;
    /** 开局时的方案快照（防止事后改方案影响旧局回放语义） */
    recipe: MixRecipe;
    /** 角色名快照（列表展示用，酒柜里的卡被删也不受影响） */
    charName: string;
    /** 用户的名字（{{user}}），空则用默认 */
    userName?: string;
    /** 选用的开场索引 */
    openingIndex: number;
    turns: MixTurn[];
    /** 当前记住的值（小票里勾了「记住」的项，每轮更新） */
    state?: MixState;
    /**
     * 每件机括自己的存储桶（materialId → 键值表），退出再进来还在。
     * 刻意不随轮次做快照：存储桶上限给到 100KB，逐轮留档会把对局撑爆。
     * 回溯之后机括看到的还是回溯前的私有记忆——数据包里带了 turnCount，
     * 需要的话机括可以自己发现轮数倒退并复位。
     */
    mechanismStore?: Record<string, Record<string, string>>;
    /**
     * 最后一轮出杯后钩子跑之前的机括存储快照 + 它属于哪一轮。
     * 编辑原始输出后的「替换重跑」靠它：先回到这轮记账前的底稿再重跑一次钩子，
     * 原来那笔账自然作废，反复编辑反复同步也只记一笔。只留最后一轮——
     * 编辑角色回复本来就会把之后的轮全部截掉，编辑完它一定是最后一轮。
     */
    mechanismStorePrev?: Record<string, Record<string, string>>;
    mechanismStorePrevTurn?: string;
    /**
     * 玩家自己拖动/缩放过的面板位置（materialId → 摆放），只在这一局有效。
     * 不写回材料：材料是作者的作品，玩家挪一下自己的屏幕不该改到别人的作品。
     */
    panelBox?: Record<string, MixPanelLayout>;
    /**
     * 按钮位机括面板的开合状态（materialId → 是否展开），按局记忆。
     * 只对挂在 header/inputbar-* 的机括有意义；关掉的面板不渲染（重开会重载，
     * 需要留住的状态放机括存储桶里）。
     */
    panelOpen?: Record<string, boolean>;
    /**
     * 退役的渲染皮（materialId → 渲染 HTML）：局中换小票/尾调那一刻，旧件的
     * 渲染代码快照进来，被盖了戳的历史轮（MixTurn.ticketId/encoreId）按这份
     * 皮回放——旧件之后从酒柜删掉也不受影响。每件只存一份，不逐轮存。
     */
    retiredRender?: Record<string, string>;
    /**
     * 回传上下文轮数上限（一轮 = 一次 AI 回复）。不设 = 全部历史回传；
     * 设了只把最近 N 轮发给模型——只影响请求内容，存储与界面回放永远完整。
     */
    historyLimit?: number;
    /**
     * 背景观感微调（对局页右上角亮度按钮）：mask = 蒙版亮度 -40~100（0 为默认
     * 三段蒙版原样，负值在蒙版外再压一层匀黑更暗，100 为完全无蒙版）；
     * blur = 封面模糊 0~20px。按局保存——不同封面的明暗各不相同，各局各调。
     */
    bgTune?: { mask: number; blur: number };
    createdAt: number;
    updatedAt: number;
};

/**
 * 读一轮的状态栏块序列：新格式（ticketRaws）直接用；老数据把单块字段包装成一块，
 * 块的归属沿用换装时盖的戳（没盖过就是缺省 = 跟当前件走）。
 */
export function mixTurnTicketBlocks(turn: MixTurn): MixTurnBlock[] {
    if (turn.ticketRaws?.length) return turn.ticketRaws;
    if (turn.ticketRaw) return [{ id: turn.ticketId, raw: turn.ticketRaw }];
    return [];
}

/** 读一轮的小剧场块序列（同 mixTurnTicketBlocks） */
export function mixTurnEncoreBlocks(turn: MixTurn): MixTurnBlock[] {
    if (turn.encoreRaws?.length) return turn.encoreRaws;
    if (turn.encoreRaw) return [{ id: turn.encoreId, raw: turn.encoreRaw }];
    return [];
}

/**
 * 与云端的关联状态（参考应用市场的显式同步模型）：
 * local = 没上架过；synced = 已上架且本地无改动；dirty = 已上架但本地改动还没同步。
 * 同步是显式动作——本地保存永远不自动推云端，云端也不会反向覆盖本地。
 */
export function mixCloudState(item: { publishedId?: string; publishedAt?: number; updatedAt: number }): "local" | "synced" | "dirty" {
    if (!item.publishedId) return "local";
    if (!item.publishedAt || item.updatedAt > item.publishedAt) return "dirty";
    return "synced";
}

/** 生成短 id（本地实体通用） */
export function createMixId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
