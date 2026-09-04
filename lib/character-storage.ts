import type { Character, CanvasBgItem } from "./character-types";
import { normalizeTimeZone } from "./character-time";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** Thrown when a character card contains fields unsupported by the current schema */
export const CHAR_BLOCKED_FIELDS = "CHAR_BLOCKED_FIELDS";

const STORAGE_KEY = "ai_phone_characters_v1";
const BG_ITEMS_STORAGE_KEY = "ai_phone_bg_items_v1";
const UNSUPPORTED_CHARACTER_IMPORT_FIELDS = [
  "greeting",
  "first_mes",
  "alternate_greetings",
  "mes_example",
  "scenario",
] as const;
registerKvMigration(STORAGE_KEY);
registerKvMigration(BG_ITEMS_STORAGE_KEY);

// ── Read Cache (invalidated on writes) ──────────
let _charsCache: Character[] | null = null;

// ── localStorage CRUD ────────────────────────────────

export function generateWechatID(): string {
  const prefixes = ["138", "139", "150", "151", "158", "159", "170", "176", "186", "188", "199"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
  return prefix + suffix;
}

export function loadCharacters(): Character[] {
  if (_charsCache) return _charsCache;
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    let needsSave = false;
    const chars = parsed.filter(isValidCharacter).map((raw: Character) => {
      const char = { ...raw } as Character & { greeting?: unknown; alternate_greetings?: unknown };
      if ("greeting" in char) {
        delete char.greeting;
        needsSave = true;
      }
      if ("alternate_greetings" in char) {
        delete char.alternate_greetings;
        needsSave = true;
      }
      if (!char.wechatID) {
        char.wechatID = generateWechatID();
        needsSave = true;
      }
      const normalizedTimeZone = normalizeTimeZone(char.timeZone);
      if (char.timeZone !== normalizedTimeZone) {
        if (normalizedTimeZone) char.timeZone = normalizedTimeZone;
        else delete char.timeZone;
        needsSave = true;
      }
      // Sanitize avatars: only keep data-URLs and http(s) URLs
      if (char.avatar && !char.avatar.startsWith("data:") && !char.avatar.startsWith("http://") && !char.avatar.startsWith("https://")) {
        char.avatar = null;
        needsSave = true;
      }
      return char as Character;
    });

    if (needsSave) {
      setTimeout(() => saveCharacters(chars), 0);
    }
    _charsCache = chars;
    return chars;
  } catch {
    return [];
  }
}

export function saveCharacters(chars: Character[]): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify(chars));
  _charsCache = null;
}

export function loadBackgroundItems(): CanvasBgItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(BG_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidBgItem);
  } catch {
    return [];
  }
}

export function saveBackgroundItems(items: CanvasBgItem[]): void {
  if (typeof window === "undefined") return;
  kvSet(BG_ITEMS_STORAGE_KEY, JSON.stringify(items));
}

function isValidBgItem(x: unknown): x is CanvasBgItem {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as CanvasBgItem).id === "string" &&
    typeof (x as CanvasBgItem).type === "string" &&
    typeof (x as CanvasBgItem).x === "number" &&
    typeof (x as CanvasBgItem).y === "number"
  );
}

function isValidCharacter(x: unknown): x is Character {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Character).id === "string" &&
    typeof (x as Character).name === "string"
  );
}

