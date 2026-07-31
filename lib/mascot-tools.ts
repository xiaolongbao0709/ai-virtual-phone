// lib/mascot-tools.ts
// 小卷工具系统：7 个套件 + 36 个细粒度工具，支持文本协议和原生协议双轨。
//
// 套件设计（默认只暴露 loader，按需展开）：
//   - 角色卡套件 (character_pack)     — 3 个子工具
//   - 世界书套件 (worldbook_pack)     — 5 个子工具
//   - 预设套件 (preset_pack)          — 5 个子工具
//   - 正则套件 (regex_pack)           — 5 个子工具
//   - CSS套件 (css_pack)              — 3 个子工具
//   - 图像处理套件 (image_pack)       — 10 个子工具
//   - 导航工具 (navigate)             — 1 个独立工具（直接暴露）

import type { LlmToolDefinition } from "./llm-provider-adapter";
import type { ToolCall, ToolResult } from "./tool-executor";
import type { MascotPageContext } from "./mascot-context";
import type { Prompt } from "./settings-types";
import { CHARACTER_CARD_PROMPT, WORLDBOOK_PROMPT, PRESET_PROMPT, GENERAL_PRESET_PROMPT, REGEX_PROMPT, CSS_PROMPT, WIDGET_PROMPT } from "./mascot-prompts";
import {
    buildCssAssetNineSliceCss,
    calibrateCssAssetNineSlice,
    convertCssAsset,
    createCssAssetFromGeneratedImage,
    cropCssAsset,
    importUserImageAsCssAsset,
    listOrReadCssAssets,
    listUserUploadedImages,
    removeCssAssetBackground,
    uploadCssAssetToImageHost,
    type CssAssetUserImageHistoryMessage,
} from "./css-asset-tools";

// ── 通用类型 ────────────────────────────────────────────

export type MascotSubTool = {
    name: string;
    description: string;
    parameterSchema: Record<string, unknown>;
};

export type MascotToolPackage = {
    id: string;
    label: string;
    description: string;
    subTools: MascotSubTool[];
    usageGuide?: string; // 文本协议下，展开时额外的写作指南
};

// ── 工具参数 Schema 定义 ────────────────────────────────

// ── CSS 工具 ──
const CSS_LOCATION_ENUM = ["chat_app", "chat_session", "mascot_chat", "story", "music", "calendar"];

const SESSION_NAME_DESC = "（仅 location=chat_session 或 story 时使用）会话名：聊天室填角色名/备注名/群名；剧情会话填角色名/标题。不传则用当前页面正在打开的会话；当前页面没打开会话时，工具会返回可选会话列表让你确认。mascot_chat 不需要传。";

const READ_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置；不传则返回所有位置的状态概览" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    additionalProperties: false,
};

const OVERWRITE_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置" },
        css: { type: "string", description: "新的完整 CSS 内容，会替换该位置的所有 CSS" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location", "css"],
    additionalProperties: false,
};

const CLEAR_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location"],
    additionalProperties: false,
};

// ── 图像处理工具 ──
const IMAGE_ASSET_KIND_ENUM = ["bubble", "icon", "texture", "background", "misc"];

const GENERATE_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        description: { type: "string", description: "要生成的图片素材描述。用于 CSS 的素材应明确用途、颜色和尺寸倾向。制作气泡/图标时，不要要求透明背景；应要求纯白背景/solid white background、不要透明棋盘格/checkerboard、不要示例文字/水印、主体四周留白，生成后再用「去底透明」转透明。制作九宫格气泡时，重要装饰应靠四角或尾部，避开顶部/底部横向中间、左右竖向中间和中心拉伸区。" },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "素材类型：bubble=聊天气泡，icon=图标，texture=纹理，background=背景，misc=其他" },
        label: { type: "string", description: "素材名称，便于后续读取/裁切/上传" },
        characterId: { type: "string", description: "可选：使用某角色参考图时传角色 id" },
        useReferenceImage: { type: "boolean", description: "是否使用角色参考图；不确定不要传 true" },
    },
    required: ["description"],
    additionalProperties: false,
};

const LIST_USER_IMAGES_SCHEMA = {
    type: "object",
    properties: {
        limit: { type: "number", description: "最多返回多少张最近用户图片，默认 12，最大 20" },
    },
    additionalProperties: false,
};

const IMPORT_USER_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        sourceImageId: { type: "string", description: "用户图片 id，从「列出用户图片」获取；不传则默认导入 user_image_1" },
        messageOffset: { type: "number", description: "可选：第几条带图用户消息，0=最近；传 sourceImageId 时忽略" },
        imageIndex: { type: "number", description: "可选：同一条消息里的第几张图，0=第一张；传 sourceImageId 时忽略" },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "素材类型：bubble=聊天气泡，icon=图标，texture=纹理，background=背景，misc=其他" },
        label: { type: "string", description: "导入后的素材名称" },
    },
    additionalProperties: false,
};

const CROP_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id，从「生成图像素材」或「列出读取素材」结果获取" },
        cropMode: { type: "string", enum: ["coordinates", "auto_trim"], description: "coordinates=按坐标裁切；auto_trim=自动裁掉透明/近似纯色边缘" },
        unit: { type: "string", enum: ["pixel", "percent"], description: "坐标单位；默认 pixel。percent 表示 0-100 百分比" },
        x: { type: "number", description: "裁切框左上角 x；coordinates 模式使用" },
        y: { type: "number", description: "裁切框左上角 y；coordinates 模式使用" },
        width: { type: "number", description: "裁切框宽度；coordinates 模式使用" },
        height: { type: "number", description: "裁切框高度；coordinates 模式使用" },
        padding: { type: "number", description: "裁切框额外保留边距，单位像素；auto_trim 时常用 2-12" },
        tolerance: { type: "number", description: "auto_trim 的边缘容差，0-255；默认 18，背景边缘不干净时可提高" },
        outputWidth: { type: "number", description: "可选：输出宽度。不传则使用裁切宽度" },
        outputHeight: { type: "number", description: "可选：输出高度。不传则使用裁切高度" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const REMOVE_IMAGE_BACKGROUND_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        tolerance: { type: "number", description: "底色容差，0-255；白底/浅灰底默认 36，仍有白边可提高到 45-70" },
        feather: { type: "number", description: "边缘羽化半径，0-4；默认 2，用来减轻白边锯齿" },
        backgroundColor: { type: "string", description: "可选：指定要去掉的底色，例如 #ffffff；不传则自动取四角平均色" },
        format: { type: "string", enum: ["png", "webp"], description: "输出格式；默认 png，保留透明度" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const CONVERT_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        format: { type: "string", enum: ["webp", "png", "jpeg"], description: "输出格式；CSS 素材优先 webp" },
        quality: { type: "number", description: "图片质量，0.1-1；webp/jpeg 有效，默认 0.82" },
        maxWidth: { type: "number", description: "最大宽度；不传则不放大也不缩小" },
        maxHeight: { type: "number", description: "最大高度；不传则不放大也不缩小" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const NINE_SLICE_CSS_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id；如果素材已上传图床，会自动使用 publicUrl" },
        url: { type: "string", description: "可选：直接传图片 URL；传了 url 时可不传 assetId" },
        selector: { type: "string", description: "要应用九宫格的 CSS 选择器，默认 .chat-bubble-role-assistant；用户气泡通常用 .chat-bubble-role-user" },
        sliceTop: { type: "number", description: "九宫格上切片像素；必须使用「校准九宫格」返回值" },
        sliceRight: { type: "number", description: "九宫格右切片像素；必须使用「校准九宫格」返回值" },
        sliceBottom: { type: "number", description: "九宫格下切片像素；必须使用「校准九宫格」返回值" },
        sliceLeft: { type: "number", description: "九宫格左切片像素；必须使用「校准九宫格」返回值" },
        displayTop: { type: "number", description: "实际显示的上边区宽度，单位 CSS 像素；必须使用「校准九宫格」返回值，不是源图 slice" },
        displayRight: { type: "number", description: "实际显示的右边区宽度，单位 CSS 像素；通常 12-48" },
        displayBottom: { type: "number", description: "实际显示的下边区宽度，单位 CSS 像素；通常 14-56" },
        displayLeft: { type: "number", description: "实际显示的左边区宽度，单位 CSS 像素；通常 12-48" },
        paddingTop: { type: "number", description: "文字离气泡外框顶部的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingRight: { type: "number", description: "文字离气泡外框右侧的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingBottom: { type: "number", description: "文字离气泡外框底部的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingLeft: { type: "number", description: "文字离气泡外框左侧的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        minWidth: { type: "number", description: "左右保护区最低宽度；有「校准九宫格」返回值时必须照传，用来防止左右保护区互相挤压" },
        minHeight: { type: "number", description: "上下保护区最低高度；有「校准九宫格」返回值时必须照传，用来防止上下保护区互相挤压" },
    },
    required: [
        "sliceTop",
        "sliceRight",
        "sliceBottom",
        "sliceLeft",
        "displayTop",
        "displayRight",
        "displayBottom",
        "displayLeft",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
    ],
    additionalProperties: false,
};

const CALIBRATE_NINE_SLICE_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "要校准九宫格切线的素材 id" },
        selector: { type: "string", description: "要应用九宫格的 CSS 选择器，默认 .chat-bubble-role-assistant；用户气泡通常用 .chat-bubble-role-user" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const READ_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "可选：素材 id。不传则列出最近 20 个素材" },
    },
    additionalProperties: false,
};

const UPLOAD_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        filename: { type: "string", description: "上传文件名，可选" },
        expirationSeconds: { type: "number", description: "ImgBB 过期秒数；0=永久，60-15552000=定时过期。不传则用设置页默认值" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

// ── 角色工具 ──
const READ_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "角色名；不传则列出所有角色" },
    },
    additionalProperties: false,
};

const CREATE_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "角色全名" },
        persona: { type: "string", description: "完整人设（7 段式 markdown）" },
        personality: { type: "string", description: "性格简介（80-200 字）" },
    },
    required: ["name", "persona", "personality"],
    additionalProperties: false,
};

const UPDATE_CHARACTER_FIELD_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "要修改的角色名" },
        field: { type: "string", enum: ["name", "persona", "personality"], description: "字段名" },
        value: { type: "string", description: "新值" },
    },
    required: ["name", "field", "value"],
    additionalProperties: false,
};

// ── 世界书工具 ──
const LIST_WORLDBOOKS_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "世界书名；不传则列出所有世界书" },
    },
    additionalProperties: false,
};

const READ_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryComment: { type: "string", description: "词条的 comment（备注名）" },
    },
    required: ["worldbook", "entryComment"],
    additionalProperties: false,
};

const CREATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名；如果不存在会自动创建" },
        comment: { type: "string", description: "词条备注（用户可见的标签）" },
        key: { type: "string", description: "触发关键词，多个用逗号分隔" },
        content: { type: "string", description: "词条内容（推荐用 XML 标签包裹）" },
        constant: { type: "boolean", description: "是否常驻（true=每次都注入，false=关键词触发）" },
        position: { type: "string", enum: ["0", "1"], description: "0=角色描述前，1=角色描述后" },
    },
    required: ["worldbook", "comment", "key", "content"],
    additionalProperties: false,
};

const UPDATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryUid: { type: "string", description: "词条 uid（从读取/列出结果里获取）" },
        field: { type: "string", enum: ["key", "content", "comment", "constant", "position"], description: "要更新的字段" },
        value: { type: "string", description: "新值（boolean 字段用 'true'/'false'，position 用 '0'/'1'）" },
    },
    required: ["worldbook", "entryUid", "field", "value"],
    additionalProperties: false,
};

const DELETE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryUid: { type: "string", description: "词条 uid" },
    },
    required: ["worldbook", "entryUid"],
    additionalProperties: false,
};

// ── 预设工具 ──
const LIST_PRESETS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "预设名" },
    },
    required: ["name"],
    additionalProperties: false,
};

const READ_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id（从读取预设结果获取）" },
        promptIndex: { type: "number", description: "条目索引（从读取预设结果获取，从 0 开始）" },
    },
    required: ["presetId", "promptIndex"],
    additionalProperties: false,
};

const DUPLICATE_PRESET_SCHEMA = {
    type: "object",
    properties: {
        sourceName: { type: "string", description: "要复制的源预设名" },
        newName: { type: "string", description: "副本的新名字" },
        newDescription: { type: "string", description: "副本描述（可选，默认沿用源预设的描述）" },
    },
    required: ["sourceName", "newName"],
    additionalProperties: false,
};

