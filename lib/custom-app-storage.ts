import { hydrateKvDb, kvGet, kvKeysWithPrefix, kvRemove, kvSet, kvSetAsync, registerDynamicPrefix, registerKvMigration } from "./kv-db";
import { deleteMediaRef } from "./media-cache-storage";
import type {
  CustomAppAsset,
  CustomAppChatCardAction,
  CustomAppChatDirective,
  CustomAppChatInputTool,
  CustomAppChatMessageAction,
  CustomAppChatPlusAction,
  CustomAppChatScene,
  CustomAppEventSubscription,
  CustomAppExtensionEntry,
  CustomAppExtensions,
  CustomAppManifest,
  CustomAppNetworkPolicy,
  CustomAppPermission,
  CustomAppPromptProfile,
  CustomAppResourceDeclarations,
  CustomAppToolDefinition,
  CustomAppUiExtensions,
  InstalledCustomApp,
} from "./custom-app-types";

const CUSTOM_APPS_KEY = "ai_phone_custom_apps_v1";
const CUSTOM_APP_DATA_PREFIX = "ai_phone_custom_app_data_v1:";
const CUSTOM_APP_TIMELINE_PREFIX = "ai_phone_custom_app_timeline_v1:";

export const CUSTOM_APPS_UPDATED_EVENT = "ai-phone-custom-apps-updated";
/** 请求桌面为某个已安装应用摆放图标（detail: { appId }）。桌面 shell 监听并落位。 */
export const CUSTOM_APP_PLACE_DESKTOP_EVENT = "ai-phone-custom-app-place-desktop";
const GENERIC_PRIMARY_TAGS = new Set(["chat", "text", "custom_app", "group_chat"]);

registerKvMigration(CUSTOM_APPS_KEY);
registerDynamicPrefix(CUSTOM_APP_DATA_PREFIX);
registerDynamicPrefix(CUSTOM_APP_TIMELINE_PREFIX);

const MAX_TEXT_LENGTH = 1800000;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

export type CustomAppTimelineEntry = {
  id: string;
  appId: string;
  appName: string;
  characterId: string;
  summary: string;
  detail?: string;
  appLabel?: string;
  createdAt: string;
  data?: Record<string, unknown>;
};

const CUSTOM_APP_TIMELINE_EVENT_ID_KEYS = ["appEventId", "eventId", "relatedEventId", "orderId"];

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string {
  return cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomIdSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 12);
}

export function generateCustomAppRuntimeId(seed?: string): string {
  const suffix = randomIdSuffix();
  const base = cleanId(seed || "").slice(0, Math.max(1, 70 - suffix.length)) || "custom-app";
  return `app_${base}_${suffix}`;
}

export function normalizeCustomAppManifestId(value: unknown, fallback?: unknown): string {
  return cleanId(value) || cleanId(fallback) || "custom-app";
}

function cleanRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getCustomAppTimelineEventId(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  for (const key of CUSTOM_APP_TIMELINE_EVENT_ID_KEYS) {
    const eventId = cleanText(value[key], 160);
    if (eventId) return eventId;
  }
  return "";
}

function stringArray(value: unknown, maxLength = 160, limit = 50): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, limit);
  const text = cleanText(value, maxLength);
  return text ? [text] : [];
}

function addPrimaryTag(target: Set<string>, tags: unknown): void {
  const primary = stringArray(tags, 80, 30)
    .map(tag => tag.toLowerCase())
    .find(tag => tag && !GENERIC_PRIMARY_TAGS.has(tag));
  if (primary) target.add(primary);
}

