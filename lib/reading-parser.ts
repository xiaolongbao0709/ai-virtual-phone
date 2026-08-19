// lib/reading-parser.ts — File parsing for TXT, EPUB, PDF.

// ── PDF.js CDN loader ──
const PDFJS_VERSION = "3.11.174"; // stable version available on cdnjs
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.mjs`;
        script.type = "module";
        // pdf.min.mjs is ESM, use a different approach — load the UMD build
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else {
                reject(new Error("pdfjsLib not found after script load"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js from CDN"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

type PdfSource = ArrayBuffer | Blob;

export type ParsedChapter = {
    title: string;
    paragraphs: string[];
};

export type ParsedBook = {
    title: string;
    author?: string;
    chapters: ParsedChapter[];
};

export type TxtDecodeResult = {
    text: string;
    encoding: string;
};

const TXT_DECODER_CANDIDATES = ["utf-8", "gb18030", "gbk", "big5", "utf-16le", "utf-16be"];

function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string | null {
    try {
        return new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
        return null;
    }
}

function scoreDecodedTxt(text: string): number {
    const sample = text.slice(0, 24000);
    if (!sample.trim()) return -100000;

    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const nulCount = (sample.match(/\u0000/g) || []).length;
    const controlCount = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const punctuationCount = (sample.match(/[，。！？；：“”‘’、（）《》…]/g) || []).length;
    const readableCount = (sample.match(/[A-Za-z0-9\s]/g) || []).length;

    return cjkCount * 3
        + punctuationCount * 2
        + readableCount * 0.15
        - replacementCount * 80
        - nulCount * 100
        - controlCount * 20;
}

/**
 * 解码 TXT 字节流为文本。
 * @param preferredEncoding 用户手动指定的编码（auto 或 undefined = 自动探测）。
 *   指定时优先用该编码解码（BOM 仍优先，因为 BOM 是权威的）；用于用户遇到自动探测
 *   误判导致的乱码时，手动指定 TXT 的真实编码重新导入。
 */
export function decodeTxtArrayBuffer(buffer: ArrayBuffer, preferredEncoding?: string): TxtDecodeResult {
    const bytes = new Uint8Array(buffer);
    const bomCandidates: Array<[string, boolean]> = [];

    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        bomCandidates.push(["utf-8", true]);
    } else if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        bomCandidates.push(["utf-16le", true]);
    } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        bomCandidates.push(["utf-16be", true]);
    }

    // BOM 优先：有 BOM 就以 BOM 声明的编码为准（BOM 比手选更权威）
    for (const [encoding] of bomCandidates) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text !== null) return { text, encoding };
    }

    // 用户手动指定了编码：直接用指定编码解码，不再自动探测
    if (preferredEncoding && preferredEncoding !== "auto") {
        const text = decodeWithEncoding(buffer, preferredEncoding);
        if (text !== null) return { text, encoding: preferredEncoding };
        return { text: "", encoding: preferredEncoding };
    }

    let best: TxtDecodeResult | null = null;
    let bestScore = -Infinity;

    for (const encoding of TXT_DECODER_CANDIDATES) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text === null) continue;
        const score = scoreDecodedTxt(text);
        if (score > bestScore) {
            bestScore = score;
            best = { text, encoding };
        }
    }

    return best ?? { text: decodeWithEncoding(buffer, "utf-8") ?? "", encoding: "utf-8" };
}

// ── Chapter heading patterns ──
const CHAPTER_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集篇]/,       // 第X章, 第X节, 第X回...
    /^Chapter\s+\d+/i,                                        // Chapter 1
    /^CHAPTER\s+[IVXLCDM\d]+/,                                // CHAPTER IV
    /^卷[零一二三四五六七八九十百千\d]+/,                       // 卷一
    /^={3,}/,                                                  // ===
    /^-{3,}/,                                                  // ---
    /^#{1,3}\s+/,                                              // Markdown # heading
];

function isChapterHeading(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 60) return false;
    return CHAPTER_PATTERNS.some(p => p.test(trimmed));
}

/** 剥离开头/结尾的空行：下载 TXT 常在章节标题前后插入分隔空行，
 *  它们不是作者段落空行，混入会污染 splitParagraphs 的空行占比检测。 */
function trimBlankEdges(arr: string[]): string[] {
    let s = 0;
    let e = arr.length;
    while (s < e && arr[s].trim() === "") s += 1;
    while (e > s && arr[e - 1].trim() === "") e -= 1;
    return arr.slice(s, e);
}

/**
 * Parse TXT content into chapters and paragraphs.
 * Splits by chapter headings, then by blank lines for paragraphs.
 * @param mode 段落划分方式：auto 自动探测 / blank 空行 / indent 段首缩进 / line 每行一段
 */
export function parseTxtContent(text: string, fileName?: string, mode: TxtParagraphMode = "auto"): ParsedBook {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    // auto 模式：对整本书探测一次段落格式，所有章节共用同一结论，
    // 避免短章节里夹杂的空白行让个别章节误判成别的格式。
    const resolvedMode = mode === "auto" ? detectParagraphMode(lines) : mode;

    // First pass: find chapter boundaries
    const chapterStarts: { lineIdx: number; title: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (isChapterHeading(lines[i])) {
            chapterStarts.push({ lineIdx: i, title: lines[i].trim().replace(/^#{1,3}\s+/, "") });
        }
    }

    // Extract title from first non-empty line (if before first chapter)
    let bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    if (chapterStarts.length > 0 && chapterStarts[0].lineIdx > 0) {
        for (let i = 0; i < chapterStarts[0].lineIdx; i++) {
            if (lines[i].trim()) { bookTitle = lines[i].trim(); break; }
        }
    }

    // No chapters found → entire text is one chapter
    if (chapterStarts.length === 0) {
        return {
            title: bookTitle,
            chapters: [{
                title: "全文",
                paragraphs: splitParagraphs(trimBlankEdges(lines), resolvedMode),
            }],
        };
    }

    // Build chapters
    const chapters: ParsedChapter[] = [];
    for (let i = 0; i < chapterStarts.length; i++) {
        const start = chapterStarts[i].lineIdx + 1; // skip heading line
        const end = i + 1 < chapterStarts.length ? chapterStarts[i + 1].lineIdx : lines.length;
        const chapterLines = trimBlankEdges(lines.slice(start, end));
        const paragraphs = splitParagraphs(chapterLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.push({ title: chapterStarts[i].title, paragraphs });
        }
    }

    // If there's content before the first chapter, add it as a prologue
    if (chapterStarts[0].lineIdx > 1) {
        const prologueLines = trimBlankEdges(lines.slice(0, chapterStarts[0].lineIdx));
        const paragraphs = splitParagraphs(prologueLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.unshift({ title: "序", paragraphs });
        }
    }

    return { title: bookTitle, chapters };
}

/** 判断一行是否以缩进开头（全角空格 / 2+ 半角空格 / Tab）→ 视为新段落起点。
 *  很多中文网文 TXT 段落之间没有空行，仅靠段首缩进区分段落；
 *  若只按空行分割会把整章合并成一段（批注/讨论时整章一起发给模型）。
 */
function isIndentedParagraphStart(line: string): boolean {
    return /^\u3000/.test(line)   // 全角空格缩进（中文网文最常见）
        || /^ {2,}/.test(line)    // 2+ 半角空格缩进
        || /^\t/.test(line);      // Tab 缩进
}

/** 松散标题行检测：比 isChapterHeading 更宽泛，仅用于识别「章节分隔空行」。
 *  下载 TXT 常在章节标题前后插入分隔空行，这些不是作者段落空行，
 *  若混进空行占比会污染 splitParagraphs 的格式探测（章节很多但每章很短的小说
 *  空行占比轻松超过 2%，被误判成空行分段 → 整章变成一段）。 */
const LENIENT_TITLE_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集部篇]/,   // 第X章/节/回/卷/部/篇
    /^[序楔]/,                                            // 序章 / 楔子
    /^(?:终章|后记|前言|番外|尾声|外传|引子)/,            // 常见非数字标题
    /^[Cc]hapter\s+\d+/,
    /^[Pp]art\s+[IVXLCDM\d]+/,
    /^[零一二三四五六七八九十百千\d]+[、.．:：]/,           // 一、 / 1、 / 1.
    /^[（(][零一二三四五六七八九十百千\d]+[)）]/,           // （一）/（1）
    /^《.+》$/,                                            // 《书名》式短行
    /^[=#*\-]{3,}$/,                                      // 分隔线
];

function isTitleLikeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 40) return false;
    return LENIENT_TITLE_PATTERNS.some((p) => p.test(trimmed));
}

/** 统计「作者段落空行」数量：连续空行块紧邻标题行（前或后）的视为章节分隔空行，不计数 */
function countAuthorBlankLines(lines: string[]): number {
    const titleLike = new Set<number>();
    lines.forEach((line, i) => {
        if (isTitleLikeLine(line)) titleLike.add(i);
    });

    const isBlank = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === "";
    let count = 0;
    let i = 0;
    while (i < lines.length) {
        if (!isBlank(i)) { i += 1; continue; }
        const runStart = i;
        while (i < lines.length && isBlank(i)) i += 1;
        const runEnd = i - 1;
        const beforeTitle = runStart > 0 && titleLike.has(runStart - 1);
        const afterTitle = runEnd + 1 < lines.length && titleLike.has(runEnd + 1);
        if (!beforeTitle && !afterTitle) count += runEnd - runStart + 1;
    }
    return count;
}

/** 按空行分段（标准网文导出格式；段内多行保持在同一段） */
function splitByBlankLines(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
        if (line.trim() === "") {
            if (current.length > 0) {
                paragraphs.push(current.join("\n").trim());
                current = [];
            }
        } else {
            current.push(line);
        }
    }
    if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
    }

    return paragraphs.filter(p => p.length > 0);
}

/** 按段首缩进分段（无空行的中文网文 TXT） */
function splitByIndent(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length > 0) {
            paragraphs.push(current.join("\n").trim());
            current = [];
        }
    };

    for (const line of lines) {
        if (line.trim() === "") {
            flush();
        } else if (isIndentedParagraphStart(line)) {
            flush();
            current.push(line);
        } else {
            current.push(line);
        }
    }
    flush();

    return paragraphs.filter(p => p.length > 0);
}

/** 智能分段：先探测本书格式再选策略——
 *  1) 空行占比 ≥ 15%：空行分段（标准导出格式，段内多行保留）
 *  2) 缩进行占比 ≥ 20%：段首缩进分段（晋江/起点手排 TXT，无空行）
 *  3) 空行占比 ≥ 2%：空行分段（段内多行较长、空行稀疏的情况）
 *  4) 否则：纯换行格式，一行一段（很多网文连开头缩进都省了，纯靠回车换行分段落）
 *  空行占比统计时已剔除「章节分隔空行」（紧邻标题行的空行块），
 *  避免下载 TXT 在章节间插入的空行污染探测。
 *  mode 参数可强制指定划分方式（auto=自动探测）。 */
export type TxtParagraphMode = "auto" | "blank" | "indent" | "line";

/** 全局探测一本书的段落格式（对整本书的 lines 调用一次，保证各章节结论一致） */
export function detectParagraphMode(lines: string[]): TxtParagraphMode {
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    if (nonEmpty.length === 0) return "line";

    const blankRatio = countAuthorBlankLines(lines) / Math.max(1, lines.length);
    const indentedRatio = nonEmpty.filter(isIndentedParagraphStart).length / nonEmpty.length;

    if (blankRatio >= 0.15) return "blank";
    if (indentedRatio >= 0.2) return "indent";
    if (blankRatio >= 0.02) return "blank";
    return "line";
}

function splitParagraphs(lines: string[], mode: TxtParagraphMode = "auto"): string[] {
    const nonEmpty = lines.filter(l => l.trim() !== "");
    if (nonEmpty.length === 0) return [];

    if (mode === "blank") return splitByBlankLines(lines);
    if (mode === "indent") return splitByIndent(lines);
    if (mode === "line") return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);

    const detected = detectParagraphMode(lines);
    if (detected === "blank") return splitByBlankLines(lines);
    if (detected === "indent") return splitByIndent(lines);
    return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);
}

// ── EPUB Parsing ──

/**
 * Parse EPUB file into chapters and paragraphs.
 * EPUB is a ZIP containing XHTML files.
 */
export async function parseEpubFile(arrayBuffer: ArrayBuffer, fileName?: string): Promise<ParsedBook> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. Find container.xml → rootfile path
    const containerXml = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!rootfileMatch) throw new Error("Invalid EPUB: no rootfile");
    const rootfilePath = rootfileMatch[1];
    const rootDir = rootfilePath.includes("/") ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1) : "";

    // 2. Parse OPF (package document)
    const opfXml = await zip.file(rootfilePath)?.async("text");
    if (!opfXml) throw new Error("Invalid EPUB: missing OPF");

    // Extract title and author
    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const authorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    const bookTitle = titleMatch?.[1]?.trim() || fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const author = authorMatch?.[1]?.trim();

    // 3. Extract spine order (reading order)
    const spineItems: string[] = [];
    const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
        const itemRefPattern = /idref="([^"]+)"/g;
        let m;
        while ((m = itemRefPattern.exec(spineMatch[1])) !== null) {
            spineItems.push(m[1]);
        }
    }

    // 4. Build id → href map from manifest
    const idToHref = new Map<string, string>();
    const manifestMatch = opfXml.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
    if (manifestMatch) {
        const itemPattern = /id="([^"]+)"[^>]*href="([^"]+)"/g;
        let m;
        while ((m = itemPattern.exec(manifestMatch[1])) !== null) {
            idToHref.set(m[1], m[2]);
        }
    }

    // 5. Read each spine item and extract text
    const chapters: ParsedChapter[] = [];
    for (const itemId of spineItems) {
        const href = idToHref.get(itemId);
        if (!href) continue;
        const filePath = rootDir + decodeURIComponent(href);
        const html = await zip.file(filePath)?.async("text");
        if (!html) continue;

        // Extract text from HTML
        const { title, paragraphs } = extractTextFromHtml(html);
        if (paragraphs.length === 0) continue;
        chapters.push({ title: title || `第${chapters.length + 1}章`, paragraphs });
    }

    if (chapters.length === 0) {
        return { title: bookTitle, author, chapters: [{ title: "全文", paragraphs: ["（EPUB 解析失败，未找到文本内容）"] }] };
    }

    return { title: bookTitle, author, chapters };
}

/** Extract readable text from HTML/XHTML content. */
function extractTextFromHtml(html: string): { title: string; paragraphs: string[] } {
    // Try to extract title from <title> or <h1>-<h3>
    const titleMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
        || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]).trim() : "";

    // Extract text from <p>, <div>, <li> tags
    const paragraphs: string[] = [];
    const blockPattern = /<(?:p|div|li)[^>]*>([\s\S]*?)<\/(?:p|div|li)>/gi;
    let match;
    while ((match = blockPattern.exec(html)) !== null) {
        const text = stripHtmlTags(match[1]).trim();
        if (text.length > 0) paragraphs.push(text);
    }

    // Fallback: strip all tags and split by newlines
    if (paragraphs.length === 0) {
        const plainText = stripHtmlTags(html).trim();
        if (plainText) {
            const lines = plainText.split(/\n{2,}/).map(l => l.trim()).filter(l => l.length > 0);
            paragraphs.push(...lines);
        }
    }

    return { title, paragraphs };
}

function stripHtmlTags(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, " ");
}

// ── PDF Parsing ──

/**
 * Parse PDF file into chapters (pages) and paragraphs.
 * Each page becomes a "chapter" since PDFs don't have semantic chapters.
 */
export type PdfParagraphMeta = {
    text: string;
    pageNum: number;       // 1-based page number
    yRatio: number;        // 0-1 vertical position within the page (0=top, 1=bottom)
};
export const PDF_PAGES_PER_CHAPTER = 5;

export type ParsedPdfChunk = ParsedChapter & {
    startPage: number;
    endPage: number;
    pdfMeta: PdfParagraphMeta[];
};

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

async function openPdfDocument(source: PdfSource): Promise<{ pdf: any; dispose: () => Promise<void> }> {
    const pdfjsLib = await loadPdfjs();
    if (source instanceof Blob) {
        const url = URL.createObjectURL(source);
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        return {
            pdf,
            dispose: async () => {
                URL.revokeObjectURL(url);
            },
        };
    }

    const pdf = await pdfjsLib.getDocument(new Uint8Array(source)).promise;
    return {
        pdf,
        dispose: async () => {},
    };
}

async function readPdfBaseMeta(pdf: any, fileName?: string) {
    const bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    return {
        title: (info?.Title as string | undefined) || bookTitle,
        author: (info?.Author as string | undefined)?.trim() || undefined,
        totalPages: pdf.numPages,
    };
}

export async function inspectPdfFile(source: PdfSource, fileName?: string): Promise<ParsedBook & { totalPages: number }> {
    const { pdf, dispose } = await openPdfDocument(source);
    try {
        const base = await readPdfBaseMeta(pdf, fileName);
        const chapters: ParsedChapter[] = [];
        for (let startPage = 1; startPage <= base.totalPages; startPage += PDF_PAGES_PER_CHAPTER) {
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chapters.push({
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: [],
            });
        }
        return { title: base.title, author: base.author, totalPages: base.totalPages, chapters };
    } finally {
        try {
            await pdf.destroy?.();
        } catch {
            // Ignore cleanup failures from PDF.js.
        }
        await dispose();
    }
}

export async function parsePdfPageRange(
    source: PdfSource,
    options: { startPage: number; endPage: number; fileName?: string },
): Promise<{ title: string; author?: string; totalPages: number; chunks: ParsedPdfChunk[] }> {
    const { pdf, dispose } = await openPdfDocument(source);
    const base = await readPdfBaseMeta(pdf, options.fileName);
    const startPage = Math.max(1, Math.min(base.totalPages, options.startPage));
    const endPage = Math.max(startPage, Math.min(base.totalPages, options.endPage));
    const chunkMap = new Map<number, ParsedPdfChunk>();

    const ensureChunk = (pageNum: number) => {
        const chunkStart = Math.floor((pageNum - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        let chunk = chunkMap.get(chunkStart);
        if (!chunk) {
            const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chunk = {
                title: buildPdfChunkTitle(chunkStart, chunkEnd),
                startPage: chunkStart,
                endPage: chunkEnd,
                paragraphs: [],
                pdfMeta: [],
            };
            chunkMap.set(chunkStart, chunk);
        }
        return chunk;
    };

    for (let i = startPage; i <= endPage; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageHeight = viewport.height;
        const chunk = ensureChunk(i);

        const items = textContent.items as { str?: string; transform?: number[] }[];
        const lines: { text: string; y: number }[] = [];
        let currentLine = "";
        let currentY = -1;

        for (const item of items) {
            const str = item.str || "";
            if (!str.trim()) continue;
            const y = item.transform ? item.transform[5] : 0;

            if (currentY < 0 || Math.abs(y - currentY) < 3) {
                currentLine += str;
                if (currentY < 0) currentY = y;
            } else {
                if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });
                currentLine = str;
                currentY = y;
            }
        }
        if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });

        let paraText = "";
        let paraY = 0;
        for (let j = 0; j < lines.length; j += 1) {
            if (paraText === "") {
                paraText = lines[j].text;
                paraY = lines[j].y;
            } else {
                const gap = Math.abs(lines[j].y - lines[j - 1].y);
                if (gap > 20) {
                    if (paraText.length > 5) {
                        const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
                        chunk.pdfMeta.push(meta);
                        chunk.paragraphs.push(meta.text);
                    }
                    paraText = lines[j].text;
                    paraY = lines[j].y;
                } else {
                    paraText += " " + lines[j].text;
                }
            }
        }
        if (paraText.length > 5) {
            const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
            chunk.pdfMeta.push(meta);
            chunk.paragraphs.push(meta.text);
        }

        page.cleanup?.();
        if (i % 12 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    try {
        await pdf.destroy?.();
    } catch {
        // Ignore cleanup failures from PDF.js.
    }
    await dispose();

    return {
        title: base.title,
        author: base.author,
        totalPages: base.totalPages,
        chunks: [...chunkMap.values()].sort((a, b) => a.startPage - b.startPage),
    };
}