const CREATE_STORY_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "预设名" },
        description: { type: "string", description: "预设描述" },
        prompts: {
            type: "array",
            description: "Prompt 列表，按板块顺序排列。每条至少有 name；marker 条目（◇ 开头）只需 name；普通条目传 name+content；assistant 角色额外加 role:'assistant'",
            items: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Prompt 名（◇ 开头会被识别为 marker）" },
                    role: { type: "string", enum: ["system", "user", "assistant"] },
                    content: { type: "string", description: "Prompt 内容；marker 无需 content" },
                },
                required: ["name"],
            },
        },
    },
    required: ["name", "prompts"],
    additionalProperties: false,
};

const CLONE_BUILTIN_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "新预设名" },
        description: { type: "string", description: "新预设描述（可选，默认空）" },
    },
    required: ["name"],
    additionalProperties: false,
};

const UPDATE_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id" },
        promptIndex: { type: "number", description: "Prompt 在数组中的索引（从 0 开始）" },
        field: { type: "string", enum: ["name", "role", "content", "identifier"], description: "要更新的字段" },
        value: { type: "string", description: "新值" },
    },
    required: ["presetId", "promptIndex", "field", "value"],
    additionalProperties: false,
};

const ADD_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id（从读取预设结果获取）" },
        name: { type: "string", description: "Prompt 名；◇ 开头会被识别为 marker 并清空 content" },
        role: { type: "string", enum: ["system", "user", "assistant"], description: "角色，默认 system" },
        content: { type: "string", description: "Prompt 内容；marker 条目可不传" },
        identifier: { type: "string", description: "可选 identifier；不传则自动生成且避开重复" },
        insertAfterIndex: { type: "number", description: "可选：插到该 promptIndex 后；不传则追加到末尾" },
        enabled: { type: "boolean", description: "是否启用，默认 true" },
        tags: {
            type: "array",
            description: "可选：通用预设的适用标签数组；不确定不要传",
            items: { type: "string" },
        },
    },
    required: ["presetId", "name"],
    additionalProperties: false,
};

const UPDATE_PRESET_INFO_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id" },
        name: { type: "string", description: "新的预设名（可选）" },
        description: { type: "string", description: "新的预设描述（可选）" },
    },
    required: ["presetId"],
    additionalProperties: false,
};

// ── 正则工具 ──
const LIST_REGEX_GROUPS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "正则组名" },
    },
    required: ["name"],
    additionalProperties: false,
};

const REGEX_RULE_OBJ = {
    type: "object",
    properties: {
        scriptName: { type: "string", description: "规则名" },
        findRegex: { type: "string", description: "查找正则（/pattern/flags 格式）" },
        replaceString: { type: "string", description: "替换字符串（支持 $0/$1 等捕获组）" },
        tags: {
            type: "array",
            items: { type: "string", enum: ["chat", "text", "group_chat", "story", "offline"] },
            description: "必填适用范围，四选一：聊天=[\"chat\",\"text\"]；群聊=[\"group_chat\",\"text\"]；剧情/故事模式=[\"story\"]；线下=[\"offline\"]。不要留空。",
        },
        placement: { type: "array", items: { type: "number" }, description: "[1]=输入,[2]=输出(聊天/群聊/线下的状态栏·内心·状态值都在这),[5]=世界书,[6]=思维链/推理(仅剧情·漫卷模式获取,聊天等用不到)" },
        disabled: { type: "boolean" },
        markdownOnly: { type: "boolean", description: "仅显示层应用，不影响存储" },
        promptOnly: { type: "boolean", description: "仅 prompt 应用，不影响显示" },
        substituteRegex: { type: "string", enum: ["0", "1", "2"], description: "0=不替换 1=原始替换 2=转义后替换宏（如{{user}}）" },
    },
    required: ["scriptName", "findRegex", "replaceString"],
};

const CREATE_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "正则组名" },
        rules: { type: "array", items: REGEX_RULE_OBJ, description: "规则列表" },
    },
    required: ["name", "rules"],
    additionalProperties: false,
};

const ADD_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "正则组名" },
        rule: REGEX_RULE_OBJ,
    },
    required: ["groupName", "rule"],
    additionalProperties: false,
};

const UPDATE_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "正则组名" },
        ruleId: { type: "string", description: "规则 id" },
        updates: { ...REGEX_RULE_OBJ, required: [] as string[] },
    },
    required: ["groupName", "ruleId", "updates"],
    additionalProperties: false,
};

// ── 桌面组件工具 ──
const WIDGET_SIZE_ENUM = ["1x1", "1x2", "1x4", "2x1", "2x2", "2x3", "2x4", "3x2", "3x3", "3x4", "4x2", "4x3", "4x4", "5x4", "6x4"];

const LIST_WIDGET_CATALOG_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_DESKTOP_LAYOUT_SCHEMA = {
    type: "object",
    properties: {
        page: { type: "number", description: "桌面页码（1 起），默认 1" },
    },
    additionalProperties: false,
};

const CREATE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "组件名（显示在组件挑选器里）" },
        size: { type: "string", enum: WIDGET_SIZE_ENUM, description: "尺寸，行x列" },
        htmlString: { type: "string", description: "完整自包含 HTML 文档（内联全部 CSS/JS）" },
        autoPlace: { type: "boolean", description: "创建后自动摆上桌面空位，默认 true" },
        page: { type: "number", description: "自动摆放的目标页码（1 起），默认 1" },
    },
    required: ["name", "size", "htmlString"],
    additionalProperties: false,
};

const UPDATE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        templateId: { type: "string", description: "DIY 模板 id（diy- 开头）" },
        name: { type: "string", description: "新组件名" },
        size: { type: "string", enum: WIDGET_SIZE_ENUM, description: "新尺寸；桌面实例位置放不下新尺寸时该实例会被移下桌面" },
        htmlString: { type: "string", description: "新的完整 HTML 文档；桌面实例会实时热更新" },
    },
    required: ["templateId"],
    additionalProperties: false,
};

const PREVIEW_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        templateId: { type: "string", description: "要预览的 DIY 模板 id" },
    },
    required: ["templateId"],
    additionalProperties: false,
};

const PLACE_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", description: "组件类型：DIY 模板 id（diy- 开头）或内置组件类型名（见组件目录）" },
        page: { type: "number", description: "目标页码（1 起），默认 1" },
        row: { type: "number", description: "起始行（1-6）；和 col 一起传则精确摆放，否则自动找空位" },
        col: { type: "number", description: "起始列（1-4）" },
    },
    required: ["type"],
    additionalProperties: false,
};

const REMOVE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        widgetId: { type: "string", description: "要移下桌面的组件实例 id（查看桌面布局可得；仅限 DIY 实例）" },
        templateId: { type: "string", description: "要删除的 DIY 模板 id；会连同它的所有桌面实例一起移除" },
    },
    additionalProperties: false,
};

// ── 导航工具 ──
const NAVIGATE_SCHEMA = {
    type: "object",
    properties: {
        page: { type: "string", enum: ["chat", "characters", "story", "vnmode", "moments", "calendar", "music", "resources", "settings"], description: "页面名" },
        subpage: { type: "string", enum: ["presets", "worldbook", "regex", "api", "voice", "binding", "data", "identity"], description: "子页面（仅 settings 下有效）" },
    },
    required: ["page"],
    additionalProperties: false,
};

const IMAGE_ASSET_USAGE_GUIDE = [
    "图像处理套件用于给 CSS 主题制作可复用素材。推荐工作流：",
    "1. 先用「生成图像素材」得到素材 id 和预览。制作气泡/图标时，生图提示词里要写 plain solid white background / no checkerboard background / no sample text / no watermark / subject centered with margin，不要写 transparent background。",
    "2. 制作九宫格气泡时，生图提示词必须要求 decorative elements only near corners or the speech-tail area / keep the center and middle edges clean / avoid decorations in the top-center, bottom-center, left-middle, right-middle, and center stretch areas。猫头、蝴蝶结、花、爪子等大装饰不要放在横向或竖向中间。",
    "3. Image 2 这类模型常会把“透明背景”画成伪透明棋盘格：用白底生成后，再用「去底透明」把外缘连通的白底转透明，最后用「裁切素材」裁掉多余画布。",
    "4. 如果用户上传了现成素材，先用「列出用户图片」确认 sourceImageId，再用「导入用户图片为素材」导入素材库。",
    "5. 气泡/图标如果有多余边缘，优先用 cropMode=auto_trim 的「裁切素材」；结果不理想再按坐标微调。",
    "6. 写入 CSS 前先用「压缩转换素材」转 WebP，并限制尺寸，减少主题加载负担。",
    "7. 只有用户允许图床上传且设置了 ImgBB key 后，才用「上传图床」拿公开 URL。",
    "8. 图片气泡不允许自动猜九宫格参数。需要图片气泡时，先调用「校准九宫格」让用户在弹窗里手动拖切线；校准结果会返回 slice/display/padding 和 CSS。",
    "9. 「生成九宫格CSS」只接受已经校准好的完整参数；缺参数时会失败。不要用系统默认比例、不要自己瞎猜参数。",
    "10. 不要用 background-size: 100% 100% 或 background-size: cover 直接拉伸整张气泡图。",
    "11. 上传成功后只会得到图床URL；不要把 API Key 或 delete_url 写入 CSS。",
].join("\n");

// ── 套件定义 ────────────────────────────────────────────

