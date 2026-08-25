"use client";

// 资源集市像素图标：16×16 像素网格手绘，渲染为锐边 SVG。
// 零图片资源，Win98 经典配色，缩放不糊。
// 网格字符 → 颜色见 PALETTE；"." 为透明。

import type { ImportDestination } from "@/lib/resource-hub-types";

const PALETTE: Record<string, string> = {
    k: "#1a1a1a", // 黑（描边）
    w: "#ffffff", // 白
    g: "#c6c6c6", // 浅灰
    d: "#7a7a7a", // 深灰
    y: "#f8d838", // 黄
    r: "#d84848", // 红
    b: "#4868d8", // 蓝
    B: "#203890", // 深蓝
    c: "#38a8a0", // 青
    t: "#e8c890", // 皮肤/纸箱
    n: "#000080", // 藏青
    p: "#b868d0", // 紫
    o: "#c88030", // 橙（纸箱）
};

type PixelGrid = string[];

const DEST_ICONS: Record<ImportDestination, PixelGrid> = {
    // 调音台滑杆
    preset: [
        "................",
        "....bb..........",
        "..ddBBdddddddd..",
        "....bb..........",
        "................",
        ".........bb.....",
        "..dddddddBBddd..",
        ".........bb.....",
        "................",
        "......bb........",
        "..ddddBBdddddd..",
        "......bb........",
        "................",
        "................",
        "................",
        "................",
    ],
    // 剪刀
    regex: [
        "................",
        "................",
        "..kk........kk..",
        "..kkk......kkk..",
        "...kkk....kkk...",
        "....kkk..kkk....",
        ".....kkkkkk.....",
        "......kkkk......",
        ".....kkkkkk.....",
        "....kkk..kkk....",
        "...rrr....rrr...",
        "..rrrr....rrrr..",
        "..rrr......rrr..",
        "................",
        "................",
        "................",
    ],
    // 打开的书
    worldbook: [
        "................",
        "................",
        "..kkkkkk.kkkkk..",
        ".kwwwwwkkwwwwwk.",
        ".kwwwwwkkwwwwwk.",
        ".kwddwwkkwwddwk.",
        ".kwwwwwkkwwwwwk.",
        ".kwddwwkkwwddwk.",
        ".kwwwwwkkwwwwwk.",
        ".kwwwwwkkwwwwwk.",
        ".kpppppkkpppppk.",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
        "................",
        "................",
    ],
    // 角色卡
    character: [
        "................",
        ".kkkkkkkkkkkkk..",
        ".kwwwwwwwwwwwk..",
        ".kwwwwwttwwwwk..",
        ".kwwwwttttwwwk..",
        ".kwwwwttttwwwk..",
        ".kwwwwwttwwwwk..",
        ".kwwwbbbbbbwwk..",
        ".kwwbbbbbbbbwk..",
        ".kwwbbbbbbbbwk..",
        ".kwwwwwwwwwwwk..",
        ".kkkkkkkkkkkkk..",
        "................",
        "................",
        "................",
        "................",
    ],
    // 对话气泡
    chat_session_css: [
        "................",
        "................",
        "..kkkkkkkkkkk...",
        ".kwwwwwwwwwwwk..",
        ".kwddddddwwwwk..",
        ".kwwwwwwwwwwwk..",
        ".kwddddddddwwk..",
        ".kwwwwwwwwwwwk..",
        "..kkkkkkkkkkk...",
        "....kkw.........",
        "...kkw..........",
        "...kk...........",
        "................",
        "................",
        "................",
        "................",
    ],
    // 手机
    chat_app_css: [
        "................",
        "....kkkkkkkk....",
        "....kwwwwwwk....",
        "....kwbbbbwk....",
        "....kwbbbbwk....",
        "....kwbbbbwk....",
        "....kwbbbbwk....",
        "....kwbbbbwk....",
        "....kwbbbbwk....",
        "....kwwwwwwk....",
        "....kwwddwwk....",
        "....kkkkkkkk....",
        "................",
        "................",
        "................",
        "................",
    ],
    // 调色盘
    global_css: [
        "................",
        "................",
        "....kkkkkkk.....",
        "..kkwwwwwwwkk...",
        ".kwwrrwwyywwwk..",
        ".kwwrrwwyywwwk..",
        ".kwwwwwwwwwbbk..",
        ".kwccwwwwwwbbk..",
        ".kwccwwwkkwwwk..",
        "..kwwwwwkkwwk...",
        "...kkwwwwwkk....",
        ".....kkkkk......",
        "................",
        "................",
        "................",
        "................",
    ],
    // 纸箱
    custom_app: [
        "................",
        "................",
        "..kkkkkkkkkkkk..",
        "..kooooyyooook..",
        "..kooooyyooook..",
        "..kyyyyyyyyyyk..",
        "..kooooyyooook..",
        "..kooooyyooook..",
        "..kooooyyooook..",
        "..kooooyyooook..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
        "................",
        "................",
        "................",
    ],
    // 街机摇杆
    game: [
        "................",
        "......rrrr......",
        ".....rrrrrr.....",
        ".....rrrrrr.....",
        "......rrrr......",
        ".......kk.......",
        ".......kk.......",
        ".......kk.......",
        "...kkkkkkkkkk...",
        "..kggggggggggk..",
        "..kgyyggggddgk..",
        "..kgyyggggddgk..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
        "................",
    ],
    // 剧场（幕布 + 星）
    theater: [
        "................",
        ".kkkkkkkkkkkkkk.",
        ".krrrrrrrrrrrrk.",
        ".krrrknnnnkrrrk.",
        ".krrknnnnnnkrrk.",
        ".krrknnnnnnkrrk.",
        ".krrknnyynnkrrk.",
        ".krrknnyynnkrrk.",
        ".krrknnnnnnkrrk.",
        ".krrknnnnnnkrrk.",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
        "................",
        "................",
        "................",
    ],
    // 拼图块
    plugin: [
        "................",
        "......kkkk......",
        "......kcck......",
        "..kkkkkcckkkkk..",
        "..kcccccccccck..",
        "..kcccccccccck..",
        "..kcccccccccck..",
        "..kcccccccccck..",
        "..kcccccccccck..",
        "..kcccccccccck..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
        "................",
        "................",
        "................",
    ],
    // 调色板（主题包）
    theme: [
        "................",
        "................",
        "................",
        "......kkkk......",
        "....kkwwwwkk....",
        "...kwrrwwyywk...",
        "..kwwrrwwyywwk..",
        "..kwbbwwwwwcck..",
        "..kwbbwwwwwcck..",
        "..kwwwwwwwwwwk..",
        "..kwwwwwwkkwwk..",
        "...kwwwwwkkwk...",
        "....kkwwwwkk....",
        "......kkkk......",
        "................",
        "................",
    ],
    // 列表卡片 + 加号徽标（单条预设条目）
    preset_entry: [
        "................",
        "................",
        "..kkkkkkkkkkkk..",
        "..kwwwwwwwwwwk..",
        "..kwddddddddwk..",
        "..kwddddddddwk..",
        "..kwwwwwwwwwwk..",
        "..kwbbbbbbbbwk..",
        "..kwbbbbbbbbwk..",
        "..kwwwwwwkkkkk..",
        "..kwdddddkkykk..",
        "..kwdddddkyyyk..",
        "..kkkkkkkkkykk..",
        ".........kkkkk..",
        "................",
        "................",
    ],
    // 主页卡片：头部条 + 头像 + 文字行 + 评论区（自定义状态栏）
    status_bar: [
        "................",
        "..kkkkkkkkkkkk..",
        "..krrrrrrrrrrk..",
        "..krrrrrrrrrrk..",
        "..kwbbwwwwwwwk..",
        "..kwbbwddddwwk..",
        "..kwwwwwwwwwwk..",
        "..kwddddddwwwk..",
        "..kwddddwwwwwk..",
        "..kwwwwwwwwwwk..",
        "..kwggggggggwk..",
        "..kwgddddddgwk..",
        "..kwggggggggwk..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
    ],
    // 马天尼杯：独家特调
    mixology: [
        "................",
        ".kkkkkkkkkkkkkk.",
        ".kppppppyppppk..",
        "..kpppppppppk...",
        "...kpppppppk....",
        "....kpppppk.....",
        ".....kpppk......",
        "......kpk.......",
        ".......k........",
        ".......k........",
        ".......k........",
        ".......k........",
        "....kkkkkkk.....",
        "................",
        "................",
        "................",
    ],
};