export function createCharacter(
  data: Omit<Character, "id" | "createdAt" | "updatedAt" | "wechatID"> & { wechatID?: string }
): Character {
  const now = new Date().toISOString();
  return {
    ...data,
    id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    wechatID: data.wechatID || generateWechatID(),
    tags: data.tags || [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── JSON import/export ───────────────────────────────

export function exportCharacterAsJson(char: Character): void {
  const payload = {
    schema: "ai_phone_character",
    schema_version: "1.0",
    name: char.name,
    description: char.persona,
    personality: char.personality || "",
    avatar: char.avatar ?? "none",
    tags: char.tags || [],
    wechatID: char.wechatID || "",
    timeZone: char.timeZone || "",
    polaroidStyle: char.polaroidStyle ?? 0,
    polaroidSize: char.polaroidSize || "random",
    polaroidImageX: char.polaroidImageX ?? 50,
    polaroidImageY: char.polaroidImageY ?? 50,
    polaroidImageZoom: char.polaroidImageZoom ?? 1,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, `${sanitizeFilename(char.name)}.json`);
}

export type CharacterImportData = Omit<
  Character,
  "id" | "createdAt" | "updatedAt"
>;

export function parseCharacterFromJson(
  text: string
): CharacterImportData | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;

    // Helper: validate avatar — only accept data-URLs and http(s) URLs
    function validAvatar(v: unknown): string | null {
      if (typeof v !== "string" || !v.trim()) return null;
      const s = v.trim();
      if (s === "none") return null;
      if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) return s;
      return null;
    }

    const src = (obj.schema === "ai_phone_character" && typeof obj.data === "object" && obj.data !== null)
      ? obj.data as Record<string, unknown>
      : obj;

    if (UNSUPPORTED_CHARACTER_IMPORT_FIELDS.some((field) => field in src || field in obj)) {
      throw new Error(CHAR_BLOCKED_FIELDS);
    }

    const polaroidStyle = typeof src.polaroidStyle === "number" && Number.isFinite(src.polaroidStyle)
      ? Math.max(0, Math.min(4, Math.round(src.polaroidStyle)))
      : undefined;
    const polaroidSize = src.polaroidSize === "small" || src.polaroidSize === "medium" || src.polaroidSize === "large"
      ? src.polaroidSize
      : "random" as const;
    const polaroidImageX = typeof src.polaroidImageX === "number" && Number.isFinite(src.polaroidImageX)
      ? Math.max(0, Math.min(100, src.polaroidImageX))
      : undefined;
    const polaroidImageY = typeof src.polaroidImageY === "number" && Number.isFinite(src.polaroidImageY)
      ? Math.max(0, Math.min(100, src.polaroidImageY))
      : undefined;
    const polaroidImageZoom = typeof src.polaroidImageZoom === "number" && Number.isFinite(src.polaroidImageZoom)
      ? Math.max(1, Math.min(3, src.polaroidImageZoom))
      : undefined;

    return {
      name: String(src.name ?? ""),
      persona: String(src.description ?? src.persona ?? ""),
      avatar: validAvatar(src.avatar),
      personality: typeof src.personality === "string" && src.personality.trim() ? src.personality : undefined,
      tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
      wechatID: typeof src.wechatID === "string" && src.wechatID.trim() ? src.wechatID : undefined,
      timeZone: normalizeTimeZone(src.timeZone ?? src.timezone ?? src.time_zone),
      polaroidStyle,
      polaroidSize,
      polaroidImageX,
      polaroidImageY,
      polaroidImageZoom,
    };
  } catch (e) {
    if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) throw e;
    return null;
  }
}

// ── PNG import/export ────────────────────────────────

function readPngTextChunk(u8: Uint8Array, keyword: string): string | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== sig[i]) return null;
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let offset = 8;

  while (offset + 12 <= u8.length) {
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(
      u8[offset + 4],
      u8[offset + 5],
      u8[offset + 6],
      u8[offset + 7]
    );

    if (type === "tEXt") {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let sep = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
          sep = i;
          break;
        }
      }
      if (sep >= 0) {
        const kw = new TextDecoder().decode(data.subarray(0, sep));
        if (kw === keyword) {
          // tEXt 文本是 latin1 编码
          return new TextDecoder("latin1").decode(data.subarray(sep + 1));
        }
      }
    } else if (type === "iTXt") {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let pos = 0;
      while (pos < data.length && data[pos] !== 0) pos++;
      const kw = new TextDecoder().decode(data.subarray(0, pos));
      if (kw === keyword) {
        pos++; // skip null
        const compressionFlag = data[pos++];
        pos++; // compression method
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // lang tag null
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // translated keyword null
        if (compressionFlag === 0) {
          return new TextDecoder().decode(data.subarray(pos));
        }
      }
    }

    offset += 12 + length;
  }

  return null;
}