export const MASCOT_TOOL_PACKAGES: MascotToolPackage[] = [
    {
        id: "css_pack",
        label: "CSS样式套件",
        description: "查看 / 覆写 / 清除 各页面的自定义 CSS。工作流：先 读取CSS 拿到当前内容和可用选择器，再把（要保留的旧内容 + 要修改的部分）拼成完整新内容，最后 覆写CSS 写回。",
        subTools: [
            { name: "读取CSS", description: "读取指定位置的当前 CSS 内容 + 该位置可用的选择器/变量参考。修改前必读。不传 location 时返回 5 个位置的状态概览。", parameterSchema: READ_CSS_SCHEMA },
            { name: "覆写CSS", description: "用新内容替换该位置的全部 CSS。需要小卷自己把（保留的旧规则 + 改动）拼成完整内容再写入。", parameterSchema: OVERWRITE_CSS_SCHEMA },
            { name: "清除CSS", description: "清空指定位置的所有自定义 CSS。", parameterSchema: CLEAR_CSS_SCHEMA },
        ],
        usageGuide: CSS_PROMPT,
    },
    {
        id: "image_pack",
        label: "图像处理套件",
        description: "生成、导入用户图、去底透明、裁切、压缩转换、列出读取、上传和生成九宫格 CSS。适合制作聊天气泡、图标、背景纹理等主题素材。",
        subTools: [
            { name: "生成图像素材", description: "调用已配置的图像生成接口，生成一张可用于 CSS 的素材并保存到本地素材库，返回素材 id 和预览。", parameterSchema: GENERATE_IMAGE_ASSET_SCHEMA },
            { name: "列出用户图片", description: "列出最近小卷对话里用户上传的图片，返回 sourceImageId 和预览，用于选择要导入的素材。", parameterSchema: LIST_USER_IMAGES_SCHEMA },
            { name: "导入用户图片为素材", description: "把用户上传给小卷的图片导入 CSS 素材库，返回 assetId，后续可继续裁切、去底、上传和写 CSS。", parameterSchema: IMPORT_USER_IMAGE_ASSET_SCHEMA },
            { name: "去底透明", description: "把与图片外缘连通的白底/纯色底转成透明，适合处理 Image 2 生成的白底气泡/图标。", parameterSchema: REMOVE_IMAGE_BACKGROUND_SCHEMA },
            { name: "裁切素材", description: "基于素材 id 生成裁切后的新素材。支持坐标裁切，也支持自动裁掉透明/近似纯色边缘。", parameterSchema: CROP_IMAGE_ASSET_SCHEMA },
            { name: "压缩转换素材", description: "把素材转换成 WebP/PNG/JPEG，可限制最大宽高和压缩质量，生成新的素材 id。", parameterSchema: CONVERT_IMAGE_ASSET_SCHEMA },
            { name: "列出读取素材", description: "不传 assetId 时列出最近素材；传 assetId 时读取该素材详情并返回预览。", parameterSchema: READ_IMAGE_ASSET_SCHEMA },
            { name: "上传图床", description: "把素材上传到设置页配置的 ImgBB 图床，返回公开 URL 并保存到素材记录。", parameterSchema: UPLOAD_IMAGE_ASSET_SCHEMA },
            { name: "校准九宫格", description: "打开弹窗让用户手动拖动九宫格切线，并返回精确 slice/display/padding 参数；复杂图片气泡必须先用它校准。", parameterSchema: CALIBRATE_NINE_SLICE_SCHEMA },
            { name: "生成九宫格CSS", description: "根据已校准的完整 slice/display/padding 参数生成 border-image 九宫格 CSS；不会自动猜参数。", parameterSchema: NINE_SLICE_CSS_SCHEMA },
        ],
        usageGuide: IMAGE_ASSET_USAGE_GUIDE,
    },
    {
        id: "character_pack",
        label: "角色卡套件",
        description: "创建 / 修改 / 查看 角色卡。角色由 name/persona/personality 三个字段组成。",
        subTools: [
            { name: "读取角色", description: "不传 name 时列出所有角色；传 name 时返回完整字段。", parameterSchema: READ_CHARACTER_SCHEMA },
            { name: "创建角色", description: "新建一张角色卡。persona 必须包含 7 段式人设（基础信息/外貌/世界观/性格/补充信息/经历）。", parameterSchema: CREATE_CHARACTER_SCHEMA },
            { name: "更新角色字段", description: "修改某角色的单个字段（name/persona/personality）。", parameterSchema: UPDATE_CHARACTER_FIELD_SCHEMA },
        ],
        usageGuide: CHARACTER_CARD_PROMPT,
    },
    {
        id: "worldbook_pack",
        label: "世界书套件",
        description: "管理世界书及其词条。一个世界书包含多个词条，每个词条可以是常驻或关键词触发。",
        subTools: [
            { name: "列出世界书", description: "不传 name 时列出所有世界书；传 name 时返回该世界书的词条列表（含 uid）。", parameterSchema: LIST_WORLDBOOKS_SCHEMA },
            { name: "读取词条", description: "读取某个词条的完整内容。", parameterSchema: READ_WORLDBOOK_ENTRY_SCHEMA },
            { name: "创建词条", description: "在世界书里新建词条。如果指定的世界书不存在会自动创建。content 推荐用 XML 标签包裹增强结构性。", parameterSchema: CREATE_WORLDBOOK_ENTRY_SCHEMA },
            { name: "更新词条", description: "修改词条的某个字段（key/content/comment/constant/position）。", parameterSchema: UPDATE_WORLDBOOK_ENTRY_SCHEMA },
            { name: "删除词条", description: "删除世界书里的某个词条。", parameterSchema: DELETE_WORLDBOOK_ENTRY_SCHEMA },
        ],
        usageGuide: WORLDBOOK_PROMPT,
    },
    {
        id: "preset_pack",
        label: "预设套件",
        description: "管理 LLM 预设。预设分为剧情型(story)和通用型(general)；通用型基于内置预设克隆。每个预设包含多条 prompt，按顺序拼接成系统提示词。",
        subTools: [
            { name: "列出预设", description: "列出所有预设（含类型和是否内置）。", parameterSchema: LIST_PRESETS_SCHEMA },
            { name: "读取预设", description: "读取某预设的条目列表（含每条的 promptIndex/name/tag/role/content 摘要前 100 字）。不返回完整内容，全量条目可能有数十条，省 token。需要看某条详情用「读取预设条目」。", parameterSchema: READ_PRESET_SCHEMA },
            { name: "读取预设条目", description: "读取某预设中单条 prompt 的完整内容（按 promptIndex 定位）。", parameterSchema: READ_PRESET_PROMPT_SCHEMA },
            { name: "创建剧情预设", description: "创建空白剧情预设。剧情预设没有内置模板，prompts 必须自己按 8 板块顺序填写（主人格→标记位→剧情指导→文风→防崩→附加→输出格式→COT）。", parameterSchema: CREATE_STORY_PRESET_SCHEMA },
            { name: "克隆内置预设", description: "基于系统内置的通用预设克隆一份新预设（含 70+ 条 prompt 覆盖所有 app 模式）。克隆后通常用「更新预设条目」按需改 1-5 条。", parameterSchema: CLONE_BUILTIN_PRESET_SCHEMA },
            { name: "复制预设", description: "深拷贝用户已有的某个预设做副本（保留所有条目+顺序+tag）。适合「基于现有 XX 预设做个变体」场景，剧情/通用预设都能复制。", parameterSchema: DUPLICATE_PRESET_SCHEMA },
            { name: "添加预设条目", description: "向已有预设追加或插入一条 prompt，并同步 prompt_order。", parameterSchema: ADD_PRESET_PROMPT_SCHEMA },
            { name: "更新预设条目", description: "修改预设中某条 prompt 的单个字段。", parameterSchema: UPDATE_PRESET_PROMPT_SCHEMA },
            { name: "更新预设信息", description: "修改预设的 name 或 description。", parameterSchema: UPDATE_PRESET_INFO_SCHEMA },
        ],
        usageGuide: `${PRESET_PROMPT}\n\n=== 通用型预设（type=general）补充规则 ===\n${GENERAL_PRESET_PROMPT}`,
    },
    {
        id: "regex_pack",
        label: "正则套件",
        description: "管理正则规则组。每个组包含多条规则，每条规则定义查找/替换模式和应用范围。",
        subTools: [
            { name: "列出正则组", description: "列出所有正则组及其规则数量。", parameterSchema: LIST_REGEX_GROUPS_SCHEMA },
            { name: "读取正则组", description: "读取某组的所有规则（含 rule id）。", parameterSchema: READ_REGEX_GROUP_SCHEMA },
            { name: "创建正则组", description: "新建正则组并填入规则。", parameterSchema: CREATE_REGEX_GROUP_SCHEMA },
            { name: "添加正则规则", description: "向现有组追加一条规则。", parameterSchema: ADD_REGEX_RULE_SCHEMA },
            { name: "更新正则规则", description: "修改某规则的字段（updates 里传部分字段即可）。", parameterSchema: UPDATE_REGEX_RULE_SCHEMA },
        ],
        usageGuide: REGEX_PROMPT,
    },
    {
        id: "widget_pack",
        label: "桌面组件套件",
        description: "创建 / 更新 / 预览 / 摆放 DIY 桌面组件（自包含 HTML，沙箱渲染）。更新后桌面实时热更新，适合小步迭代。",
        subTools: [
            { name: "列出组件目录", description: "列出内置组件与 DIY 组件模板（含 templateId、尺寸、模式）。", parameterSchema: LIST_WIDGET_CATALOG_SCHEMA },
            { name: "查看桌面布局", description: "查看某一页 6x4 网格的占用情况和该页组件实例列表（含实例 id）。", parameterSchema: READ_DESKTOP_LAYOUT_SCHEMA },
            { name: "创建DIY组件", description: "用完整 HTML 新建 DIY 组件模板，默认自动摆上桌面空位。", parameterSchema: CREATE_DIY_WIDGET_SCHEMA },
            { name: "更新DIY组件", description: "修改 DIY 模板的名称/尺寸/HTML；桌面上的实例实时热更新。", parameterSchema: UPDATE_DIY_WIDGET_SCHEMA },
            { name: "预览DIY组件", description: "在对话里弹窗预览某个 DIY 模板的当前效果，不离开聊天。", parameterSchema: PREVIEW_DIY_WIDGET_SCHEMA },
            { name: "摆放组件", description: "把 DIY 模板或内置组件摆上桌面；不传行列时自动找空位。", parameterSchema: PLACE_WIDGET_SCHEMA },
            { name: "移除DIY组件", description: "把 DIY 实例移下桌面，或删除 DIY 模板（连同其所有桌面实例）。", parameterSchema: REMOVE_DIY_WIDGET_SCHEMA },
        ],
        usageGuide: WIDGET_PROMPT,
    },
];

// 导航是独立工具（不在套件里），直接暴露
export const MASCOT_NAVIGATE_TOOL: MascotSubTool = {
    name: "导航",
    description: "跳转到手机里指定页面。subpage 仅在 page=settings 时生效。",
    parameterSchema: NAVIGATE_SCHEMA,
};

// ── 文本协议下的工具列表渲染 ─────────────────────────────

/** 紧凑工具列表（每轮都注入到 system prompt） */
export function buildMascotToolsListPrompt(): string {
    const lines: string[] = [];
    lines.push("===== 你的工具 =====");
    lines.push("以下工具按套件分组。需要使用某套件时，先调用 `展开[套件名]套件` 获取详细动作说明，再执行具体动作。");
    lines.push("");
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        lines.push(`【${pkg.label}】${pkg.description}`);
    }
    // 导航工具不在套件里，schema 直接在这里展开（只一个工具，省得用 [获取指令] 再加载）
    lines.push("【独立工具】导航 — 跳转到指定页面，可直接调用。");
    lines.push("  参数：");
    lines.push("    · page (必填) — 页面名。可选值：chat / characters / story / vnmode / moments / calendar / music / resources / settings");
    lines.push("    · subpage (可选) — 子页面（仅 page=settings 时有效）。可选值：presets / worldbook / regex / api / voice / binding / data / identity");
    lines.push("  调用：[执行动作:导航({\"page\":\"chat\"})] 或 [执行动作:导航({\"page\":\"settings\",\"subpage\":\"presets\"})]");
    lines.push("");
    lines.push("===== 调用规则 =====");
    lines.push("· 展开套件：使用 [获取指令:套件名] 格式，例如 [获取指令:CSS样式套件]");
    lines.push("· 执行动作：使用 [执行动作:动作名({\"参数\":\"值\"})] 格式，例如 [执行动作:读取CSS({\"location\":\"chat_session\"})]");
    lines.push("· 同时展开的套件最多 2 个，超过会自动淘汰最旧的");
    lines.push("· 不需要工具时直接回复文字，正常聊天");
    lines.push("· 重要：调用动作时，回复文本里**不要复述**动作参数的内容（比如不要把 persona 完整文本再写一遍），回复只用一两句话简短说明你在做什么");
    return lines.join("\n");
}

/** 套件展开后的详细 schema（用于 [获取指令] 响应） */
export function buildMascotPackageSchemaPrompt(packageLabel: string, protocol: "text" | "native" = "text"): string {
    const pkg = MASCOT_TOOL_PACKAGES.find(p => p.label === packageLabel || p.id === packageLabel);
    if (!pkg) return `（找不到套件：${packageLabel}）`;

    const lines: string[] = [];
    lines.push(`【${pkg.label}】动作详解`);
    lines.push(pkg.description);
    lines.push("");
    for (const tool of pkg.subTools) {
        lines.push(`◆ ${tool.name}`);
        lines.push(`  说明：${tool.description}`);
        const params = (tool.parameterSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
        const required = (tool.parameterSchema as Record<string, unknown>).required as string[] | undefined;
        if (params && Object.keys(params).length > 0) {
            lines.push(`  参数：`);
            for (const [paramName, paramDef] of Object.entries(params)) {
                const isRequired = required?.includes(paramName) ? "必填" : "可选";
                const enumStr = paramDef.enum ? `（枚举：${(paramDef.enum as unknown[]).join("/")}）` : "";
                lines.push(`    · ${paramName} (${paramDef.type}, ${isRequired})${enumStr} — ${paramDef.description || ""}`);
            }
        } else {
            lines.push(`  参数：无`);
        }
        // 文本协议下展示 [执行动作:...] 语法；原生协议下 LLM 已经能直接看 tool schema，不需要这一行
        if (protocol === "text") {
            lines.push(`  调用：[执行动作:${tool.name}(${formatExampleArgs(tool.parameterSchema)})]`);
        }
        lines.push("");
    }
    if (pkg.usageGuide) {
        lines.push("===== 写作指南 =====");
        lines.push(pkg.usageGuide);
    }
    return lines.join("\n");
}

function formatExampleArgs(schema: Record<string, unknown>): string {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || Object.keys(props).length === 0) return "{}";
    const example: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(props)) {
        if (def.enum && Array.isArray(def.enum)) example[k] = def.enum[0];
        else if (def.type === "string") example[k] = "...";
        else if (def.type === "number") example[k] = 0;
        else if (def.type === "boolean") example[k] = true;
        else if (def.type === "array") example[k] = [];
        else example[k] = null;
    }
    return JSON.stringify(example);
}

