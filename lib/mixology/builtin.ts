// lib/mixology/builtin.ts
// 独家特调 · 官方出厂材料：序言/基底/杯型/核对的默认文案，以及一件示范机括「朗读」。
// 这几件是"素杯也好喝"的底线——玩家一件配料不装、只拿一张角色卡也能开局。
// 文案升级时 bump MIX_BUILTIN_VERSION，storage 会用出厂内容刷新官方件。

import type { MixMechanismMaterial, MixTextMaterial } from "./types";

export const MIX_BUILTIN_VERSION = 4;

export const MIX_BUILTIN_PREFACE_ID = "mix_builtin_preface";
export const MIX_BUILTIN_BASE_ID = "mix_builtin_base";
export const MIX_BUILTIN_GLASS_ID = "mix_builtin_glass";
export const MIX_BUILTIN_CHECKLIST_ID = "mix_builtin_checklist";

const now = () => Date.now();

/**
 * 官方序言：提示词最顶上的开场说明（历史上曾硬编码在组装器里的那段固定文案）。
 * 与基底/杯型同规则：槽位里选了才生效，没配提示词就没有这一段，不做暗兜底。
 * 「越靠后的要求优先级越高」是段落排序的配套约定，自建序言时也建议保留。
 */
export function createBuiltinPreface(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_PREFACE_ID,
        kind: "preface",
        name: "官方 · 标准序言",
        hook: "出厂自带的开场声明，点明扮演与优先级",
        author: "独家特调",
        content: "这是一场沉浸式角色扮演，你要扮演的角色是{{char}}。下方依次给出扮演规则、角色资料与输出要求，请全部遵守；越靠后的要求优先级越高。\n（# 为分段，## 为该段下的具体条目；更深的层级来自创作者自己的分层。）",
        tags: ["官方"],
        createdAt: now(),
        updatedAt: now(),
    };
}

/** 官方基底：扮演总纲 */
export function createBuiltinBase(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_BASE_ID,
        kind: "base",
        name: "官方 · 标准扮演",
        hook: "出厂自带的扮演总纲，稳定不出戏",
        author: "独家特调",
        content: [
            "你将完全成为「{{char}}」，以第一视角活在故事里，与「{{user}}」进行沉浸式角色扮演。",
            "- 始终以{{char}}的身份、性格、说话方式行动，绝不跳出角色、绝不以 AI 或助手自称。",
            "- 只扮演{{char}}与故事中的旁白/配角，绝不代替{{user}}说话、行动或下决定。",
            "- 依据角色资料与已发生的剧情推进故事，主动推动情节，不原地打转，不重复已说过的内容。",
            "- 角色资料没写的细节可以合理补全，但不得与已有设定矛盾。",
            "- 允许剧情出现冲突、拒绝与负面情绪，角色不是讨好机器；贴合人设比讨好{{user}}更重要。",
        ].join("\n"),
        tags: ["官方"],
        createdAt: now(),
        updatedAt: now(),
    };
}

/** 官方杯型：输出格式（含正文语义协议的书写引导） */
export function createBuiltinGlass(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_GLASS_ID,
        kind: "glass",
        name: "官方 · 正文与对白",
        hook: "出厂自带的输出格式，正文流畅、对白分明",
        author: "独家特调",
        content: [
            "以小说正文的形式输出，第三人称叙述，每轮 2~4 个自然段，段落之间空一行。",
            "- 叙述里穿插动作、神态与环境细节，让画面能被看见；不要写成流水账。",
            "- 每轮在留有余韵处收笔，给{{user}}接话的空间；不要替{{user}}总结感受。",
        ].join("\n"),
        tags: ["官方"],
        createdAt: now(),
        updatedAt: now(),
    };
}