function renderGrid(grid: PixelGrid, size: number, className?: string) {
    const rects: React.ReactNode[] = [];
    grid.forEach((row, y) => {
        // 同色连续像素合并成一个 rect，减少节点数
        let x = 0;
        while (x < row.length) {
            const ch = row[x];
            if (ch === "." || !PALETTE[ch]) { x++; continue; }
            let end = x + 1;
            while (end < row.length && row[end] === ch) end++;
            rects.push(<rect key={`${x},${y}`} x={x} y={y} width={end - x} height={1} fill={PALETTE[ch]} />);
            x = end;
        }
    });
    return (
        <svg viewBox="0 0 16 16" width={size} height={size} className={className} shapeRendering="crispEdges" aria-hidden>
            {rects}
        </svg>
    );
}

export function DestPixelIcon({ dest, size = 34 }: { dest: ImportDestination; size?: number }) {
    return renderGrid(DEST_ICONS[dest], size);
}

// ── 按扩展名生成的文件图标（详情页文件条用）──
// 统一的"折角文档"底版，"a" 为类型强调色（内容线条区）。

const FILE_DOC_TEMPLATE: PixelGrid = [
    "................",
    "...kkkkkkkk.....",
    "...kwwwwwwkk....",
    "...kwwwwwwkwk...",
    "...kwwwwwwkkkk..",
    "...kwaaaawwwwk..",
    "...kwwwwwwwwwk..",
    "...kwaaaaaawwk..",
    "...kwwwwwwwwwk..",
    "...kwaaaaaawwk..",
    "...kwwwwwwwwwk..",
    "...kwaaaawwwwk..",
    "...kwwwwwwwwwk..",
    "...kkkkkkkkkkk..",
    "................",
    "................",
];