function numberOption(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

// ── 原生协议下的工具定义 ─────────────────────────────────

const MASCOT_NATIVE_TOOL_NAMES: Record<string, string> = {
    "导航": "mascot_navigate",
    "读取CSS": "mascot_read_css",
    "覆写CSS": "mascot_write_css",
    "清除CSS": "mascot_clear_css",
    "生成图像素材": "mascot_generate_css_asset",
    "列出用户图片": "mascot_list_user_images",
    "导入用户图片为素材": "mascot_import_user_image_asset",
    "去底透明": "mascot_remove_css_asset_background",
    "裁切素材": "mascot_crop_css_asset",
    "压缩转换素材": "mascot_convert_css_asset",
    "列出读取素材": "mascot_read_css_asset",
    "上传图床": "mascot_upload_css_asset",
    "校准九宫格": "mascot_calibrate_nine_slice",
    "生成九宫格CSS": "mascot_build_nine_slice_css",
    "读取角色": "mascot_read_character",
    "创建角色": "mascot_create_character",
    "更新角色字段": "mascot_update_character_field",
    "列出世界书": "mascot_list_worldbooks",
    "读取词条": "mascot_read_worldbook_entry",
    "创建词条": "mascot_create_worldbook_entry",
    "更新词条": "mascot_update_worldbook_entry",
    "删除词条": "mascot_delete_worldbook_entry",
    "列出预设": "mascot_list_presets",
    "读取预设": "mascot_read_preset",
    "读取预设条目": "mascot_read_preset_prompt",
    "创建剧情预设": "mascot_create_story_preset",
    "克隆内置预设": "mascot_clone_builtin_preset",
    "复制预设": "mascot_duplicate_preset",
    "添加预设条目": "mascot_add_preset_prompt",
    "更新预设条目": "mascot_update_preset_prompt",
    "更新预设信息": "mascot_update_preset_info",
    "列出正则组": "mascot_list_regex_groups",
    "读取正则组": "mascot_read_regex_group",
    "创建正则组": "mascot_create_regex_group",
    "添加正则规则": "mascot_add_regex_rule",
    "更新正则规则": "mascot_update_regex_rule",
    "列出组件目录": "mascot_list_widget_catalog",
    "查看桌面布局": "mascot_read_desktop_layout",
    "创建DIY组件": "mascot_create_diy_widget",
    "更新DIY组件": "mascot_update_diy_widget",
    "预览DIY组件": "mascot_preview_diy_widget",
    "摆放组件": "mascot_place_widget",
    "移除DIY组件": "mascot_remove_diy_widget",
};

const MASCOT_NATIVE_LOADER_NAMES: Record<string, string> = {
    css_pack: "mascot_load_css_pack",
    image_pack: "mascot_load_image_pack",
    character_pack: "mascot_load_character_pack",
    worldbook_pack: "mascot_load_worldbook_pack",
    preset_pack: "mascot_load_preset_pack",
    regex_pack: "mascot_load_regex_pack",
    widget_pack: "mascot_load_widget_pack",
};

export function getMascotNativeToolName(displayName: string): string {
    const name = MASCOT_NATIVE_TOOL_NAMES[displayName];
    if (!name) throw new Error(`Missing mascot native tool alias: ${displayName}`);
    return name;
}

export function getMascotNativeLoaderName(packageId: string): string {
    const name = MASCOT_NATIVE_LOADER_NAMES[packageId];
    if (!name) throw new Error(`Missing mascot native loader alias: ${packageId}`);
    return name;
}

/** 根据已展开的套件 id，构建原生 LLM 工具定义列表 */
export function getMascotNativeToolDefinitions(expandedPackageIds: string[] = []): LlmToolDefinition[] {
    const defs: LlmToolDefinition[] = [];

    // 导航工具：始终暴露
    defs.push({
        name: getMascotNativeToolName(MASCOT_NAVIGATE_TOOL.name),
        description: MASCOT_NAVIGATE_TOOL.description,
        parameters: MASCOT_NAVIGATE_TOOL.parameterSchema,
    });

    // 每个套件先暴露一个 loader（除非已展开）
    const expanded = new Set(expandedPackageIds);
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        if (expanded.has(pkg.id)) {
            // 已展开 → 暴露所有子工具
            for (const tool of pkg.subTools) {
                defs.push({
                    name: getMascotNativeToolName(tool.name),
                    description: tool.description,
                    parameters: tool.parameterSchema,
                });
            }
        } else {
            // 未展开 → 暴露 loader
            // 注：properties 故意带一个无意义可选字段，避免某些 provider（如 Gemini）把空 args 视为未初始化的 protobuf Struct 而拒绝。
            defs.push({
                name: getMascotNativeLoaderName(pkg.id),
                description: `展开「${pkg.label}」动作说明。${pkg.description}`,
                parameters: {
                    type: "object",
                    properties: {
                        reason: { type: "string", description: "可选：为什么要展开这个套件" },
                    },
                    additionalProperties: false,
                },
            });
        }
    }
    return defs;
}

/** 原生工具名 → 中文工具名映射（用于将 LLM 调用转回中文工具名执行） */
export function buildMascotNativeNameMap(): Map<string, string> {
    const map = new Map<string, string>();
    map.set(getMascotNativeToolName(MASCOT_NAVIGATE_TOOL.name), MASCOT_NAVIGATE_TOOL.name);
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        map.set(getMascotNativeLoaderName(pkg.id), `_loader:${pkg.id}`);
        for (const tool of pkg.subTools) {
            map.set(getMascotNativeToolName(tool.name), tool.name);
        }
    }
    return map;
}

// ── 工具执行器 ────────────────────────────────────────

export type MascotToolContext = {
    pageContext: MascotPageContext;
    history?: CssAssetUserImageHistoryMessage[];
};

/** 执行小卷工具调用 */
export async function executeMascotToolCall(call: ToolCall, ctx: MascotToolContext): Promise<ToolResult> {
    try {
        switch (call.name) {
            // ─── CSS ───
            case "读取CSS": return await handleReadCss(call.args, ctx);
            case "覆写CSS": return await handleOverwriteCss(call.args, ctx);
            case "清除CSS": return await handleClearCss(call.args, ctx);

            // ─── 图像处理 ───
            case "生成图像素材": return await handleGenerateCssAsset(call.args);
            case "列出用户图片": return await handleListUserImages(call.args, ctx);
            case "导入用户图片为素材": return await handleImportUserImageAsAsset(call.args, ctx);
            case "去底透明": return await handleRemoveCssAssetBackground(call.args);
            case "裁切素材": return await handleCropCssAsset(call.args);
            case "压缩转换素材": return await handleConvertCssAsset(call.args);
            case "列出读取素材": return await handleListOrReadCssAssets(call.args);
            case "上传图床": return await handleUploadCssAsset(call.args);
            case "校准九宫格": return await handleCalibrateNineSlice(call.args);
            case "生成九宫格CSS": return await handleBuildNineSliceCss(call.args);

            // ─── 角色 ───
            case "读取角色": return await handleReadCharacter(call.args);
            case "创建角色": return await handleCreateCharacter(call.args);
            case "更新角色字段": return await handleUpdateCharacterField(call.args);

            // ─── 世界书 ───
            case "列出世界书": return await handleListWorldbooks(call.args);
            case "读取词条": return await handleReadWorldbookEntry(call.args);
            case "创建词条": return await handleCreateWorldbookEntry(call.args);
            case "更新词条": return await handleUpdateWorldbookEntry(call.args);
            case "删除词条": return await handleDeleteWorldbookEntry(call.args);

            // ─── 预设 ───
            case "列出预设": return await handleListPresets();
            case "读取预设": return await handleReadPreset(call.args);
            case "读取预设条目": return await handleReadPresetPrompt(call.args);
            case "创建剧情预设": return await handleCreateStoryPreset(call.args);
            case "克隆内置预设": return await handleCloneBuiltinPreset(call.args);
            case "复制预设": return await handleDuplicatePreset(call.args);
            case "添加预设条目": return await handleAddPresetPrompt(call.args);
            case "更新预设条目": return await handleUpdatePresetPrompt(call.args);
            case "更新预设信息": return await handleUpdatePresetInfo(call.args);

            // ─── 正则 ───
            case "列出正则组": return await handleListRegexGroups();
            case "读取正则组": return await handleReadRegexGroup(call.args);
            case "创建正则组": return await handleCreateRegexGroup(call.args);
            case "添加正则规则": return await handleAddRegexRule(call.args);
            case "更新正则规则": return await handleUpdateRegexRule(call.args);

            // ─── 桌面组件 ───
            case "列出组件目录": return await handleListWidgetCatalog();
            case "查看桌面布局": return await handleReadDesktopLayout(call.args);
            case "创建DIY组件": return await handleCreateDiyWidget(call.args);
            case "更新DIY组件": return await handleUpdateDiyWidget(call.args);
            case "预览DIY组件": return await handlePreviewDiyWidget(call.args);
            case "摆放组件": return await handlePlaceWidget(call.args);
            case "移除DIY组件": return await handleRemoveDiyWidget(call.args);

            // ─── 导航 ───
            case "导航": return await handleNavigate(call.args);

            default:
                return { name: call.name, success: false, error: `未知工具：${call.name}` };
        }
    } catch (err) {
        return { name: call.name, success: false, error: (err as Error).message };
    }
}

// ── Image Asset Handlers ───────────────────────

async function handleGenerateCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return createCssAssetFromGeneratedImage({
        description: typeof args.description === "string" ? args.description : "",
        kind: args.kind,
        label: typeof args.label === "string" ? args.label : undefined,
        characterId: typeof args.characterId === "string" ? args.characterId : undefined,
        useReferenceImage: args.useReferenceImage === true,
    });
}

async function handleListUserImages(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    return listUserUploadedImages({
        history: ctx.history,
        limit: typeof args.limit === "number" ? args.limit : undefined,
    });
}