function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "";
  const header = dataUrl.slice(0, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  if (header.includes(";base64")) {
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function addDeclarationPrimaryTags(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addDeclarationPrimaryTags(target, item);
    return;
  }
  const record = asRecord(value);
  addPrimaryTag(target, record.tags ?? record.appTags);
  for (const key of ["presets", "regexes", "rules", "prompts"]) {
    const items = record[key];
    if (Array.isArray(items)) {
      for (const item of items) addDeclarationPrimaryTags(target, item);
    }
  }
}

function normalizeConflictName(value: unknown): string {
  return cleanText(value, 80).replace(/\s+/g, " ").toLowerCase();
}

export function getCustomAppPrimaryTags(app: Pick<InstalledCustomApp, "manifest"> & Partial<Pick<InstalledCustomApp, "assets">>): string[] {
  const tags = new Set<string>();
  addPrimaryTag(tags, app.manifest.primaryTags);
  const chat = app.manifest.extensions?.chat ?? app.manifest.chatExtensions;
  for (const scene of chat?.scenes ?? []) {
    addPrimaryTag(tags, scene.tags ?? scene.appTags ?? scene.tag);
  }
  for (const directive of chat?.directives ?? app.manifest.chatDirectives ?? []) {
    addPrimaryTag(tags, directive.tags);
  }
  for (const action of chat?.plusActions ?? app.manifest.chatPlusActions ?? []) {
    addPrimaryTag(tags, action.tags);
  }
  for (const profile of app.manifest.extensions?.prompt?.profiles ?? app.manifest.promptProfiles ?? []) {
    addPrimaryTag(tags, profile.appTags);
  }
  for (const filename of ["presets.json", "regex.json", "regexes.json"]) {
    const asset = app.assets?.[filename]
      ?? Object.values(app.assets ?? {}).find(item => item.path.toLowerCase() === filename);
    if (!asset) continue;
    try {
      addDeclarationPrimaryTags(tags, JSON.parse(dataUrlToText(asset.dataUrl)));
    } catch {
      // Invalid declaration files are reported by the registration path; conflict checks just ignore them.
    }
  }
  return Array.from(tags);
}

export function getCustomAppInstallConflict(
  app: Pick<InstalledCustomApp, "id" | "name" | "manifest">,
  installed: Array<Pick<InstalledCustomApp, "id" | "name" | "manifest">> = loadInstalledCustomApps(),
): { type: "name" | "tag"; app: Pick<InstalledCustomApp, "id" | "name">; tag?: string } | null {
  const appName = normalizeConflictName(app.name);
  const appTags = new Set(getCustomAppPrimaryTags(app));
  for (const other of installed) {
    if (other.id === app.id) continue;
    if (appName && normalizeConflictName(other.name) === appName) {
      return { type: "name", app: other };
    }
    if (appTags.size > 0) {
      const otherTags = getCustomAppPrimaryTags(other);
      const overlap = otherTags.find(tag => appTags.has(tag));
      if (overlap) return { type: "tag", app: other, tag: overlap };
    }
  }
  return null;
}

function formatInstallConflict(conflict: NonNullable<ReturnType<typeof getCustomAppInstallConflict>>): string {
  if (conflict.type === "name") {
    return `已安装同名 APP「${conflict.app.name}」。想更新它请用「创作 → 本地测试」里的「换包」原地替换（数据保留），或先卸载旧应用、更换应用名称。`;
  }
  return `主标签「${conflict.tag}」已被 APP「${conflict.app.name}」使用，请更换该 APP 的主标签。`;
}

function normalizePermission(value: unknown): CustomAppPermission | null {
  const text = cleanText(value, 80);
  const allowed = new Set<CustomAppPermission>([
    "app.data.read",
    "app.data.write",
    "app.assets.read",
    "app.manifest.read",
    "ai.generate",
    "ai.generateImage",
    "ai.chat",
    "ai.embed",
    "ai.classify",
    "network.fetch",
    "voice.tts",
    "voice.stt",
    "voice.clone",
    "voice.readProfiles",
    "user.profile.read",
    "user.persona.read",
    "user.preferences.read",
    "chat.read",
    "chat.read.background",
    "chat.write",
    "chat.sendMessage",
    "chat.sendCard",
    "chat.requestReply",
    "chat.contacts.write",
    "chat.tools",
    "characters.read",
    "characters.state.read",
    "characters.state.write",
    "characters.relations.read",
    "calendar.read",
    "calendar.write",
    "world.read",
    "world.write",
    "world.activate",
    "memory.readCore",
    "memory.readLongTerm",
    "memory.readShortTerm",
    "memory.search",
    "memory.write",
    "memory.suggest",
    "media.pick",
    "media.save",
    "geo.read",
    "geo.watch",
    "notifications.read",
    "notifications.write",
    "tasks.schedule",
    "ui.toast",
    "ui.notification",
    "ui.sms",
    "ui.call",
    "wallet.read",
    "wallet.pay",
    "online.play",
  ]);
  return allowed.has(text as CustomAppPermission) ? text as CustomAppPermission : null;
}

function normalizeExtensionEntry(value: unknown): CustomAppExtensionEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label ?? record.name ?? record.title, 40);
  if (!label) return null;
  const id = cleanId(record.id ?? label);
  if (!id) return null;
  return {
    id,
    label,
    description: cleanText(record.description ?? record.desc, 300) || undefined,
    icon: cleanText(record.icon, 120) || undefined,
    entry: cleanText(record.entry ?? record.mode ?? record.route, 120) || undefined,
    data: cleanRecord(record.data),
  };
}

function normalizeChatDirective(value: unknown): CustomAppChatDirective | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label ?? record.name, 24).replace(/[\[\]：:\n\r]/g, "");
  if (!label) return null;
  const id = cleanId(record.id ?? label);
  const rawActions = Array.isArray(record.actions) ? record.actions : [];
  const actions = rawActions.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const action = item as Record<string, unknown>;
    const actionLabel = cleanText(action.label ?? action.text, 24);
    if (!actionLabel) return null;
    return {
      label: actionLabel,
      style: cleanText(action.style, 24) || undefined,
    };
  }).filter(Boolean).slice(0, 3) as CustomAppChatDirective["actions"];
  return {
    id: id || cleanId(label),
    label,
    syntax: cleanText(record.syntax, 120) || `[${label}:内容]`,
    description: cleanText(record.description ?? record.desc, 500) || undefined,
    card: cleanRecord(record.card ?? record.layout),
    title: cleanText(record.title, 80) || undefined,
    appLabel: cleanText(record.appLabel, 60) || undefined,
    status: cleanText(record.status, 40) || undefined,
    tone: cleanText(record.tone, 40) || undefined,
    accentColor: cleanText(record.accentColor, 40) || undefined,
    sceneId: cleanText(record.sceneId ?? record.scene, 80) || undefined,
    sceneTag: cleanText(record.sceneTag, 120) || undefined,
    tags: stringArray(record.tags ?? record.appTags, 120, 30),
    actions: actions && actions.length > 0 ? actions : undefined,
  };
}