const FILE_TYPE_COLORS: Record<string, string> = {
    zip: "#c88030",
    json: "#4868d8",
    txt: "#7a7a7a",
    css: "#b868d0",
    js: "#d8a828",
    mjs: "#d8a828",
    html: "#d84848",
    htm: "#d84848",
    png: "#38a8a0",
    jpg: "#38a8a0",
    jpeg: "#38a8a0",
    webp: "#38a8a0",
    gif: "#38a8a0",
};

export function fileExtension(filename: string): string {
    const match = /\.([A-Za-z0-9]+)$/.exec(filename);
    return match ? match[1].toLowerCase() : "";
}

export function FileTypePixelIcon({ filename, size = 34 }: { filename: string; size?: number }) {
    const accent = FILE_TYPE_COLORS[fileExtension(filename)] || "#7a7a7a";
    const rects: React.ReactNode[] = [];
    FILE_DOC_TEMPLATE.forEach((row, y) => {
        let x = 0;
        while (x < row.length) {
            const ch = row[x];
            const fill = ch === "a" ? accent : PALETTE[ch];
            if (!fill) { x++; continue; }
            let end = x + 1;
            while (end < row.length && row[end] === ch) end++;
            rects.push(<rect key={`${x},${y}`} x={x} y={y} width={end - x} height={1} fill={fill} />);
            x = end;
        }
    });
    return (
        <svg viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" aria-hidden>
            {rects}
        </svg>
    );
}