async function handleImportUserImageAsAsset(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    return importUserImageAsCssAsset({
        history: ctx.history,
        sourceImageId: typeof args.sourceImageId === "string" ? args.sourceImageId : undefined,
        messageOffset: typeof args.messageOffset === "number" ? args.messageOffset : undefined,
        imageIndex: typeof args.imageIndex === "number" ? args.imageIndex : undefined,
        kind: args.kind,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleCropCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return cropCssAsset({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        cropMode: args.cropMode === "auto_trim" ? "auto_trim" : "coordinates",
        unit: args.unit === "percent" ? "percent" : "pixel",
        x: typeof args.x === "number" ? args.x : undefined,
        y: typeof args.y === "number" ? args.y : undefined,
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        padding: typeof args.padding === "number" ? args.padding : undefined,
        tolerance: typeof args.tolerance === "number" ? args.tolerance : undefined,
        outputWidth: typeof args.outputWidth === "number" ? args.outputWidth : undefined,
        outputHeight: typeof args.outputHeight === "number" ? args.outputHeight : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleRemoveCssAssetBackground(args: Record<string, unknown>): Promise<ToolResult> {
    return removeCssAssetBackground({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        tolerance: typeof args.tolerance === "number" ? args.tolerance : undefined,
        feather: typeof args.feather === "number" ? args.feather : undefined,
        backgroundColor: typeof args.backgroundColor === "string" ? args.backgroundColor : undefined,
        format: args.format === "webp" ? "webp" : "png",
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleConvertCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return convertCssAsset({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        format: args.format === "png" || args.format === "jpeg" || args.format === "webp" ? args.format : undefined,
        quality: typeof args.quality === "number" ? args.quality : undefined,
        maxWidth: typeof args.maxWidth === "number" ? args.maxWidth : undefined,
        maxHeight: typeof args.maxHeight === "number" ? args.maxHeight : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleListOrReadCssAssets(args: Record<string, unknown>): Promise<ToolResult> {
    return listOrReadCssAssets({
        assetId: typeof args.assetId === "string" ? args.assetId : undefined,
    });
}

async function handleCalibrateNineSlice(args: Record<string, unknown>): Promise<ToolResult> {
    return calibrateCssAssetNineSlice({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        selector: typeof args.selector === "string" ? args.selector : undefined,
    });
}

async function handleBuildNineSliceCss(args: Record<string, unknown>): Promise<ToolResult> {
    return buildCssAssetNineSliceCss({
        assetId: typeof args.assetId === "string" ? args.assetId : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        sliceTop: typeof args.sliceTop === "number" ? args.sliceTop : undefined,
        sliceRight: typeof args.sliceRight === "number" ? args.sliceRight : undefined,
        sliceBottom: typeof args.sliceBottom === "number" ? args.sliceBottom : undefined,
        sliceLeft: typeof args.sliceLeft === "number" ? args.sliceLeft : undefined,
        displayTop: typeof args.displayTop === "number" ? args.displayTop : undefined,
        displayRight: typeof args.displayRight === "number" ? args.displayRight : undefined,
        displayBottom: typeof args.displayBottom === "number" ? args.displayBottom : undefined,
        displayLeft: typeof args.displayLeft === "number" ? args.displayLeft : undefined,
        paddingTop: typeof args.paddingTop === "number" ? args.paddingTop : undefined,
        paddingRight: typeof args.paddingRight === "number" ? args.paddingRight : undefined,
        paddingBottom: typeof args.paddingBottom === "number" ? args.paddingBottom : undefined,
        paddingLeft: typeof args.paddingLeft === "number" ? args.paddingLeft : undefined,
        minWidth: typeof args.minWidth === "number" ? args.minWidth : undefined,
        minHeight: typeof args.minHeight === "number" ? args.minHeight : undefined,
    });
}

async function handleUploadCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return uploadCssAssetToImageHost({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        filename: typeof args.filename === "string" ? args.filename : undefined,
        expirationSeconds: typeof args.expirationSeconds === "number" ? args.expirationSeconds : undefined,
    });
}

// ── CSS Handlers ────────────────────────────────

const CSS_LOCATION_LABELS: Record<string, { label: string; storageKey?: string; needsSession?: "chat" | "story" }> = {
    chat_app: { label: "聊天应用 CSS", storageKey: "chat-app-custom-css" },
    chat_session: { label: "单独聊天室 CSS", needsSession: "chat" },
    mascot_chat: { label: "AI助手聊天室 CSS" },
    story: { label: "剧情模式 CSS", needsSession: "story" },
    music: { label: "音乐 CSS", storageKey: "music-custom-css" },
    calendar: { label: "日历 CSS", storageKey: "calendar-custom-css" },
};

async function handleListCssLocations(): Promise<ToolResult> {
    const { kvGet } = await import("./kv-db");
    const { getMascotSettingsSnapshot } = await import("./mascot-settings");
    const lines: string[] = [];
    for (const [key, info] of Object.entries(CSS_LOCATION_LABELS)) {
        let status = "—";
        if (key === "mascot_chat") {
            status = getMascotSettingsSnapshot().chatCustomCSS ? "已设置" : "空";
        } else if (info.storageKey) {
            const has = !!kvGet(info.storageKey);
            status = has ? "已设置" : "空";
        } else {
            status = "需在对应会话中查看";
        }
        lines.push(`· ${key} — ${info.label}：${status}`);
    }
    return { name: "列出CSS位置", success: true, data: lines.join("\n") };
}

/** 根据用户传入的 sessionName 或当前页面 context 解析出 chat session id。
 *  返回 { sessionId, displayName } 或 { error, choices } */
async function resolveChatSession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadChatSessions } = await import("./chat-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadChatSessions();
    if (sessions.length === 0) return { error: "还没有任何聊天会话，先和角色发起聊天再来改 CSS" };
    const chars = loadCharacters();
    const charNameById = new Map(chars.map((c) => [c.id, c.name || ""]));

    const buildDisplayName = (s: typeof sessions[number]): string => {
        if (s.isGroup) return s.groupName || "群聊";
        return s.alias || charNameById.get(s.contactId) || s.contactId;
    };

    if (sessionName) {
        const lowered = sessionName.toLowerCase();
        const matched = sessions.find((s) => {
            const display = buildDisplayName(s).toLowerCase();
            return display === lowered || display.includes(lowered);
        });
        if (matched) return { sessionId: matched.id, displayName: buildDisplayName(matched) };
        const choices = sessions.map((s) => buildDisplayName(s));
        return { error: `找不到匹配「${sessionName}」的聊天会话`, choices };
    }

    // 没传 sessionName：优先用当前页面的 sessionId
    const ctxSessionId = ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    // 没法定位 → 列出选项
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "请用 sessionName 指定要操作哪个聊天会话", choices };
}

async function resolveStorySession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadStorySessions } = await import("./story-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadStorySessions();
    if (sessions.length === 0) return { error: "还没有任何剧情会话" };
    const chars = loadCharacters();
    const charNameById = new Map(chars.map((c) => [c.id, c.name || ""]));

    const buildDisplayName = (s: typeof sessions[number]): string => {
        return s.title || charNameById.get((s as Record<string, unknown>).characterId as string || "") || s.id;
    };

    if (sessionName) {
        const lowered = sessionName.toLowerCase();
        const matched = sessions.find((s) => buildDisplayName(s).toLowerCase().includes(lowered));
        if (matched) return { sessionId: matched.id, displayName: buildDisplayName(matched) };
        const choices = sessions.map((s) => buildDisplayName(s));
        return { error: `找不到匹配「${sessionName}」的剧情会话`, choices };
    }

    const ctxSessionId = ctx.pageContext.fields.storySessionId || ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "请用 sessionName 指定要操作哪个剧情会话", choices };
}

async function readCssAt(location: string, ctx: MascotToolContext, sessionName?: string): Promise<{ css: string; sessionId?: string; displayName?: string; note?: string; choices?: string[] }> {
    const { kvGet } = await import("./kv-db");
    if (location === "chat_app") return { css: kvGet("chat-app-custom-css") || "" };
    if (location === "mascot_chat") {
        const { getMascotSettingsSnapshot } = await import("./mascot-settings");
        const settings = getMascotSettingsSnapshot();
        return { css: settings.chatCustomCSS || "", displayName: settings.nickname || "AI助手" };
    }
    if (location === "music") return { css: kvGet("music-custom-css") || "" };
    if (location === "calendar") return { css: kvGet("calendar-custom-css") || "" };
    if (location === "chat_session") {
        const resolved = await resolveChatSession(sessionName, ctx);
        if ("error" in resolved) return { css: "", note: resolved.error, choices: resolved.choices };
        try {
            const { loadChatSessions } = await import("./chat-storage");
            const session = loadChatSessions().find((s) => s.id === resolved.sessionId);
            return { css: (session as Record<string, unknown>)?.customCSS as string || "", sessionId: resolved.sessionId, displayName: resolved.displayName };
        } catch { return { css: "", sessionId: resolved.sessionId, displayName: resolved.displayName }; }
    }
    if (location === "story") {
        const resolved = await resolveStorySession(sessionName, ctx);
        if ("error" in resolved) return { css: "", note: resolved.error, choices: resolved.choices };
        try {
            const { loadStorySessions } = await import("./story-storage");
            const session = loadStorySessions().find((s) => s.id === resolved.sessionId);
            return { css: (session as Record<string, unknown>)?.customCSS as string || "", sessionId: resolved.sessionId, displayName: resolved.displayName };
        } catch { return { css: "", sessionId: resolved.sessionId, displayName: resolved.displayName }; }
    }
    throw new Error(`未知 CSS 位置：${location}`);
}

async function handleReadCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location) return await handleListCssLocations();
    if (!CSS_LOCATION_LABELS[location]) return { name: "读取CSS", success: false, error: `未知位置：${location}` };

    // 对 chat_session / story：sessionName 未传 + 当前页面也没打开对应会话 → 改为"发现模式"，返回会话列表（成功状态）
    if ((location === "chat_session" || location === "story") && !sessionName) {
        const ctxSessionId = location === "chat_session"
            ? ctx.pageContext.fields.sessionId
            : (ctx.pageContext.fields.storySessionId || ctx.pageContext.fields.sessionId);
        if (!ctxSessionId) {
            const resolved = location === "chat_session"
                ? await resolveChatSession(undefined, ctx)
                : await resolveStorySession(undefined, ctx);
            if ("error" in resolved && resolved.choices) {
                const parts = [
                    `位置：${location}（${CSS_LOCATION_LABELS[location].label}）`,
                    `当前没指定会话，下面是所有可改的会话：`,
                    ...resolved.choices.map((c) => `· ${c}`),
                    "",
                    `请向用户确认想改哪一个，然后用 sessionName 参数重新调用本工具读取。`,
                ];
                return { name: "读取CSS", success: true, data: parts.join("\n") };
            }
            if ("error" in resolved) {
                return { name: "读取CSS", success: false, error: resolved.error };
            }
        }
    }

    const result = await readCssAt(location, ctx, sessionName);
    // 传了 sessionName 但找不到匹配 → 真正的错误
    if (result.note && result.choices) {
        return {
            name: "读取CSS",
            success: false,
            error: `${result.note}。可选会话：${result.choices.map((c) => `「${c}」`).join("、")}`,
        };
    }

    const cssExamples = await import("./css-examples");
    const refMap: Record<string, string> = {
        chat_app: cssExamples.CHAT_APP_CSS_EXAMPLE,
        chat_session: cssExamples.CHAT_SESSION_CSS_EXAMPLE,
        mascot_chat: cssExamples.CHAT_SESSION_CSS_EXAMPLE,
        story: cssExamples.STORY_CSS_EXAMPLE,
        music: cssExamples.MUSIC_CSS_EXAMPLE,
        calendar: cssExamples.CALENDAR_CSS_EXAMPLE,
    };
    const reference = refMap[location] || "";
    const parts: string[] = [];
    parts.push(`位置：${location}（${CSS_LOCATION_LABELS[location].label}）`);
    if (result.displayName) parts.push(`会话：${result.displayName}`);
    if (result.note) parts.push(`注意：${result.note}`);
    parts.push(`\n=== 当前 CSS ===\n${result.css || "(空)"}`);
    parts.push(`\n=== 可用选择器和变量参考 ===\n${reference}`);
    return { name: "读取CSS", success: true, data: parts.join("\n") };
}

async function writeCssAt(location: string, css: string, ctx: MascotToolContext, sessionName?: string): Promise<{ displayName?: string }> {
    const { kvSet, kvRemove } = await import("./kv-db");
    const trimmed = css.trim();
    if (location === "chat_app") {
        if (trimmed) kvSet("chat-app-custom-css", trimmed); else kvRemove("chat-app-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-app-css-updated"));
        return {};
    }
    if (location === "mascot_chat") {
        const { getMascotSettingsSnapshot, updateMascotSettings } = await import("./mascot-settings");
        updateMascotSettings({ chatCustomCSS: trimmed });
        return { displayName: getMascotSettingsSnapshot().nickname || "AI助手" };
    }
    if (location === "music") {
        if (trimmed) kvSet("music-custom-css", trimmed); else kvRemove("music-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("music-css-change", { detail: trimmed }));
        return {};
    }
    if (location === "calendar") {
        if (trimmed) kvSet("calendar-custom-css", trimmed); else kvRemove("calendar-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("calendar-css-updated", { detail: trimmed }));
        return {};
    }
    if (location === "chat_session") {
        const resolved = await resolveChatSession(sessionName, ctx);
        if ("error" in resolved) {
            const err = new Error(`${resolved.error}${resolved.choices ? `。可选会话：${resolved.choices.map((c) => `「${c}」`).join("、")}` : ""}`);
            throw err;
        }
        const { loadChatSessions, saveChatSessions } = await import("./chat-storage");
        const sessions = loadChatSessions();
        const idx = sessions.findIndex((s) => s.id === resolved.sessionId);
        if (idx < 0) throw new Error("找不到当前会话");
        (sessions[idx] as Record<string, unknown>).customCSS = trimmed;
        saveChatSessions(sessions);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    if (location === "story") {
        const resolved = await resolveStorySession(sessionName, ctx);
        if ("error" in resolved) {
            const err = new Error(`${resolved.error}${resolved.choices ? `。可选会话：${resolved.choices.map((c) => `「${c}」`).join("、")}` : ""}`);
            throw err;
        }
        const { updateStorySession } = await import("./story-storage");
        updateStorySession(resolved.sessionId, { customCSS: trimmed });
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("story-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    throw new Error(`未知 CSS 位置：${location}`);
}

async function handleOverwriteCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const css = args.css as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "覆写CSS", success: false, error: `未知位置：${location}` };
    const result = await writeCssAt(location, css, ctx, sessionName);
    return { name: "覆写CSS", success: true, data: `已覆写 ${location}${result.displayName ? `（${result.displayName}）` : ""} 的 CSS，共 ${css.length} 字符` };
}

async function handleClearCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "清除CSS", success: false, error: `未知位置：${location}` };
    const result = await writeCssAt(location, "", ctx, sessionName);
    return { name: "清除CSS", success: true, data: `已清除 ${location}${result.displayName ? `（${result.displayName}）` : ""} 的 CSS` };
}

// ── Character Handlers ──────────────────────────

async function handleReadCharacter(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const name = args.name as string | undefined;
    if (!name) {
        if (chars.length === 0) return { name: "读取角色", success: true, data: "（没有角色）" };
        const lines = chars.map((c) => `· ${c.name || "(未命名)"} [id: ${c.id}]`);
        return { name: "读取角色", success: true, data: `共 ${chars.length} 个角色：\n${lines.join("\n")}` };
    }
    const char = chars.find((c) => c.name === name);
    if (!char) return { name: "读取角色", success: false, error: `找不到角色：${name}` };
    const parts: string[] = [];
    parts.push(`id: ${char.id}`);
    parts.push(`name: ${char.name || ""}`);
    parts.push(`personality: ${char.personality || ""}`);
    parts.push(`persona:\n${char.persona || ""}`);
    return { name: "读取角色", success: true, data: parts.join("\n") };
}

async function handleCreateCharacter(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    if (chars.find((c) => c.name === args.name)) return { name: "创建角色", success: false, error: "已存在同名角色" };
    const now = new Date().toISOString();
    const newChar = {
        id: `char_${Date.now()}`,
        name: args.name as string,
        avatar: null,
        persona: args.persona as string,
        personality: args.personality as string,
        createdAt: now,
        updatedAt: now,
    };
    chars.push(newChar as typeof chars[number]);
    saveCharacters(chars);
    return { name: "创建角色", success: true, data: `已创建角色 ${newChar.name} (${newChar.id})` };
}

async function handleUpdateCharacterField(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const idx = chars.findIndex((c) => c.name === args.name);
    if (idx < 0) return { name: "更新角色字段", success: false, error: `找不到角色：${args.name}` };
    const field = args.field as string;
    const value = args.value as string;
    const char = { ...chars[idx] } as Record<string, unknown>;
    if (field === "name" || field === "persona" || field === "personality") {
        char[field] = value;
    } else {
        return { name: "更新角色字段", success: false, error: `不支持的字段：${field}` };
    }
    char.updatedAt = new Date().toISOString();
    chars[idx] = char as typeof chars[number];
    saveCharacters(chars);
    return { name: "更新角色字段", success: true, data: `已更新 ${args.name} 的 ${field}` };
}

// ── Worldbook Handlers ──────────────────────────

async function handleListWorldbooks(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const name = args.name as string | undefined;
    if (!name) {
        if (books.length === 0) return { name: "列出世界书", success: true, data: "（没有世界书）" };
        const lines = books.map((b) => `· ${b.name}（${b.entries?.length || 0} 条词条）`);
        return { name: "列出世界书", success: true, data: `共 ${books.length} 个世界书：\n${lines.join("\n")}` };
    }
    const book = books.find((b) => b.name === name);
    if (!book) return { name: "列出世界书", success: false, error: `找不到世界书：${name}` };
    if (!book.entries || book.entries.length === 0) return { name: "列出世界书", success: true, data: `世界书 ${name} 暂无词条` };
    const lines = book.entries.map((e) => `· [${e.uid}] ${e.comment || "(无备注)"} — keys: ${e.key || "(无)"} ${e.constant ? "[常驻]" : ""} ${e.position === 0 ? "(前置)" : "(后置)"}`);
    return { name: "列出世界书", success: true, data: `世界书 ${name} 共 ${book.entries.length} 条词条：\n${lines.join("\n")}` };
}

async function handleReadWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const book = books.find((b) => b.name === args.worldbook);
    if (!book) return { name: "读取词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const entry = book.entries?.find((e) => e.comment === args.entryComment || e.uid === args.entryComment);
    if (!entry) return { name: "读取词条", success: false, error: `找不到词条：${args.entryComment}` };
    const parts: string[] = [];
    parts.push(`uid: ${entry.uid}`);
    parts.push(`comment: ${entry.comment || ""}`);
    parts.push(`key: ${entry.key || ""}`);
    parts.push(`constant: ${entry.constant}`);
    parts.push(`position: ${entry.position}`);
    parts.push(`content:\n${entry.content || ""}`);
    return { name: "读取词条", success: true, data: parts.join("\n") };
}

async function handleCreateWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks, createWorldBook } = await import("./settings-storage");
    const books = loadWorldBooks();
    let bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) {
        const newBook = createWorldBook(args.worldbook as string);
        books.push(newBook);
        bookIdx = books.length - 1;
    }
    const book = { ...books[bookIdx] };
    const newEntry = {
        uid: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        key: args.key as string,
        content: args.content as string,
        comment: args.comment as string,
        use_regex: false,
        disable: false,
        constant: (args.constant as boolean) ?? false,
        position: numberOption(args.position, 0),
        insertion_order: 100,
        role: 0,
    };
    book.entries = [...(book.entries || []), newEntry];
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "创建词条", success: true, data: `已在《${args.worldbook}》创建词条「${args.comment}」(uid: ${newEntry.uid})` };
}