function normalizeChatPlusAction(value: unknown): CustomAppChatPlusAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label ?? record.name, 24);
  if (!label) return null;
  const id = cleanId(record.id ?? label);
  if (!id) return null;
  const rawPresentation = cleanText(record.presentation ?? record.display ?? record.openMode, 40);
  const presentation = rawPresentation === "modal"
    || rawPresentation === "fullscreen"
    || rawPresentation === "app"
    || rawPresentation === "none"
    ? rawPresentation
    : rawPresentation === "sheet" || rawPresentation === "bottom_sheet" || rawPresentation === "bottom-sheet"
      ? "panel"
      : rawPresentation === "panel"
        ? "panel"
        : undefined;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  return {
    id,
    label,
    description: cleanText(record.description ?? record.desc, 240) || undefined,
    icon: cleanText(record.icon, 80) || undefined,
    entry: cleanText(record.entry ?? record.mode ?? record.route, 80) || undefined,
    presentation,
    panelHeight: cleanText(record.panelHeight ?? record.height, 40) || undefined,
    data,
    directiveId: cleanText(record.directiveId ?? record.directive, 80) || undefined,
    sceneId: cleanText(record.sceneId ?? record.scene, 80) || undefined,
    sceneTag: cleanText(record.sceneTag, 120) || undefined,
    tags: stringArray(record.tags ?? record.appTags, 120, 30),
  };
}

function normalizeChatScene(value: unknown): CustomAppChatScene | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label ?? record.name ?? record.id, 40);
  if (!label) return null;
  const id = cleanId(record.id ?? label) || cleanText(record.id ?? label, 80);
  if (!id) return null;
  return {
    id,
    label,
    description: cleanText(record.description ?? record.desc, 240) || undefined,
    icon: cleanText(record.icon, 80) || undefined,
    entry: cleanText(record.entry ?? record.mode ?? record.route, 120) || undefined,
    data: cleanRecord(record.data),
    tag: cleanText(record.tag ?? record.sceneTag, 120) || undefined,
    tags: stringArray(record.tags, 120, 30),
    appTags: stringArray(record.appTags, 120, 30),
    directiveId: cleanText(record.directiveId ?? record.directive, 80) || undefined,
    actionId: cleanText(record.actionId ?? record.action, 80) || undefined,
  };
}

function normalizeChatMessageAction(value: unknown): CustomAppChatMessageAction | null {
  const base = normalizeExtensionEntry(value);
  if (!base || !value || typeof value !== "object" || Array.isArray(value)) return base;
  const record = value as Record<string, unknown>;
  return {
    ...base,
    mediaTypes: stringArray(record.mediaTypes ?? record.mediaType, 40, 20),
    roles: stringArray(record.roles ?? record.role, 40, 10),
  };
}

function normalizeChatCardAction(value: unknown): CustomAppChatCardAction | null {
  const base = normalizeExtensionEntry(value);
  if (!base || !value || typeof value !== "object" || Array.isArray(value)) return base;
  const record = value as Record<string, unknown>;
  return {
    ...base,
    directiveId: cleanText(record.directiveId ?? record.directive, 80) || undefined,
    cardTypes: stringArray(record.cardTypes ?? record.cardType, 60, 20),
  };
}

function normalizeChatInputTool(value: unknown): CustomAppChatInputTool | null {
  const base = normalizeExtensionEntry(value);
  if (!base || !value || typeof value !== "object" || Array.isArray(value)) return base;
  const record = value as Record<string, unknown>;
  return {
    ...base,
    insertText: cleanText(record.insertText, 500) || undefined,
  };
}

function normalizeToolDefinition(value: unknown): CustomAppToolDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = cleanId(record.id ?? record.name);
  const name = cleanText(record.name ?? record.label ?? record.id, 80);
  if (!id || !name) return null;
  const timeoutMs = Number(record.timeoutMs);
  return {
    id,
    name,
    description: cleanText(record.description ?? record.desc, 500) || undefined,
    parameterSchema: cleanRecord(record.parameterSchema ?? record.parameters ?? record.schema),
    usageGuide: cleanText(record.usageGuide ?? record.instructions ?? record.guide, 2000) || undefined,
    visibility: record.visibility === "shared" ? "shared" : "private",
    handler: cleanText(record.handler, 120) || undefined,
    entry: cleanText(record.entry, 120) || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30 * 60_000) : undefined,
    enabled: record.enabled === false ? false : undefined,
    actions: Array.isArray(record.actions)
      ? record.actions
        .slice(0, 12)
        .map(item => cleanRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item && Object.keys(item).length > 0))
      : undefined,
    resultTemplate: cleanText(record.resultTemplate ?? record.result, 2000) || undefined,
  };
}

function normalizePromptProfile(value: unknown): CustomAppPromptProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label ?? record.name ?? record.id, 60);
  const id = cleanId(record.id ?? label);
  if (!id || !label) return null;
  const history = cleanText(record.history, 40);
  const output = cleanText(record.output, 40);
  return {
    id,
    label,
    description: cleanText(record.description ?? record.desc, 500) || undefined,
    include: stringArray(record.include ?? record.includes, 80, 80),
    exclude: stringArray(record.exclude ?? record.excludes, 80, 80),
    history: history === "none" || history === "current_session" || history === "recent" || history === "default"
      ? history
      : undefined,
    output: output === "plain_text" || output === "json" || output === "chat" ? output : undefined,
    appTags: stringArray(record.appTags ?? record.tags, 80, 30),
    enableWorldBooks: typeof record.enableWorldBooks === "boolean" ? record.enableWorldBooks : undefined,
    enableRegexes: typeof record.enableRegexes === "boolean" ? record.enableRegexes : undefined,
  };
}