export function parseCharacterFromPng(
  buffer: ArrayBuffer
): CharacterImportData | null {
  const u8 = new Uint8Array(buffer);
  const charaBase64 = readPngTextChunk(u8, "ai_phone_character");
  if (!charaBase64) return null;

  try {
    const jsonStr = decodeURIComponent(escape(atob(charaBase64)));
    return parseCharacterFromJson(jsonStr);
  } catch (e) {
    if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) throw e;
    return null;
  }
}

// ── CRC32 ────────────────────────────────────────────

let _crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    _crcTable[n] = c;
  }
  return _crcTable;
}

function crc32(buf: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngTextChunk(keyword: string, text: string): Uint8Array {
  const kwBytes = new TextEncoder().encode(keyword);
  // base64 是纯 ASCII，用 latin1 存储
  const textBytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) textBytes[i] = text.charCodeAt(i);
  const dataLen = kwBytes.length + 1 + textBytes.length;
  const typeBytes = new TextEncoder().encode("tEXt");

  const crcInput = new Uint8Array(4 + dataLen);
  crcInput.set(typeBytes, 0);
  crcInput.set(kwBytes, 4);
  crcInput[4 + kwBytes.length] = 0;
  crcInput.set(textBytes, 4 + kwBytes.length + 1);
  const crcVal = crc32(crcInput);

  const chunk = new Uint8Array(4 + 4 + dataLen + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, dataLen);
  chunk.set(typeBytes, 4);
  chunk.set(kwBytes, 8);
  chunk[8 + kwBytes.length] = 0;
  chunk.set(textBytes, 8 + kwBytes.length + 1);
  dv.setUint32(4 + 4 + dataLen, crcVal);
  return chunk;
}

function injectPngTextChunk(pngBytes: Uint8Array, chunk: Uint8Array): Uint8Array {
  // 在 IHDR 之后插入（偏移量 = 8签名 + 4长度 + 4类型 + 13数据 + 4CRC = 33）
  const insertAt = 33;
  const result = new Uint8Array(pngBytes.length + chunk.length);
  result.set(pngBytes.subarray(0, insertAt), 0);
  result.set(chunk, insertAt);
  result.set(pngBytes.subarray(insertAt), insertAt + chunk.length);
  return result;
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob failed"));
        return;
      }
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, "image/png");
  });
}

function drawInitialsAvatar(ctx: CanvasRenderingContext2D, name: string): void {
  ctx.fillStyle = "#7a6080";
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.arc(200, 200, 185, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 160px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((name ?? "").charAt(0) || "?", 200, 210);
}

async function avatarToPngBytes(avatar: string | null, name: string): Promise<Uint8Array> {
  if (avatar) {
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("No ctx"));
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvasToPngBytes(canvas).then(resolve).catch(reject);
        };
        img.onerror = reject;
        img.src = avatar;
      });
    } catch {
      // Fallback below
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  drawInitialsAvatar(ctx, name);
  return canvasToPngBytes(canvas);
}

export async function exportCharacterAsPng(char: Character): Promise<void> {
  const payload = {
    schema: "ai_phone_character",
    schema_version: "1.0",
    name: char.name,
    description: char.persona,
    personality: char.personality || "",
    avatar: "none",
    tags: char.tags || [],
    wechatID: char.wechatID || "",
    timeZone: char.timeZone || "",
  };
  const jsonStr = JSON.stringify(payload);
  const base64 = btoa(unescape(encodeURIComponent(jsonStr)));

  const pngBytes = await avatarToPngBytes(char.avatar, char.name);
  const textChunk = buildPngTextChunk("ai_phone_character", base64);
  const finalBytes = injectPngTextChunk(pngBytes, textChunk);

  const blob = new Blob([finalBytes.buffer as ArrayBuffer], { type: "image/png" });
  triggerDownload(blob, `${sanitizeFilename(char.name)}.png`);
}

// ── 工具函数 ─────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return (name || "角色").replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
}

async function triggerDownload(blob: Blob, filename: string): Promise<void> {
  const { downloadFile } = await import("./download-utils");
  await downloadFile(blob, filename);
}