async function handleUpdateWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "更新词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const entries = [...(book.entries || [])];
    const entryIdx = entries.findIndex((e) => e.uid === args.entryUid);
    if (entryIdx < 0) return { name: "更新词条", success: false, error: `找不到词条 uid：${args.entryUid}` };
    const entry = { ...entries[entryIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "key") entry.key = value;
    else if (field === "content") entry.content = value;
    else if (field === "comment") entry.comment = value;
    else if (field === "constant") entry.constant = value === "true";
    else if (field === "position") entry.position = parseInt(value, 10) || 0;
    else return { name: "更新词条", success: false, error: `不支持的字段：${field}` };
    entries[entryIdx] = entry;
    book.entries = entries;
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "更新词条", success: true, data: `已更新词条 ${args.entryUid} 的 ${field}` };
}

async function handleDeleteWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "删除词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const before = book.entries?.length || 0;
    book.entries = (book.entries || []).filter((e) => e.uid !== args.entryUid);
    if (book.entries.length === before) return { name: "删除词条", success: false, error: `找不到词条 uid：${args.entryUid}` };
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "删除词条", success: true, data: `已删除词条 ${args.entryUid}` };
}

// ── Preset Handlers ────────────────────────────

const MARKER_NAMES: Record<string, string> = {
    "◇ 用户人设": "personaDescription", "◇ 世界书（角色前）": "worldInfoBefore",
    "◇ 角色描述": "charDescription", "◇ 角色性格": "charPersonality",
    "◇ 角色关系": "characterRelations",
    "◇ 世界书（角色后）": "worldInfoAfter", "◇ 日程": "calendarSchedule",
    "◇ 核心记忆": "memoryCore", "◇ 长期记忆": "memoryLongTerm", "◇ [短期记忆]": "shortTermMemory",
};

async function loadPresetStorage() {
    const storage = await import("./settings-storage");
    await storage.ensureSettingsStorageHydrated();
    return storage;
}

function createPresetPromptIdentifier(name: string, requested: unknown, existingIds: Set<string>): string {
    const requestedId = typeof requested === "string" ? requested.trim() : "";
    const markerId = name.startsWith("◇ ") ? MARKER_NAMES[name] : "";
    const generatedId = name.replace(/[^\w一-鿿]/g, "").slice(0, 30);
    const base = requestedId || markerId || generatedId || `prompt_${Date.now()}`;
    if (!existingIds.has(base)) return base;

    let counter = 2;
    let candidate = `${base}_${counter}`;
    while (existingIds.has(candidate)) {
        counter += 1;
        candidate = `${base}_${counter}`;
    }
    return candidate;
}

function rebuildPresetPromptOrder(prompts: Prompt[], previousOrder: Array<{ identifier: string; enabled: boolean }> | undefined) {
    const previousEnabled = new Map((previousOrder || []).map((entry) => [entry.identifier, entry.enabled]));
    return prompts
        .filter((prompt) => prompt.identifier)
        .map((prompt) => ({
            identifier: prompt.identifier,
            enabled: previousEnabled.get(prompt.identifier) ?? prompt.enabled,
        }));
}

async function handleListPresets(): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.length === 0) return { name: "列出预设", success: true, data: "（没有预设）" };
    const lines = presets.map((p) => {
        const featureTag = (p.prompts || []).some((x) => (x as Record<string, unknown>).featureTag);
        return `· ${p.name}${p.builtIn ? "（内置）" : ""} — ${featureTag ? "通用型" : "剧情型"} [id: ${p.id}]`;
    });
    return { name: "列出预设", success: true, data: `共 ${presets.length} 个预设：\n${lines.join("\n")}` };
}

async function handleReadPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.name === args.name || p.name.includes(args.name as string));
    if (!preset) return { name: "读取预设", success: false, error: `找不到预设：${args.name}` };
    const parts: string[] = [];
    parts.push(`id: ${preset.id}`);
    parts.push(`name: ${preset.name}`);
    parts.push(`description: ${preset.description || ""}`);
    parts.push(`builtIn: ${preset.builtIn || false}`);
    parts.push(`prompts (${preset.prompts?.length || 0} 条，仅显示摘要；查看完整内容请用「读取预设条目」)：`);
    (preset.prompts || []).forEach((p, i) => {
        const segs: string[] = [`[${i}] ${p.name || p.identifier || "(无名)"}`];
        if (p.marker) segs.push("(marker)");
        const tags = (p as Record<string, unknown>).tags;
        const legacyTag = (p as Record<string, unknown>).featureTag;
        if (Array.isArray(tags) && tags.length > 0) {
            segs.push(`tags=[${tags.join(",")}]`);
        } else if (legacyTag) {
            segs.push(`tag=${legacyTag}`);
        }
        if (p.role && p.role !== "system") segs.push(`role=${p.role}`);
        // 摘要：仅前 100 字
        if (p.content) {
            const snippet = p.content.replace(/\s+/g, " ").slice(0, 100);
            segs.push(`— ${snippet}${p.content.length > 100 ? "..." : ""}`);
        } else if (!p.marker) {
            segs.push("(无内容)");
        }
        parts.push(segs.join(" "));
    });
    return { name: "读取预设", success: true, data: parts.join("\n") };
}

async function handleReadPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.id === args.presetId);
    if (!preset) return { name: "读取预设条目", success: false, error: `找不到预设 id：${args.presetId}` };
    const idx = args.promptIndex as number;
    const p = preset.prompts?.[idx];
    if (!p) return { name: "读取预设条目", success: false, error: `promptIndex ${idx} 越界（共 ${preset.prompts?.length || 0} 条）` };
    const parts: string[] = [];
    parts.push(`promptIndex: ${idx}`);
    parts.push(`identifier: ${p.identifier}`);
    parts.push(`name: ${p.name || ""}`);
    parts.push(`role: ${p.role || "system"}`);
    parts.push(`marker: ${p.marker || false}`);
    const tags = (p as Record<string, unknown>).tags;
    const legacyTag = (p as Record<string, unknown>).featureTag;
    if (Array.isArray(tags) && tags.length > 0) {
        parts.push(`tags: [${tags.join(", ")}]`);
    } else if (legacyTag) {
        parts.push(`featureTag: ${legacyTag}（旧字段）`);
    }
    parts.push(`content:\n${p.content || "(空)"}`);
    return { name: "读取预设条目", success: true, data: parts.join("\n") };
}

async function handleCreateStoryPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync, createPreset } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "创建剧情预设", success: false, error: "已存在同名预设" };

    const promptInputs = (args.prompts as Array<Record<string, unknown>>) || [];
    // 用现成的 createPreset 拿带默认采样参数（temperature/top_p 等）的骨架，避免缺字段
    const newPreset = createPreset(args.name as string);
    newPreset.description = (args.description as string) || "";

    for (let i = 0; i < promptInputs.length; i++) {
        const input = promptInputs[i];
        const name = input.name as string;
        const isMarker = name.startsWith("◇ ");
        const identifier = isMarker && MARKER_NAMES[name]
            ? MARKER_NAMES[name]
            : (input.identifier as string) || name.replace(/[^\w一-鿿]/g, "").slice(0, 30) || `prompt_${i}`;
        const prompt = {
            identifier,
            name,
            role: (input.role as "system" | "user" | "assistant") || "system",
            content: isMarker ? "" : (input.content as string) || "",
            injection_position: 0,
            injection_depth: isMarker ? 0 : 4,
            enabled: true,
            marker: isMarker,
            system_prompt: false,
            forbid_overrides: false,
        };
        newPreset.prompts.push(prompt);
    }
    const firstSysIdx = newPreset.prompts.findIndex((p) => !p.marker && p.role === "system" && p.content);
    newPreset.prompts.forEach((p, i) => { p.system_prompt = i === firstSysIdx; });
    newPreset.prompt_order = newPreset.prompts
        .filter((p) => p.identifier)
        .map((p) => ({ identifier: p.identifier, enabled: true }));

    presets.push(newPreset);
    await savePresetsAsync(presets);
    return { name: "创建剧情预设", success: true, data: `已创建剧情预设 ${newPreset.name} (${newPreset.id})，含 ${newPreset.prompts.length} 条 prompt` };
}