function normalizeResources(value: unknown): CustomAppResourceDeclarations | undefined {
  const record = asRecord(value);
  const resources: CustomAppResourceDeclarations = {
    presets: stringArray(record.presets, 220, 20),
    regexes: stringArray(record.regexes, 220, 20),
    worldBooks: stringArray(record.worldBooks ?? record.worldbooks, 220, 20),
    bindings: stringArray(record.bindings, 220, 20),
    tools: stringArray(record.tools, 220, 20),
    voices: stringArray(record.voices, 220, 20),
    assets: stringArray(record.assets, 220, 200),
  };
  const hasAny = Object.values(resources).some(items => Array.isArray(items) && items.length > 0);
  return hasAny ? resources : undefined;
}

function normalizeEventSubscription(value: unknown): CustomAppEventSubscription | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const event = cleanText(value, 120);
    return event ? { event } : null;
  }
  const record = value as Record<string, unknown>;
  const event = cleanText(record.event ?? record.type ?? record.name, 120);
  if (!event) return null;
  const timeoutMs = Number(record.timeoutMs);
  return {
    event,
    entry: cleanText(record.entry ?? record.handler, 120) || undefined,
    background: record.background === true,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30 * 60_000) : undefined,
    description: cleanText(record.description ?? record.desc, 300) || undefined,
  };
}

function normalizeNetworkPolicy(value: unknown): CustomAppNetworkPolicy | undefined {
  const record = asRecord(value);
  const allowedDomains = stringArray(record.allowedDomains ?? record.domains ?? record.allowlist, 120, 50);
  const mode = cleanText(record.mode ?? record.transport, 20).toLowerCase();
  return allowedDomains.length > 0
    ? {
      allowedDomains,
      mode: mode === "proxy" ? "proxy" : mode === "direct" ? "direct" : undefined,
    }
    : undefined;
}

