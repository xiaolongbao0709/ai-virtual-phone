// lib/changelog.ts
// 小手机（虚拟手机）UI 功能版本与更新日志。
//
// 注意：APP_VERSION 是「功能版本」，独立于 package.json 里的框架版本号。
// 每次对手机 UI / 内置 App 做较大更新时，请把 APP_VERSION 递增，并在 CHANGELOG
// 头部追加一条记录。设置页「系统更新」与小卷「查询系统更新」工具共用这份数据，
// 这样你无论从哪都能确认「我的小手机是不是更新了、更新了什么」。

export const APP_VERSION = "1.2.0";

export interface ChangelogEntry {
  version: string;       // 例如 "1.0.0"
  date: string;          // YYYY-MM-DD
  title: string;         // 本次更新的主题
  highlights: string[];  // 更新要点
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.2.0",
    date: "2026-08-07",
    title: "建群弹窗支持全部角色 + NPC 纯群",
    highlights: [
      "创建群聊候选列表从「仅联系人」扩展为「全部有独立人设的角色」",
      "未加好友的角色也可被选入，并标记「未添加好友」",
      "选人步骤即可切换「围观模式」；选满 2 人可一键「设为 NPC 纯群」（机主不在群里），方便围观 NPC 之间的社交",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v10：调酒台融合 + 点单菜单恢复",
    highlights: [
      "调酒台游戏由 iframe 改为直接同文档内联合并，修复手机端黑屏问题",
      "恢复吧台点单菜单（今日特调 / 自调 / 让 TA 调）",
      "修复 ai.generate 缺少 characterId 导致随机事件等 6 处报错",
      "酒吧相册支持 AI 生图合照",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-08-07",
    title: "工坊能力增强",
    highlights: [
      "工坊「单轮工具调用上限」可在配置里调节",
      "仓库源码单次读取上限提升至 9000 字符，单页读取字符数可配置",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-08-07",
    title: "系统更新查询上线",
    highlights: [
      "设置新增「系统更新」入口，可查看当前版本号与历次更新内容",
      "小卷（手机助手）支持直接询问「最近更新了什么 / 版本更新了吗」",
      "内置 App 持续迭代（黑珍珠灵魂酒吧：世界书挂载、角色头像预设等）",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-08-05",
    title: "黑珍珠灵魂酒吧上线",
    highlights: [
      "新增内置 App「黑珍珠灵魂酒吧」：时间流逝、醉酒度、账单、拍照发朋友圈",
      "多房间（卡座 / 吧台 / 露台）与固定员工（老板娘珍珠、调酒师老K）",
      "世界书挂载、随机突发事件、熟人 / 商业伙伴关系互动",
    ],
  },
];

/** 把更新日志拼成适合小卷回复 / 文本展示的字符串 */
export function formatChangelog(): string {
  const lines: string[] = [];
  lines.push(`小手机当前版本：v${APP_VERSION}`);
  lines.push("");
  for (const e of CHANGELOG) {
    lines.push(`【v${e.version} · ${e.date}】${e.title}`);
    for (const h of e.highlights) lines.push(`  · ${h}`);
    lines.push("");
  }
  lines.push("（以上为本机已安装的更新记录；远程有新版本时会在「系统更新」里提示。）");
  return lines.join("\n");
}
