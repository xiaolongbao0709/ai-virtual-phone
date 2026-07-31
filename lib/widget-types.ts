export type WidgetType =
  | "music"
  | "calendar"
  | "clock"
  | "photo"
  | "loveNote"
  | "interviewMagazine"
  | "kaomoji"
  | "mascot"
  | "kawaiiMusicPlayer"
  | "iosMenu"
  | "mySpace"
  | "socialPost"
  | "coupleChat"
  | "moodPill"
  | "vinylRecord"
  | "receiptTask"
  | "ticketStub"
  | "postCard"
  | "profileCard"
  | (string & {});

export type DIYTemplateSlot = {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type DIYWidgetTemplate = {
  id: string; // e.g., "diy-17012345"
  name: string;
  size: WidgetSize;
  mode: "image" | "code";
  bgAssetId?: string; // IndexedDB ID for PNG
  slots?: DIYTemplateSlot[];
  htmlString?: string;
};

export type WidgetSize =
  | "1x1"
  | "1x2"
  | "1x4"
  | "2x1"
  | "2x2"
  | "2x3"
  | "2x4"
  | "3x2"
  | "3x3"
  | "3x4"
  | "4x2"
  | "4x3"
  | "4x4"
  | "5x4"
  | "6x4";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  page: number;
  row: number; // 1-based grid row
  col: number; // 1-based grid column
  config?: Record<string, unknown>;
};

export type WidgetCatalogEntry = {
  type: WidgetType;
  name: string;
  desc: string;
  size: WidgetSize;
  /** Whether the widget uses standard global rendering (glass, shadows) or handles its own physical shape entirely */
  track?: "freestyle";
};

/** How many grid cells a widget size occupies: [rows, cols] */
export const WIDGET_SIZE_CELLS: Record<WidgetSize, [number, number]> = {
  "1x1": [1, 1],
  "1x2": [1, 2],
  "2x1": [2, 1],
  "2x2": [2, 2],
  "1x4": [1, 4],
  "2x3": [2, 3],
  "3x2": [3, 2],
  "3x3": [3, 3],
  "2x4": [2, 4],
  "3x4": [3, 4],
  "4x2": [4, 2],
  "4x3": [4, 3],
  "4x4": [4, 4],
  "5x4": [5, 4],
  "6x4": [6, 4],
};

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  // 2×4 wide
  { type: "music", name: "\u97F3\u4E50\u64AD\u653E\u5668", desc: "\u5C01\u9762 + \u6B4C\u540D + \u64AD\u653E\u63A7\u5236", size: "2x4" },
  { type: "interviewMagazine", name: "在场摘录", desc: "照片 + 本期访谈摘录翻页卡", size: "2x4" },
  // 2×2
  { type: "calendar", name: "\u65E5\u5386", desc: "\u6708\u89C6\u56FE + \u9AD8\u4EAE\u4ECA\u5929", size: "2x2" },
  { type: "clock", name: "\u65F6\u949F + \u65E5\u671F", desc: "\u5927\u53F7\u65F6\u95F4 + \u65E5\u671F\u661F\u671F", size: "2x2" },
  { type: "photo", name: "\u7167\u7247\u76F8\u6846", desc: "\u653E\u4E00\u5F20\u7167\u7247\uFF0C\u70B9\u51FB\u66FF\u6362", size: "2x2" },
  { type: "loveNote", name: "\u60C5\u8BDD\u4FBF\u7B7E", desc: "\u968F\u673A\u751C\u871C\u60C5\u8BDD", size: "2x2" },
  { type: "mascot", name: "AI助手", desc: "AI创作桌宠，点击召唤", size: "2x2" },
  // 🌸 Kawaii Aesthetic Series
  { type: "kawaiiMusicPlayer", name: "美萌 · 音乐播放器", desc: "柔光风格音乐播放组件", size: "2x4" },
  { type: "mySpace", name: "My Space 名片", desc: "极简纯白个人资料展示页", size: "3x4" },
  { type: "socialPost", name: "微空间动态", desc: "悬浮大画幅图片社交博文", size: "4x4" },
  { type: "largeTime", name: "极简数字大时钟", desc: "大画幅数字时间与日期文字", size: "2x4" },
  // 🍏 iOS System Mimicry
  { type: "iosMenu", name: "iOS 操作菜单", desc: "复刻 iOS 原生高亮操作弹窗", size: "1x4" },
  // 💬 Message & Chat
  { type: "coupleChat", name: "悄悄话", desc: "模拟双人气泡对话，内含自动心形波形", size: "2x4" },
  { type: "moodPill", name: "悬浮心情气泡", desc: "极简浮动文字标签与表情装饰", size: "1x4" },
  // 🪪 Objects & Badges
  { type: "vinylRecord", name: "黑胶唱片", desc: "旋转的极简黑胶音乐装饰", size: "2x2" },
  // 🎨 Freestyle & Analog Designs (Custom physics rendering)
  { type: "receiptTask", name: "自由 · 购物小票", desc: "纯粹的带锯齿边缘脱轨小票", size: "3x2", track: "freestyle" },
  { type: "ticketStub", name: "自由 · 电影票根", desc: "不规则异形打孔纯享票根", size: "2x4", track: "freestyle" },
  { type: "postCard", name: "自由 · Y2K卡片", desc: "完全自由脱轨艺术展示框", size: "2x4", track: "freestyle" },
  { type: "cameraFrame", name: "自由 · 相机取景框", desc: "带UI框的透明拍照视窗", size: "4x3", track: "freestyle" },
  { type: "colorPickerFrame", name: "自由 · 取色器画框", desc: "极简白盘取色器透明相框", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame18", name: "自由 · 灰色气泡", desc: "横向聊天气泡贴纸", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame4", name: "自由 · 宽幅画框", desc: "2x4 比例宽版相框", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame31", name: "自由 · 侧滑条画框", desc: "带侧边滑动条的方框", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame33", name: "自由 · 立式大相框", desc: "3x4 比例大型画框", size: "3x4", track: "freestyle" },
  { type: "freestyleFrame36", name: "自由 · 横向胶带", desc: "单纯的横向分隔胶片", size: "1x4", track: "freestyle" },
  { type: "freestyleFrame49", name: "自由 · 正方相框", desc: "2x2 比例常规画框", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame54", name: "自由 · 头像名牌", desc: "带右侧头像栏的1x4名牌", size: "1x4", track: "freestyle" },
  { type: "freestyleFrame68", name: "自由 · 天气关注", desc: "带天气版式UI的2x4框", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame72", name: "自由 · 四宫图", desc: "四张图可换的4x4画框", size: "4x4", track: "freestyle" },
  { type: "freestyleFrame88", name: "自由 · 音乐磁带", desc: "带专辑孔位的2x3框", size: "2x3", track: "freestyle" },
  { type: "freestyleFrame90", name: "自由 · 个人空间", desc: "多图可换的2x4资料卡", size: "2x4", track: "freestyle" },
  { type: "profileCard", name: "自由 · 主页名片", desc: "背景图+白卡+悬浮头像的资料名片", size: "4x4", track: "freestyle" },
];

export const GRID_ROWS = 6;
export const GRID_COLS = 4;