export function normalizeCustomAppManifest(raw: unknown): CustomAppManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("manifest.json 必须是 JSON 对象。");
  }
  const record = raw as Record<string, unknown>;
  const name = cleanText(record.name, 40);
  if (!name) throw new Error("manifest.json 缺少 name。");
  const id = normalizeCustomAppManifestId(record.id, name);
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.map(normalizePermission).filter(Boolean) as CustomAppPermission[]
    : [];
  const extensionsRecord = asRecord(record.extensions);
  const legacyChatExtensions = asRecord(record.chatExtensions);
  const canonicalChatExtensions = asRecord(extensionsRecord.chat);
  const chatExtensions = {
    ...legacyChatExtensions,
    ...canonicalChatExtensions,
  };
  const uiExtensions = asRecord(extensionsRecord.ui);
  const promptExtension = asRecord(extensionsRecord.prompt);
  const rawChatDirectives = Array.isArray(canonicalChatExtensions.directives)
    ? canonicalChatExtensions.directives as unknown[]
    : [
      ...(Array.isArray(record.chatDirectives) ? record.chatDirectives : []),
      ...(Array.isArray(legacyChatExtensions.directives) ? legacyChatExtensions.directives : []),
    ];
  const chatDirectives = rawChatDirectives.length > 0
    ? rawChatDirectives.map(normalizeChatDirective).filter(Boolean) as CustomAppChatDirective[]
    : [];
  const rawChatPlusActions = Array.isArray(canonicalChatExtensions.plusActions)
    ? canonicalChatExtensions.plusActions as unknown[]
    : [
      ...(Array.isArray(record.chatPlusActions) ? record.chatPlusActions : []),
      ...(Array.isArray(legacyChatExtensions.plusActions) ? legacyChatExtensions.plusActions : []),
    ];
  const chatPlusActions = rawChatPlusActions.length > 0
    ? rawChatPlusActions.map(normalizeChatPlusAction).filter(Boolean) as CustomAppChatPlusAction[]
    : [];
  const rawChatScenes = Array.isArray(canonicalChatExtensions.scenes)
    ? canonicalChatExtensions.scenes as unknown[]
    : Array.isArray(legacyChatExtensions.scenes)
      ? legacyChatExtensions.scenes as unknown[]
      : [];
  const chatScenes = rawChatScenes.length > 0
    ? rawChatScenes.map(normalizeChatScene).filter(Boolean) as CustomAppChatScene[]
    : [];
  const messageActions = Array.isArray(chatExtensions.messageActions)
    ? chatExtensions.messageActions.map(normalizeChatMessageAction).filter(Boolean) as CustomAppChatMessageAction[]
    : [];
  const cardActions = Array.isArray(chatExtensions.cardActions)
    ? chatExtensions.cardActions.map(normalizeChatCardAction).filter(Boolean) as CustomAppChatCardAction[]
    : [];
  const inputTools = Array.isArray(chatExtensions.inputTools)
    ? chatExtensions.inputTools.map(normalizeChatInputTool).filter(Boolean) as CustomAppChatInputTool[]
    : [];
  const canonicalTools = Array.isArray(extensionsRecord.tools)
    ? extensionsRecord.tools as unknown[]
    : Array.isArray(chatExtensions.tools)
      ? chatExtensions.tools as unknown[]
      : [];
  const tools = canonicalTools.length > 0
    ? canonicalTools.map(normalizeToolDefinition).filter(Boolean) as CustomAppToolDefinition[]
    : [];
  const homeWidgets = Array.isArray(uiExtensions.homeWidgets)
    ? uiExtensions.homeWidgets.map(normalizeExtensionEntry).filter(Boolean) as CustomAppExtensionEntry[]
    : [];
  const characterTabs = Array.isArray(uiExtensions.characterTabs)
    ? uiExtensions.characterTabs.map(normalizeExtensionEntry).filter(Boolean) as CustomAppExtensionEntry[]
    : [];
  const settingsPanels = Array.isArray(uiExtensions.settingsPanels)
    ? uiExtensions.settingsPanels.map(normalizeExtensionEntry).filter(Boolean) as CustomAppExtensionEntry[]
    : [];
  const shareTargets = Array.isArray(uiExtensions.shareTargets)
    ? uiExtensions.shareTargets.map(normalizeExtensionEntry).filter(Boolean) as CustomAppExtensionEntry[]
    : [];
  const searchProviders = Array.isArray(uiExtensions.searchProviders)
    ? uiExtensions.searchProviders.map(normalizeExtensionEntry).filter(Boolean) as CustomAppExtensionEntry[]
    : [];
  const rawPromptProfiles = Array.isArray(promptExtension.profiles)
    ? promptExtension.profiles as unknown[]
    : Array.isArray(record.promptProfiles)
      ? record.promptProfiles
      : [];
  const promptProfiles = rawPromptProfiles.map(normalizePromptProfile).filter(Boolean) as CustomAppPromptProfile[];
  const rawEvents = Array.isArray(extensionsRecord.events)
    ? extensionsRecord.events as unknown[]
    : Array.isArray(record.events)
      ? record.events
      : [];
  const events = rawEvents.map(normalizeEventSubscription).filter(Boolean) as CustomAppEventSubscription[];
  const chatBlock = chatScenes.length > 0
    || chatDirectives.length > 0
    || chatPlusActions.length > 0
    || messageActions.length > 0
    || cardActions.length > 0
    || inputTools.length > 0
    || tools.length > 0
    ? {
      scenes: chatScenes.length > 0 ? chatScenes : undefined,
      directives: chatDirectives.length > 0 ? chatDirectives : undefined,
      plusActions: chatPlusActions.length > 0 ? chatPlusActions : undefined,
      messageActions: messageActions.length > 0 ? messageActions : undefined,
      cardActions: cardActions.length > 0 ? cardActions : undefined,
      inputTools: inputTools.length > 0 ? inputTools : undefined,
      tools: tools.length > 0 ? tools : undefined,
    }
    : undefined;
  const uiBlock: CustomAppUiExtensions | undefined = homeWidgets.length > 0
    || characterTabs.length > 0
    || settingsPanels.length > 0
    || shareTargets.length > 0
    || searchProviders.length > 0
    ? {
      homeWidgets: homeWidgets.length > 0 ? homeWidgets : undefined,
      characterTabs: characterTabs.length > 0 ? characterTabs : undefined,
      settingsPanels: settingsPanels.length > 0 ? settingsPanels : undefined,
      shareTargets: shareTargets.length > 0 ? shareTargets : undefined,
      searchProviders: searchProviders.length > 0 ? searchProviders : undefined,
    }
    : undefined;
  const extensions: CustomAppExtensions | undefined = chatBlock || uiBlock || promptProfiles.length > 0 || tools.length > 0 || events.length > 0
    ? {
      chat: chatBlock,
      ui: uiBlock,
      prompt: promptProfiles.length > 0 ? { profiles: promptProfiles } : undefined,
      tools: tools.length > 0 ? tools : undefined,
      events: events.length > 0 ? events : undefined,
    }
    : undefined;
  const resources = normalizeResources(record.resources);
  const network = normalizeNetworkPolicy(record.network);
  return {
    id,
    name,
    version: cleanText(record.version, 24) || "1.0.0",
    sdkVersion: cleanText(record.sdkVersion, 24) || undefined,
    author: cleanText(record.author, 40) || undefined,
    description: cleanText(record.description, 500) || undefined,
    icon: cleanText(record.icon, 160) || "icon.png",
    entry: cleanText(record.entry, 160) || "index.html",
    permissions,
    resources,
    primaryTags: stringArray(record.primaryTags, 80, 30),
    extensions,
    promptProfiles: promptProfiles.length > 0 ? promptProfiles : undefined,
    events: events.length > 0 ? events : undefined,
    network,
    slots: record.slots && typeof record.slots === "object" ? record.slots as CustomAppManifest["slots"] : undefined,
    chatDirectives: chatDirectives.length > 0 ? chatDirectives : undefined,
    chatPlusActions: chatPlusActions.length > 0 ? chatPlusActions : undefined,
    chatExtensions: chatBlock,
    triggers: Array.isArray(record.triggers) ? record.triggers.slice(0, 20) as Array<Record<string, unknown>> : undefined,
  };
}

function normalizeAssetPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".css")) return "text/css;charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (lower.endsWith(".json")) return "application/json;charset=utf-8";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html;charset=utf-8";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fileBlobToDataUrl(file: Blob, mime: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bytesToDataUrl(bytes, mime);
}

async function readZipAsset(file: { async: (type: "uint8array") => Promise<Uint8Array> }, path: string): Promise<CustomAppAsset | null> {
  const bytes = await file.async("uint8array");
  if (bytes.byteLength > MAX_ASSET_BYTES) return null;
  const mime = guessMime(path);
  return {
    path,
    mime,
    dataUrl: bytesToDataUrl(bytes, mime),
  };
}

function normalizeInstalledApp(raw: unknown): InstalledCustomApp | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  try {
    const manifest = normalizeCustomAppManifest(record.manifest);
    const id = cleanId(record.id) || manifest.id;
    const entryHtml = cleanText(record.entryHtml, MAX_TEXT_LENGTH);
    if (!id || !entryHtml) return null;
    const assets: Record<string, CustomAppAsset> = {};
    if (record.assets && typeof record.assets === "object") {
      for (const [key, value] of Object.entries(record.assets as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const asset = value as Record<string, unknown>;
        const path = normalizeAssetPath(cleanText(asset.path ?? key, 220));
        const dataUrl = cleanText(asset.dataUrl, MAX_ASSET_BYTES * 2);
        if (!path || !dataUrl.startsWith("data:")) continue;
        assets[path] = {
          path,
          mime: cleanText(asset.mime, 80) || guessMime(path),
          dataUrl,
        };
      }
    }
    return {
      id,
      name: cleanText(record.name, 40) || manifest.name,
      version: cleanText(record.version, 24) || manifest.version,
      author: cleanText(record.author, 40) || manifest.author,
      description: cleanText(record.description, 500) || manifest.description,
      iconDataUrl: cleanText(record.iconDataUrl, MAX_ASSET_BYTES * 2) || undefined,
      entryHtml,
      permissions: Array.isArray(record.permissions)
        ? record.permissions.map(normalizePermission).filter(Boolean) as CustomAppPermission[]
        : manifest.permissions ?? [],
      manifest,
      assets,
      installedAt: cleanText(record.installedAt, 80) || new Date().toISOString(),
      updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
      marketItemId: cleanText(record.marketItemId, 160) || undefined,
      hasUnpublishedChanges: record.hasUnpublishedChanges === true ? true : undefined,
    };
  } catch {
    return null;
  }
}

function emitUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CUSTOM_APPS_UPDATED_EVENT));
  }
}

export function loadInstalledCustomApps(): InstalledCustomApp[] {
  const raw = kvGet(CUSTOM_APPS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(normalizeInstalledApp).filter(Boolean) as InstalledCustomApp[]
      : [];
  } catch {
    return [];
  }
}

export function saveInstalledCustomApps(apps: InstalledCustomApp[], notify = true): InstalledCustomApp[] {
  const normalized = apps.map(normalizeInstalledApp).filter(Boolean) as InstalledCustomApp[];
  kvSet(CUSTOM_APPS_KEY, JSON.stringify(normalized));
  if (notify) emitUpdated();
  return normalized;
}

export async function saveInstalledCustomAppsAsync(apps: InstalledCustomApp[], notify = true): Promise<InstalledCustomApp[]> {
  await hydrateKvDb();
  return saveInstalledCustomApps(apps, notify);
}

export function getInstalledCustomApp(appId: string): InstalledCustomApp | null {
  const id = cleanId(appId);
  return loadInstalledCustomApps().find(app => app.id === id) ?? null;
}

export function uninstallCustomApp(appId: string, options: { deleteData?: boolean } = {}): void {
  const id = cleanId(appId);
  saveInstalledCustomApps(loadInstalledCustomApps().filter(app => app.id !== id));
  if (options.deleteData) {
    // 先清媒体库 Blob(引用登记在 __media_refs 集合里),再删集合 key
    try {
      for (const row of readCustomAppCollection(id, "__media_refs")) {
        void deleteMediaRef(String(row.id));
      }
    } catch { /* 媒体清理失败不阻断卸载 */ }
    kvRemove(`${CUSTOM_APP_DATA_PREFIX}${id}`);
    for (const key of kvKeysWithPrefix(`${CUSTOM_APP_DATA_PREFIX}${id}/`)) kvRemove(key);
    kvRemove(`${CUSTOM_APP_TIMELINE_PREFIX}${id}`);
  }
}

export async function uninstallCustomAppAsync(appId: string, options: { deleteData?: boolean } = {}): Promise<void> {
  await hydrateKvDb();
  uninstallCustomApp(appId, options);
}

// APP 数据按集合分 key 存储。旧版把一个 APP 的全部集合塞进一个大 JSON,
// 任何一次小写入(比如改一条计数)都要整体 parse/stringify;当某个集合里有
// 成批的音频/图片 dataURL 时,这个内存峰值足以让 iOS 杀掉页面进程
// (表现为 PWA 崩溃后恢复到 about:srcdoc 空白页)。
function customAppCollectionKey(appId: string, collection: string): string {
  return `${CUSTOM_APP_DATA_PREFIX}${cleanId(appId)}/${collection}`;
}