async function handleCloneBuiltinPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "克隆内置预设", success: false, error: "已存在同名预设" };

    const builtIn = presets.find((p) => p.builtIn);
    if (!builtIn) return { name: "克隆内置预设", success: false, error: "系统里没有内置预设，无法克隆" };

    const copy = JSON.parse(JSON.stringify(builtIn)) as typeof builtIn;
    copy.id = `preset_${Date.now()}`;
    copy.name = args.name as string;
    copy.description = (args.description as string) || "";
    copy.builtIn = false;
    (copy as Record<string, unknown>).builtInVersion = undefined;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    presets.push(copy);
    await savePresetsAsync(presets);
    return { name: "克隆内置预设", success: true, data: `已克隆内置预设为「${copy.name}」(${copy.id})，含 ${copy.prompts.length} 条 prompt。后续按需用「更新预设条目」改` };
}

async function handleDuplicatePreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const source = presets.find((p) => p.name === args.sourceName || p.name.includes(args.sourceName as string));
    if (!source) return { name: "复制预设", success: false, error: `找不到源预设：${args.sourceName}` };
    const newName = args.newName as string;
    if (presets.find((p) => p.name === newName)) return { name: "复制预设", success: false, error: `已存在同名预设：${newName}` };
    const copy = JSON.parse(JSON.stringify(source)) as typeof source;
    copy.id = `preset_${Date.now()}`;
    copy.name = newName;
    if (args.newDescription !== undefined) copy.description = args.newDescription as string;
    copy.builtIn = false;
    (copy as Record<string, unknown>).builtInVersion = undefined;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    presets.push(copy);
    await savePresetsAsync(presets);
    return { name: "复制预设", success: true, data: `已基于「${source.name}」创建副本「${copy.name}」(${copy.id})，含 ${copy.prompts.length} 条 prompt` };
}

async function handleAddPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "添加预设条目", success: false, error: `找不到预设 id：${args.presetId}` };

    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { name: "添加预设条目", success: false, error: "name 不能为空" };

    const preset = { ...presets[idx], prompts: [...(presets[idx].prompts || [])] };
    const existingIds = new Set(preset.prompts.map((prompt) => prompt.identifier).filter(Boolean));
    const isMarker = name.startsWith("◇ ");
    const content = isMarker ? "" : (typeof args.content === "string" ? args.content : "");
    const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
    const prompt: Prompt = {
        identifier: createPresetPromptIdentifier(name, args.identifier, existingIds),
        name,
        role: (args.role as "system" | "user" | "assistant") || "system",
        content,
        injection_position: 0,
        injection_depth: isMarker ? 0 : 4,
        enabled,
        marker: isMarker,
        system_prompt: false,
        forbid_overrides: false,
    };

    if (Array.isArray(args.tags)) {
        const tags = args.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim());
        if (tags.length > 0) prompt.tags = tags;
    }

    const insertAfterIndex = typeof args.insertAfterIndex === "number" && Number.isFinite(args.insertAfterIndex)
        ? Math.trunc(args.insertAfterIndex)
        : null;
    if (insertAfterIndex !== null && insertAfterIndex >= 0 && insertAfterIndex < preset.prompts.length) {
        preset.prompts.splice(insertAfterIndex + 1, 0, prompt);
    } else {
        preset.prompts.push(prompt);
    }

    preset.prompt_order = rebuildPresetPromptOrder(preset.prompts, preset.prompt_order);
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);

    const promptIndex = preset.prompts.findIndex((item) => item.identifier === prompt.identifier);
    return { name: "添加预设条目", success: true, data: `已添加 prompt[${promptIndex}]「${prompt.name}」(${prompt.identifier})` };
}

async function handleUpdatePresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设条目", success: false, error: `找不到预设 id：${args.presetId}` };
    const preset = { ...presets[idx], prompts: [...presets[idx].prompts] };
    const promptIdx = args.promptIndex as number;
    if (promptIdx < 0 || promptIdx >= preset.prompts.length) return { name: "更新预设条目", success: false, error: `promptIndex 越界（共 ${preset.prompts.length} 条）` };
    const prompt = { ...preset.prompts[promptIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "name") prompt.name = value;
    else if (field === "role") prompt.role = value as "system" | "user" | "assistant";
    else if (field === "content") prompt.content = value;
    else if (field === "identifier") prompt.identifier = value;
    else return { name: "更新预设条目", success: false, error: `不支持的字段：${field}` };
    preset.prompts[promptIdx] = prompt;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设条目", success: true, data: `已更新 prompt[${promptIdx}] 的 ${field}` };
}

async function handleUpdatePresetInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设信息", success: false, error: `找不到预设 id：${args.presetId}` };
    const preset = { ...presets[idx] };
    if (args.name !== undefined) preset.name = args.name as string;
    if (args.description !== undefined) preset.description = args.description as string;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设信息", success: true, data: `已更新预设 ${preset.name}` };
}

// ── Regex Handlers ────────────────────────────

async function handleListRegexGroups(): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    if (groups.length === 0) return { name: "列出正则组", success: true, data: "（没有正则组）" };
    const lines = groups.map((g) => `· ${g.name}（${g.rules?.length || 0} 条规则）[id: ${g.id}]`);
    return { name: "列出正则组", success: true, data: `共 ${groups.length} 个正则组：\n${lines.join("\n")}` };
}

async function handleReadRegexGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const group = groups.find((g) => g.name === args.name || g.name.includes(args.name as string));
    if (!group) return { name: "读取正则组", success: false, error: `找不到正则组：${args.name}` };
    const lines: string[] = [`id: ${group.id}`, `name: ${group.name}`, `rules:`];
    (group.rules || []).forEach((r) => {
        lines.push(`  [${r.id}] ${r.disabled ? "❌" : "✅"} ${r.scriptName}`);
        lines.push(`    find: ${r.findRegex}`);
        lines.push(`    replace: ${r.replaceString}`);
        lines.push(`    tags: ${JSON.stringify(r.tags || ["chat", "text"])}`);
        lines.push(`    placement: ${JSON.stringify(r.placement)}`);
    });
    return { name: "读取正则组", success: true, data: lines.join("\n") };
}

function normalizeMascotRegexRuleTags(tags: unknown): string[] {
    const values = Array.isArray(tags)
        ? tags.map((tag) => String(tag).trim()).filter(Boolean)
        : typeof tags === "string"
            ? tags.split(/[\s,，、/]+/).map((tag) => tag.trim()).filter(Boolean)
            : [];
    const has = (value: string) => values.includes(value);

    if (has("group_chat") || has("群聊")) return ["group_chat", "text"];
    if (has("story") || has("剧情") || has("故事") || has("故事模式")) return ["story"];
    if (has("offline") || has("线下")) return ["offline"];
    return ["chat", "text"];
}

function normalizeRule(r: Record<string, unknown>): Record<string, unknown> {
    return {
        id: r.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        scriptName: r.scriptName || "",
        findRegex: r.findRegex || "",
        replaceString: r.replaceString || "",
        tags: normalizeMascotRegexRuleTags(r.tags),
        disabled: r.disabled ?? false,
        placement: r.placement || [2],
        markdownOnly: r.markdownOnly ?? false,
        promptOnly: r.promptOnly ?? false,
        substituteRegex: numberOption(r.substituteRegex, 0),
        runOnEdit: r.runOnEdit ?? false,
        trimStrings: r.trimStrings || [],
        minDepth: r.minDepth,
        maxDepth: r.maxDepth,
    };
}

async function handleCreateRegexGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes, createRegexGroup } = await import("./settings-storage");
    const groups = loadRegexes();
    if (groups.find((g) => g.name === args.name)) return { name: "创建正则组", success: false, error: "已存在同名正则组" };
    const newGroup = createRegexGroup(args.name as string);
    const rules = (args.rules as Array<Record<string, unknown>>) || [];
    newGroup.rules = rules.map(normalizeRule) as typeof newGroup.rules;
    groups.push(newGroup);
    saveRegexes(groups);
    return { name: "创建正则组", success: true, data: `已创建正则组 ${newGroup.name} (${newGroup.id})，含 ${newGroup.rules.length} 条规则` };
}

async function handleAddRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "添加正则规则", success: false, error: `找不到正则组：${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const newRule = normalizeRule(args.rule as Record<string, unknown>);
    group.rules.push(newRule as typeof group.rules[number]);
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "添加正则规则", success: true, data: `已向 ${args.groupName} 添加规则 ${newRule.id}` };
}

async function handleUpdateRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "更新正则规则", success: false, error: `找不到正则组：${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const ruleIdx = group.rules.findIndex((r) => r.id === args.ruleId);
    if (ruleIdx < 0) return { name: "更新正则规则", success: false, error: `找不到规则 id：${args.ruleId}` };
    const updates = { ...(args.updates as Record<string, unknown>) };
    if ("substituteRegex" in updates) updates.substituteRegex = numberOption(updates.substituteRegex, 0);
    if ("tags" in updates) updates.tags = normalizeMascotRegexRuleTags(updates.tags);
    group.rules[ruleIdx] = { ...group.rules[ruleIdx], ...updates } as typeof group.rules[number];
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "更新正则规则", success: true, data: `已更新规则 ${args.ruleId}` };
}

// ── 桌面组件 Handlers ─────────────────────────

const DIY_HTML_MAX_LENGTH = 300_000;

async function widgetToolDeps() {
    const storage = await import("./widget-storage");
    const types = await import("./widget-types");
    const layoutStore = await import("./desktop-layout-storage");
    const { kvGet } = await import("./kv-db");
    const events = await import("./mascot-events");
    return { storage, types, layoutStore, kvGet, events };
}

type WidgetToolDeps = Awaited<ReturnType<typeof widgetToolDeps>>;

function readDesktopIconLayout(deps: WidgetToolDeps) {
    try {
        const raw = deps.kvGet(deps.layoutStore.ICON_LAYOUT_STORAGE_KEY);
        return deps.layoutStore.normalizeDesktopIconLayout(raw ? JSON.parse(raw) : null);
    } catch {
        return deps.layoutStore.normalizeDesktopIconLayout(null);
    }
}

function desktopPageIcons(deps: WidgetToolDeps, page: number) {
    const layout = readDesktopIconLayout(deps);
    const pageKey = deps.layoutStore.getDesktopPageKey(page);
    return layout[pageKey] ?? [];
}

/** 在指定页为 size 找落点：给了 row/col 则校验，否则扫第一个空位 */
function resolveWidgetSpot(
    deps: WidgetToolDeps,
    size: string,
    page: number,
    row?: number,
    col?: number,
): { ok: true; row: number; col: number } | { ok: false; error: string } {
    const { GRID_ROWS, GRID_COLS } = deps.types;
    const widgets = deps.storage.loadWidgets();
    const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, page), widgets, page);
    const sizeKey = size as keyof typeof deps.types.WIDGET_SIZE_CELLS;
    if (typeof row === "number" && typeof col === "number") {
        if (!deps.storage.canPlaceWidget(grid, sizeKey, row, col)) {
            return { ok: false, error: `第 ${page} 页 行${row}列${col} 放不下 ${size}（越界或被占用）。可用「查看桌面布局」找空位。` };
        }
        return { ok: true, row, col };
    }
    for (let r = 1; r <= GRID_ROWS; r++) {
        for (let c = 1; c <= GRID_COLS; c++) {
            if (deps.storage.canPlaceWidget(grid, sizeKey, r, c)) return { ok: true, row: r, col: c };
        }
    }
    return { ok: false, error: `第 ${page} 页没有能放下 ${size} 的空位。可换一页，或先移除/挪动一些内容。` };
}

function diyTemplateDisplay(t: { id: string; name: string; size: string; mode: string }): string {
    return `· [DIY] ${t.name}（${t.size}，${t.mode === "code" ? "代码" : "图片"}模式）[templateId: ${t.id}]`;
}

async function handleListWidgetCatalog(): Promise<ToolResult> {
    const deps = await widgetToolDeps();
    const lines: string[] = [];
    lines.push("内置组件（type → 名称/尺寸）：");
    for (const entry of deps.types.WIDGET_CATALOG) {
        lines.push(`· ${entry.type} — ${entry.name}（${entry.size}${entry.track === "freestyle" ? "，自由艺术" : ""}）`);
    }
    const templates = deps.storage.loadDIYTemplates();
    lines.push("");
    if (templates.length === 0) {
        lines.push("DIY 组件模板：（暂无）");
    } else {
        lines.push("DIY 组件模板：");
        for (const t of templates) lines.push(diyTemplateDisplay(t));
    }
    return { name: "列出组件目录", success: true, data: lines.join("\n") };
}

