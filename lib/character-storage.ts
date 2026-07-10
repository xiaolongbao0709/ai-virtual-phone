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

// 鈹€鈹€ Read Cache (invalidated on writes) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
let _charsCache: Character[] | null = null;

// 鈹€鈹€ localStorage CRUD 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

// 鈹€鈹€ JSON import/export 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

    // Helper: validate avatar 鈥?only accept data-URLs and http(s) URLs
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

    return {
      name: String(src.name ?? ""),
      persona: String(src.description ?? src.persona ?? ""),
      avatar: validAvatar(src.avatar),
      personality: typeof src.personality === "string" && src.personality.trim() ? src.personality : undefined,
      tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
      wechatID: typeof src.wechatID === "string" && src.wechatID.trim() ? src.wechatID : undefined,
      timeZone: normalizeTimeZone(src.timeZone ?? src.timezone ?? src.time_zone),
    };
  } catch (e) {
    if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) throw e;
    return null;
  }
}

// 鈹€鈹€ PNG import/export 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
          // tEXt 鏂囨湰鏄?latin1 缂栫爜
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
/**
 * Parse a SillyTavern V2 character card from a PNG buffer.
 * SillyTavern cards store character data in a `chara` tEXt chunk.
 * V2 format: JSON with `data` field containing character info.
 */
export function parseSillyTavernCharacterFromPng(
  buffer: ArrayBuffer
): CharacterImportData | null {
  const u8 = new Uint8Array(buffer);
  const charaBase64 = readPngTextChunk(u8, "chara");
  if (!charaBase64) return null;

  try {
    const jsonStr = decodeURIComponent(escape(atob(charaBase64)));
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;

    // V2 format: data field contains the actual character
    const data = (typeof obj.data === "object" && obj.data !== null)
      ? obj.data as Record<string, unknown>
      : obj;
    const specVersion = obj.spec ?? obj.spec_version ?? "v1";

    // SillyTavern cards naturally contain greeting/first_mes fields - skip the check

    // Helper: validate avatar
    function validAvatar(v: unknown): string | null {
      if (typeof v !== "string" || !v.trim()) return null;
      const s = v.trim();
      if (s === "none") return null;
      if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) return s;
      return null;
    }

    // Extract avatar from the PNG image data if the card embeds it
    let avatarUrl: string | null = validAvatar(data.avatar);
    if (!avatarUrl) {
      // Try extracting avatar from the PNG itself (SillyTavern often stores the card image as the avatar)
      avatarUrl = pngToDataUrl(u8);
    }

    const name = String(data.name ?? obj.name ?? "");
    const description = String(data.description ?? obj.description ?? "");
    const personality = String(data.personality ?? obj.personality ?? "");

    return {
      name: name.trim() || "Imported Character",
      persona: [description, personality].filter(Boolean).join("\n\n"),
      avatar: avatarUrl,
      personality: personality || undefined,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      wechatID: undefined,
      timeZone: undefined,
    };
  } catch (e) {
    if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) throw e;
    return null;
  }
}

/**
 * Try to detect if a PNG buffer contains a SillyTavern character card
 * (has a `chara` tEXt chunk).
 */
export function isSillyTavernCharacterCard(buffer: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buffer);
  return readPngTextChunk(u8, "chara") !== null;
}

/**
 * Convert the first frame of a PNG to a data URL for use as avatar.
 */
function pngToDataUrl(u8: Uint8Array): string {
  const blob = new Blob([u8.buffer as ArrayBuffer], { type: "image/png" });
  return URL.createObjectURL(blob);
}

/**
 * Universal character card parser: tries native format first, then SillyTavern.
 */
export function parseCharacterFromAnyPng(
  buffer: ArrayBuffer
): CharacterImportData | null {
  // Try native float format first
  const nativeResult = parseCharacterFromPng(buffer);
  if (nativeResult) return nativeResult;

  // Try SillyTavern format
  return parseSillyTavernCharacterFromPng(buffer);
}


// 鈹€鈹€ CRC32 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
  // base64 鏄函 ASCII锛岀敤 latin1 瀛樺偍
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
  // 鍦?IHDR 涔嬪悗鎻掑叆锛堝亸绉婚噺 = 8绛惧悕 + 4闀垮害 + 4绫诲瀷 + 13鏁版嵁 + 4CRC = 33锛?
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

// 鈹€鈹€ 宸ュ叿鍑芥暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function sanitizeFilename(name: string): string {
  return (name || "瑙掕壊").replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
}

async function triggerDownload(blob: Blob, filename: string): Promise<void> {
  const { downloadFile } = await import("./download-utils");
  await downloadFile(blob, filename);
}