// 首次访问时把旧版整包数据拆成按集合的 key。
// 崩溃安全铁律:旧整包只有在"新 key 已确认落盘 IndexedDB"之后才能删——
// kvSet 落盘是异步的,先删后写遇上页面崩溃(大 JSON 解析本身就是崩溃诱因)
// 会把用户数据整个丢掉。判断"已落盘"的依据:hydrateKvDb 启动时把 IndexedDB
// 全量灌进缓存,所以"本会话开始时缓存里就有的 key"一定是持久化过的。
const _migrationCheckedApps = new Set<string>();

function migrateLegacyCustomAppData(appId: string): void {
  const id = cleanId(appId);
  if (_migrationCheckedApps.has(id)) return;
  _migrationCheckedApps.add(id);
  const legacyKey = `${CUSTOM_APP_DATA_PREFIX}${id}`;
  const raw = kvGet(legacyKey);
  if (!raw) return;
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch { /* 旧数据解析失败:保留原 key 以便人工抢救,读取按空处理 */ return; }
  const pending: Array<Promise<void>> = [];
  let allPresent = true;
  for (const [collection, rows] of Object.entries(parsed)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const key = customAppCollectionKey(id, collection);
    if (kvGet(key) !== null) continue; // 上个会话已迁移过(或已有更新数据),不许旧快照覆盖
    allPresent = false;
    pending.push(kvSetAsync(key, JSON.stringify(rows)));
  }
  if (allPresent) {
    // 所有集合在会话开始时就已持久化 → 旧包可以安全删除
    kvRemove(legacyKey);
    return;
  }
  // 本会话刚写的 key 落盘成败未知,旧包保留;下个会话核对通过后才删。
  void Promise.all(pending).catch(() => { /* 落盘失败:旧包还在,下个会话重试 */ });
}