async function handleReadDesktopLayout(args: Record<string, unknown>): Promise<ToolResult> {
    const deps = await widgetToolDeps();
    const page = numberOption(args.page, 1);
    if (page < 1 || page > 9) return { name: "查看桌面布局", success: false, error: `页码不合法：${page}` };
    const widgets = deps.storage.loadWidgets();
    const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, page), widgets, page);
    const lines: string[] = [];
    lines.push(`第 ${page} 页 6x4 占用（W=组件 I=图标 ·=空）：`);
    grid.forEach((rowCells, r) => {
        const cells = rowCells.map((cell) => (cell === null ? "·" : cell.startsWith("widget:") ? "W" : "I"));
        lines.push(`行${r + 1}  ${cells.join(" ")}`);
    });
    const pageWidgets = widgets.filter((w) => w.page === page);
    lines.push("");
    if (pageWidgets.length === 0) {
        lines.push("本页组件实例：（无）");
    } else {
        const templates = deps.storage.loadDIYTemplates();
        lines.push("本页组件实例：");
        for (const w of pageWidgets) {
            const diy = templates.find((t) => t.id === w.type);
            const builtin = deps.types.WIDGET_CATALOG.find((e) => e.type === w.type);
            const label = diy ? `${diy.name}（DIY）` : builtin ? builtin.name : w.type;
            lines.push(`· ${label} ${w.size} @行${w.row}列${w.col} [实例 id: ${w.id}]`);
        }
    }
    const otherPages = Array.from(new Set(widgets.map((w) => w.page))).filter((p) => p !== page).sort();
    if (otherPages.length > 0) lines.push(`（其他页也有组件：第 ${otherPages.join("、")} 页）`);
    return { name: "查看桌面布局", success: true, data: lines.join("\n") };
}

async function handleCreateDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const size = typeof args.size === "string" ? args.size : "";
    const htmlString = typeof args.htmlString === "string" ? args.htmlString : "";
    if (!name) return { name: "创建DIY组件", success: false, error: "name 不能为空" };
    if (!WIDGET_SIZE_ENUM.includes(size)) return { name: "创建DIY组件", success: false, error: `尺寸不合法：${size}。可用：${WIDGET_SIZE_ENUM.join("/")}` };
    if (!htmlString.trim()) return { name: "创建DIY组件", success: false, error: "htmlString 不能为空" };
    if (htmlString.length > DIY_HTML_MAX_LENGTH) return { name: "创建DIY组件", success: false, error: `htmlString 过长（${htmlString.length} 字符，上限 ${DIY_HTML_MAX_LENGTH}）` };

    const deps = await widgetToolDeps();
    const templates = deps.storage.loadDIYTemplates();
    const id = `diy-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    templates.push({ id, name, size: size as never, mode: "code", htmlString });
    deps.storage.saveDIYTemplates(templates);

    const autoPlace = args.autoPlace !== false;
    let placement = "未上桌（autoPlace=false）。之后可用「摆放组件」摆上桌面。";
    if (autoPlace) {
        const page = numberOption(args.page, 1);
        const spot = resolveWidgetSpot(deps, size, page);
        if (spot.ok) {
            const widgets = deps.storage.placeWidget(deps.storage.loadWidgets(), {
                type: id, size: size as never, page, row: spot.row, col: spot.col,
            });
            deps.storage.saveWidgets(widgets);
            placement = `已自动摆到第 ${page} 页 行${spot.row}列${spot.col}，桌面已刷新。`;
        } else {
            placement = `模板已创建，但${spot.error}`;
        }
    }
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "创建DIY组件", success: true, data: `DIY 组件「${name}」已创建 [templateId: ${id}]。${placement}` };
}

async function handleUpdateDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const templateId = typeof args.templateId === "string" ? args.templateId : "";
    if (!templateId) return { name: "更新DIY组件", success: false, error: "缺少 templateId" };
    const deps = await widgetToolDeps();
    const templates = deps.storage.loadDIYTemplates();
    const idx = templates.findIndex((t) => t.id === templateId);
    if (idx < 0) return { name: "更新DIY组件", success: false, error: `找不到模板：${templateId}。用「列出组件目录」确认 id。` };

    const target = { ...templates[idx] };
    const changed: string[] = [];
    if (typeof args.name === "string" && args.name.trim()) { target.name = args.name.trim(); changed.push("名称"); }
    if (typeof args.htmlString === "string" && args.htmlString.trim()) {
        if (args.htmlString.length > DIY_HTML_MAX_LENGTH) return { name: "更新DIY组件", success: false, error: `htmlString 过长（上限 ${DIY_HTML_MAX_LENGTH}）` };
        target.htmlString = args.htmlString;
        changed.push("HTML");
    }
    const newSize = typeof args.size === "string" ? args.size : "";
    const sizeChanged = Boolean(newSize && newSize !== target.size);
    if (newSize && !WIDGET_SIZE_ENUM.includes(newSize)) return { name: "更新DIY组件", success: false, error: `尺寸不合法：${newSize}` };
    if (sizeChanged) { target.size = newSize as never; changed.push("尺寸"); }
    if (changed.length === 0) return { name: "更新DIY组件", success: false, error: "没有可更新的字段（name/size/htmlString 至少传一个）" };

    templates[idx] = target;
    deps.storage.saveDIYTemplates(templates);

    let instanceNote = "";
    if (sizeChanged) {
        const widgets = deps.storage.loadWidgets();
        const kept: typeof widgets = [];
        let dropped = 0;
        for (const w of widgets) {
            if (w.type !== templateId) { kept.push(w); continue; }
            const others = widgets.filter((o) => o.id !== w.id);
            const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, w.page), others, w.page);
            if (deps.storage.canPlaceWidget(grid, newSize as never, w.row, w.col)) {
                kept.push({ ...w, size: newSize as never });
            } else {
                dropped += 1;
            }
        }
        deps.storage.saveWidgets(kept);
        instanceNote = dropped > 0
            ? ` 有 ${dropped} 个桌面实例原位置放不下新尺寸，已移下桌面（模板还在，可用「摆放组件」重新摆）。`
            : " 桌面实例已按新尺寸原位更新。";
    }
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "更新DIY组件", success: true, data: `模板「${target.name}」已更新（${changed.join("/")}），桌面实时生效。${instanceNote}` };
}

async function handlePreviewDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const templateId = typeof args.templateId === "string" ? args.templateId : "";
    if (!templateId) return { name: "预览DIY组件", success: false, error: "缺少 templateId" };
    const deps = await widgetToolDeps();
    const template = deps.storage.loadDIYTemplates().find((t) => t.id === templateId);
    if (!template) return { name: "预览DIY组件", success: false, error: `找不到模板：${templateId}` };
    if (template.mode !== "code" || !template.htmlString) return { name: "预览DIY组件", success: false, error: "该模板不是代码模式，暂不支持弹窗预览" };
    const handled = deps.events.requestDiyWidgetPreview({
        templateId: template.id,
        name: template.name,
        size: template.size,
        htmlString: template.htmlString,
    });
    if (!handled) return { name: "预览DIY组件", success: false, error: "预览弹窗当前不可用（桌宠界面未挂载）" };
    return { name: "预览DIY组件", success: true, data: `已弹出「${template.name}」的预览，用户可直接查看效果。` };
}

async function handlePlaceWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const type = typeof args.type === "string" ? args.type.trim() : "";
    if (!type) return { name: "摆放组件", success: false, error: "缺少 type" };
    const deps = await widgetToolDeps();

    let size: string | null = null;
    let label = type;
    if (type.startsWith("diy-")) {
        const template = deps.storage.loadDIYTemplates().find((t) => t.id === type);
        if (!template) return { name: "摆放组件", success: false, error: `找不到 DIY 模板：${type}` };
        size = template.size;
        label = template.name;
    } else {
        const entry = deps.types.WIDGET_CATALOG.find((e) => e.type === type);
        if (!entry) return { name: "摆放组件", success: false, error: `未知组件类型：${type}。用「列出组件目录」查看可用类型。` };
        size = entry.size;
        label = entry.name;
    }

    const page = numberOption(args.page, 1);
    const row = typeof args.row === "number" ? args.row : undefined;
    const col = typeof args.col === "number" ? args.col : undefined;
    const spot = resolveWidgetSpot(deps, size, page, row, col);
    if (!spot.ok) return { name: "摆放组件", success: false, error: spot.error };

    const widgets = deps.storage.placeWidget(deps.storage.loadWidgets(), {
        type, size: size as never, page, row: spot.row, col: spot.col,
    });
    deps.storage.saveWidgets(widgets);
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "摆放组件", success: true, data: `「${label}」已摆到第 ${page} 页 行${spot.row}列${spot.col}，桌面已刷新。` };
}

async function handleRemoveDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const widgetId = typeof args.widgetId === "string" ? args.widgetId.trim() : "";
    const templateId = typeof args.templateId === "string" ? args.templateId.trim() : "";
    if (!widgetId && !templateId) return { name: "移除DIY组件", success: false, error: "widgetId 和 templateId 至少传一个" };
    const deps = await widgetToolDeps();

    if (widgetId) {
        const widgets = deps.storage.loadWidgets();
        const target = widgets.find((w) => w.id === widgetId);
        if (!target) return { name: "移除DIY组件", success: false, error: `找不到组件实例：${widgetId}` };
        if (!target.type.startsWith("diy-")) return { name: "移除DIY组件", success: false, error: "只允许移除 DIY 组件实例；内置组件请让用户自己长按整理。" };
        deps.storage.saveWidgets(deps.storage.removeWidget(widgets, widgetId));
        deps.events.notifyDesktopWidgetsChanged();
        return { name: "移除DIY组件", success: true, data: `实例 ${widgetId} 已移下桌面（模板保留）。` };
    }

    if (!templateId.startsWith("diy-")) return { name: "移除DIY组件", success: false, error: "templateId 必须是 diy- 开头的 DIY 模板 id" };
    const templates = deps.storage.loadDIYTemplates();
    const idx = templates.findIndex((t) => t.id === templateId);
    if (idx < 0) return { name: "移除DIY组件", success: false, error: `找不到模板：${templateId}` };
    const [removed] = templates.splice(idx, 1);
    deps.storage.saveDIYTemplates(templates);
    const widgets = deps.storage.loadWidgets();
    const remaining = widgets.filter((w) => w.type !== templateId);
    const removedInstances = widgets.length - remaining.length;
    deps.storage.saveWidgets(remaining);
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "移除DIY组件", success: true, data: `模板「${removed.name}」已删除，同时移除了 ${removedInstances} 个桌面实例。` };
}

// ── Navigation ────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<ToolResult> {
    const page = args.page as string;
    const subpage = args.subpage as string | undefined;
    const { mascotNavigate } = await import("./mascot-events");
    mascotNavigate(page, subpage);
    return { name: "导航", success: true, data: `已跳转到 ${page}${subpage ? `:${subpage}` : ""}` };
}

// ── 套件展开管理 ─────────────────────────────

const EXPANDED_STORAGE_KEY = "mascot_expanded_packages_v1";
const MAX_EXPANDED = 2;

function normalizeExpandedPackageIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) return [];
    const validIds = new Set(MASCOT_TOOL_PACKAGES.map((p) => p.id));
    const normalized: string[] = [];
    for (const id of ids) {
        if (typeof id !== "string" || !validIds.has(id)) continue;
        const existing = normalized.indexOf(id);
        if (existing >= 0) normalized.splice(existing, 1);
        normalized.push(id);
    }
    return normalized.slice(-MAX_EXPANDED);
}

export function loadExpandedPackages(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
            ?? window.sessionStorage.getItem(EXPANDED_STORAGE_KEY);
        if (!raw) return [];
        const ids = normalizeExpandedPackageIds(JSON.parse(raw));
        if (ids.length > 0 && !window.localStorage.getItem(EXPANDED_STORAGE_KEY)) {
            saveExpandedPackages(ids);
        }
        return ids;
    } catch { return []; }
}

export function saveExpandedPackages(ids: string[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(normalizeExpandedPackageIds(ids)));
    } catch {}
}

export function clearExpandedPackages(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(EXPANDED_STORAGE_KEY);
        window.sessionStorage.removeItem(EXPANDED_STORAGE_KEY);
    } catch {}
}

export function touchExpandedPackage(currentIds: string[], packageId: string): string[] {
    const validIds = new Set(MASCOT_TOOL_PACKAGES.map((p) => p.id));
    if (!validIds.has(packageId)) return currentIds;
    const next = currentIds.filter((id) => id !== packageId);
    next.push(packageId);
    return next.slice(-MAX_EXPANDED);
}

/** 套件 label → packageId */
export function findPackageByLabel(label: string): MascotToolPackage | undefined {
    return MASCOT_TOOL_PACKAGES.find((p) => p.label === label);
}