/**
 * 官方核对：系统提示词最后一节「输出格式检查」的默认清单（历史上曾由组装器按装了几块
 * 状态栏/小剧场临时拼出来，现在与序言同规则：槽位里选了才有这一段，不选就没有，所见即所得）。
 * 按一块状态栏 + 一块小剧场的通用版写；装了多块或有机括要求的输出块，自建一件在此基础上改。
 */
export function createBuiltinChecklist(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_CHECKLIST_ID,
        kind: "checklist",
        name: "官方 · 标准核对",
        hook: "出厂自带的收尾清单：正文、状态栏、小剧场逐项核对",
        author: "独家特调",
        content: [
            "每轮回复发出前逐项核对：",
            "- 正文符合「正文输出要求」。",
            "- 回复最开头已按「状态栏」的格式输出 [状态栏]...[/状态栏] 块——任何一轮都不能缺。",
            "- 回复最末尾已按「小剧场」的格式输出 [小剧场]...[/小剧场] 块——任何一轮都不能缺。",
        ].join("\n"),
        tags: ["官方"],
        createdAt: now(),
        updatedAt: now(),
    };
}

export const MIX_BUILTIN_READER_ID = "mix_builtin_reader";

/**
 * 官方机括「朗读」：对白按钮 + 连接器 + 无界面运行的样板。
 * 每句「对白」后面一颗喇叭，点了才把这句交给玩家的 tts 连接器合成，不点不花钱；
 * 合成结果递给宿主播放（mix.play），按钮状态由宿主画；出错用 mix.toast 说一句。
 * 不画任何面板。需要玩家在酒柜「连接器」里用「MiniMax 语音」预设建一个叫 tts 的连接器。
 */
export function createBuiltinReader(): MixMechanismMaterial {
    return {
        id: MIX_BUILTIN_READER_ID,
        kind: "mechanism",
        name: "官方 · 朗读",
        hook: "每句对白后一颗喇叭，点一下用你的 MiniMax 连接器念出来",
        author: "独家特调",
        tags: ["官方", "语音", "连接器"],
        connectors: ["tts"],
        dialogueButton: { icon: "speaker", title: "朗读这句" },
        layout: { x: 0, y: 0, w: 100, h: 10, slot: "hidden" },
        panelHtml: [
            "<script>",
            "(function(){",
            "  var playingId='', cache={}, cacheKeys=[];",
            "  function hexToBytes(hex){",
            "    var n=hex.length>>1, bytes=new Uint8Array(n);",
            "    for(var i=0;i<n;i++) bytes[i]=parseInt(hex.substr(i*2,2),16);",
            "    return bytes;",
            "  }",
            "  function remember(text,bytes){ cache[text]=bytes; cacheKeys.push(text); if(cacheKeys.length>30) delete cache[cacheKeys.shift()]; }",
            "  function play(id,bytes){ playingId=id; window.mix.play(id, bytes, 'audio/mpeg'); }",
            "  window.onMixDialogue=function(e){",
            "    var id=e.id, text=String(e.text||'').trim();",
            "    if(!text) return;",
            "    if(playingId===id){ playingId=''; window.mix.stop(); window.mix.mark(id,''); return; }",
            "    if(cache[text]){ play(id,cache[text]); return; }",
            "    window.mix.mark(id,'busy');",
            "    window.mix.call('tts',{ text:text.slice(0,2000) }).then(function(r){",
            "      var d=r.data||{}; var hex=d.data&&d.data.audio;",
            "      if(!hex){ var m=(d.base_resp&&d.base_resp.status_msg)||('接口返回 '+r.status); window.mix.mark(id,''); window.mix.toast('合成失败：'+m); return; }",
            "      var bytes=hexToBytes(hex); remember(text,bytes); play(id,bytes);",
            "    }).catch(function(err){ window.mix.mark(id,''); window.mix.toast(err.missing?'先到酒柜「连接器」里建一个叫 tts 的连接器':('朗读失败：'+err.message)); });",
            "  };",
            "})();",
            "</script>",
        ].join("\n"),
        createdAt: now(),
        updatedAt: now(),
    };
}