export function readCustomAppCollection(appId: string, collection: string): Array<Record<string, unknown>> {
  migrateLegacyCustomAppData(appId);
  const raw = kvGet(customAppCollectionKey(appId, collection));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

export function writeCustomAppCollection(appId: string, collection: string, rows: Array<Record<string, unknown>>): void {
  migrateLegacyCustomAppData(appId);
  kvSet(customAppCollectionKey(appId, collection), JSON.stringify(rows));
}

function loadCustomAppTimelineForApp(appId: string): CustomAppTimelineEntry[] {
  const id = cleanId(appId);
  const raw = kvGet(`${CUSTOM_APP_TIMELINE_PREFIX}${id}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const summary = cleanText(record.summary, 2000);
      const characterId = cleanText(record.characterId, 160);
      if (!summary || !characterId) return null;
      return {
        id: cleanText(record.id, 160) || `tl_${Date.now().toString(36)}`,
        appId: cleanId(record.appId) || id,
        appName: cleanText(record.appName, 80) || "自定义 APP",
        characterId,
        summary,
        detail: cleanText(record.detail, 120) || undefined,
        appLabel: cleanText(record.appLabel, 80) || undefined,
        createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
        data: cleanRecord(record.data),
      } satisfies CustomAppTimelineEntry;
    }).filter(Boolean) as CustomAppTimelineEntry[];
  } catch {
    return [];
  }
}

function saveCustomAppTimelineForApp(appId: string, entries: CustomAppTimelineEntry[]): void {
  const id = cleanId(appId);
  const normalized = entries
    .filter(item => item.characterId && item.summary)
    .slice(0, 500);
  kvSet(`${CUSTOM_APP_TIMELINE_PREFIX}${id}`, JSON.stringify(normalized));
}

export function appendCustomAppTimelineEntry(
  app: Pick<InstalledCustomApp, "id" | "name">,
  input: {
    characterId: string;
    summary: string;
    detail?: string;
    appLabel?: string;
    createdAt?: string;
    data?: Record<string, unknown>;
    appEventId?: string;
  },
): CustomAppTimelineEntry {
  const appId = cleanId(app.id);
  const characterId = cleanText(input.characterId, 160);
  const summary = cleanText(input.summary, 2000);
  if (!appId || !characterId || !summary) {
    throw new Error("memory.addTimeline 需要 appId、characterId 和 summary。");
  }
  const timestamp = new Date(input.createdAt || Date.now());
  const data = cleanRecord(input.data) ?? {};
  const appEventId = cleanText(input.appEventId ?? getCustomAppTimelineEventId(data), 160);
  if (appEventId) data.appEventId = appEventId;
  const entry: CustomAppTimelineEntry = {
    id: `custom_app_tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    appId,
    appName: cleanText(app.name, 80) || "自定义 APP",
    characterId,
    summary,
    detail: cleanText(input.detail, 120) || undefined,
    appLabel: cleanText(input.appLabel, 80) || undefined,
    createdAt: Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString(),
    data: Object.keys(data).length > 0 ? data : undefined,
  };
  const next = [entry, ...loadCustomAppTimelineForApp(appId)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500);
  saveCustomAppTimelineForApp(appId, next);
  return entry;
}

export function deleteCustomAppTimelineEntries(
  appId: string,
  input: {
    entryId?: unknown;
    id?: unknown;
    characterId?: unknown;
    appEventId?: unknown;
    eventId?: unknown;
    relatedEventId?: unknown;
    orderId?: unknown;
  },
): { ok: true; deletedCount: number; deletedIds: string[] } {
  const id = cleanId(appId);
  if (!id) return { ok: true, deletedCount: 0, deletedIds: [] };

  const entryId = cleanText(input.entryId ?? input.id, 160);
  const characterId = cleanText(input.characterId, 160);
  const appEventId = getCustomAppTimelineEventId(input as Record<string, unknown>);
  if (!entryId && (!characterId || !appEventId)) {
    throw new Error("memory.deleteTimeline 需要 entryId，或 characterId + appEventId。");
  }

  const current = loadCustomAppTimelineForApp(id);
  const deleted: CustomAppTimelineEntry[] = [];
  const next = current.filter(entry => {
    const matchedByEntryId = Boolean(entryId && entry.id === entryId);
    const matchedByEventId = Boolean(
      appEventId
      && characterId
      && entry.characterId === characterId
      && getCustomAppTimelineEventId(entry.data) === appEventId
    );
    if (matchedByEntryId || matchedByEventId) {
      deleted.push(entry);
      return false;
    }
    return true;
  });

  if (deleted.length > 0) saveCustomAppTimelineForApp(id, next);
  return {
    ok: true,
    deletedCount: deleted.length,
    deletedIds: deleted.map(entry => entry.id),
  };
}

export function loadCustomAppTimelineEntries(
  characterId?: string,
  options?: { afterTimestamp?: string },
): CustomAppTimelineEntry[] {
  const installed = loadInstalledCustomApps();
  const entries = installed.flatMap(app => loadCustomAppTimelineForApp(app.id));
  return entries
    .filter(entry => !characterId || entry.characterId === characterId)
    .filter(entry => !options?.afterTimestamp || entry.createdAt > options.afterTimestamp)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function loadCustomAppPackage(file: File): Promise<InstalledCustomApp> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("应用包缺少 manifest.json。");
  const manifest = normalizeCustomAppManifest(JSON.parse(await manifestFile.async("text")));
  const entryPath = normalizeAssetPath(manifest.entry || "index.html");
  const entryFile = zip.file(entryPath);
  if (!entryFile) throw new Error(`应用包缺少入口文件：${entryPath}`);
  const entryHtml = cleanText(await entryFile.async("text"), MAX_TEXT_LENGTH);
  if (!entryHtml) throw new Error("入口文件为空。");

  const assets: Record<string, CustomAppAsset> = {};
  const iconPath = normalizeAssetPath(manifest.icon || "icon.png");
  let iconDataUrl = "";

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalizedPath = normalizeAssetPath(path);
    if (!normalizedPath || normalizedPath === "manifest.json" || normalizedPath === entryPath) continue;
    const asset = await readZipAsset(entry as unknown as { async: (type: "uint8array") => Promise<Uint8Array> }, normalizedPath);
    if (!asset) continue;
    assets[normalizedPath] = asset;
    if (normalizedPath === iconPath) iconDataUrl = asset.dataUrl;
  }

  if (!iconDataUrl) {
    const iconFile = zip.file(iconPath);
    if (iconFile) {
      const asset = await readZipAsset(iconFile as unknown as { async: (type: "uint8array") => Promise<Uint8Array> }, iconPath);
      iconDataUrl = asset?.dataUrl ?? "";
    }
  }

  return {
    id: generateCustomAppRuntimeId(manifest.id || manifest.name),
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    iconDataUrl,
    entryHtml,
    permissions: manifest.permissions ?? [],
    manifest,
    assets,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function loadSingleHtmlCustomApp(file: File): Promise<InstalledCustomApp> {
  const entryHtml = cleanText(await file.text(), MAX_TEXT_LENGTH);
  const name = file.name.replace(/\.[^.]+$/, "") || "自定义 APP";
  const id = generateCustomAppRuntimeId(name);
  const permissions: CustomAppPermission[] = [
    "app.data.read",
    "app.data.write",
    "app.manifest.read",
    "characters.read",
    "user.persona.read",
    "memory.readCore",
    "memory.readLongTerm",
    "memory.readShortTerm",
    "memory.search",
    "ai.generate",
    "chat.read",
    "chat.sendMessage",
    "chat.sendCard",
    "chat.requestReply",
    "chat.contacts.write",
    "ui.toast",
    "notifications.read",
    "notifications.write",
    "tasks.schedule",
    "wallet.read",
    "wallet.pay",
  ];
  return {
    id,
    name,
    version: "1.0.0",
    entryHtml,
    permissions,
    manifest: {
      id: normalizeCustomAppManifestId(name),
      name,
      version: "1.0.0",
      entry: "index.html",
      permissions,
    },
    assets: {},
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function blobToAppIcon(file: Blob): Promise<string> {
  return fileBlobToDataUrl(file, file.type || "image/png");
}

export function installCustomApp(app: InstalledCustomApp): InstalledCustomApp {
  const normalized = normalizeInstalledApp({
    ...app,
    id: cleanId(app.id) || generateCustomAppRuntimeId(app.name || app.manifest?.name),
  });
  if (!normalized) throw new Error("应用包数据无效。");
  const apps = loadInstalledCustomApps();
  const conflict = getCustomAppInstallConflict(normalized, apps);
  if (conflict) throw new Error(formatInstallConflict(conflict));
  saveInstalledCustomApps([normalized, ...apps.filter(item => item.id !== normalized.id)]);
  return normalized;
}

export async function installCustomAppAsync(app: InstalledCustomApp): Promise<InstalledCustomApp> {
  await hydrateKvDb();
  return installCustomApp(app);
}
