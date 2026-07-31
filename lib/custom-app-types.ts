export const CUSTOM_APP_ICON_PREFIX = "custom_app:" as const;

export type CustomAppIconId = `${typeof CUSTOM_APP_ICON_PREFIX}${string}`;

export type CustomAppPermission =
  | "app.data.read"
  | "app.data.write"
  | "app.assets.read"
  | "app.manifest.read"
  | "ai.generate"
  | "ai.generateImage"
  | "ai.chat"
  | "ai.embed"
  | "ai.classify"
  | "network.fetch"
  | "voice.tts"
  | "voice.stt"
  | "voice.clone"
  | "voice.readProfiles"
  | "user.profile.read"
  | "user.persona.read"
  | "user.preferences.read"
  | "chat.read"
  | "chat.read.background"
  | "chat.write"
  | "chat.sendMessage"
  | "chat.sendCard"
  | "chat.requestReply"
  | "chat.contacts.write"
  | "chat.tools"
  | "characters.read"
  | "characters.state.read"
  | "characters.state.write"
  | "characters.relations.read"
  | "calendar.read"
  | "calendar.write"
  | "world.read"
  | "world.write"
  | "world.activate"
  | "memory.readCore"
  | "memory.readLongTerm"
  | "memory.readShortTerm"
  | "memory.search"
  | "memory.write"
  | "memory.suggest"
  | "media.pick"
  | "media.save"
  | "geo.read"
  | "geo.watch"
  | "notifications.read"
  | "notifications.write"
  | "tasks.schedule"
  | "ui.toast"
  | "ui.notification"
  | "ui.sms"
  | "ui.call"
  | "wallet.read"
  | "wallet.pay"
  | "online.play";

export type CustomAppSdkVersion = "1.0" | string;

export type CustomAppExtensionEntry = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  entry?: string;
  data?: Record<string, unknown>;
};

export type CustomAppChatDirectiveAction = {
  label: string;
  style?: string;
};

export type CustomAppChatDirective = {
  id: string;
  label: string;
  syntax?: string;
  description?: string;
  card?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  title?: string;
  appLabel?: string;
  status?: string;
  tone?: string;
  accentColor?: string;
  sceneId?: string;
  sceneTag?: string;
  tags?: string[];
  actions?: CustomAppChatDirectiveAction[];
};

export type CustomAppChatPlusAction = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  entry?: string;
  presentation?: "panel" | "modal" | "fullscreen" | "app" | "none";
  panelHeight?: string;
  data?: Record<string, unknown>;
  directiveId?: string;
  sceneId?: string;
  sceneTag?: string;
  tags?: string[];
};

export type CustomAppChatMessageAction = CustomAppExtensionEntry & {
  mediaTypes?: string[];
  roles?: string[];
};

export type CustomAppChatCardAction = CustomAppExtensionEntry & {
  directiveId?: string;
  cardTypes?: string[];
};

export type CustomAppChatInputTool = CustomAppExtensionEntry & {
  insertText?: string;
};

export type CustomAppChatScene = CustomAppExtensionEntry & {
  tag?: string;
  tags?: string[];
  appTags?: string[];
  directiveId?: string;
  actionId?: string;
};

export type CustomAppToolParameterSchema = Record<string, unknown>;

export type CustomAppToolDefinition = {
  id: string;
  name: string;
  description?: string;
  parameterSchema?: CustomAppToolParameterSchema;
  usageGuide?: string;
  visibility?: "private" | "shared";
  handler?: string;
  entry?: string;
  timeoutMs?: number;
  enabled?: boolean;
  actions?: Array<Record<string, unknown>>;
  resultTemplate?: string;
};

export type CustomAppChatExtensions = {
  scenes?: CustomAppChatScene[];
  directives?: CustomAppChatDirective[];
  plusActions?: CustomAppChatPlusAction[];
  messageActions?: CustomAppChatMessageAction[];
  cardActions?: CustomAppChatCardAction[];
  inputTools?: CustomAppChatInputTool[];
  tools?: CustomAppToolDefinition[];
};

export type CustomAppUiExtensions = {
  homeWidgets?: CustomAppExtensionEntry[];
  characterTabs?: CustomAppExtensionEntry[];
  settingsPanels?: CustomAppExtensionEntry[];
  shareTargets?: CustomAppExtensionEntry[];
  searchProviders?: CustomAppExtensionEntry[];
};

export type CustomAppPromptHistoryMode = "default" | "none" | "current_session" | "recent";
export type CustomAppPromptOutputMode = "chat" | "plain_text" | "json";

export type CustomAppPromptProfile = {
  id: string;
  label: string;
  description?: string;
  include?: string[];
  exclude?: string[];
  history?: CustomAppPromptHistoryMode;
  output?: CustomAppPromptOutputMode;
  appTags?: string[];
  enableWorldBooks?: boolean;
  enableRegexes?: boolean;
};

export type CustomAppResourceDeclarations = {
  presets?: string[];
  regexes?: string[];
  worldBooks?: string[];
  bindings?: string[];
  tools?: string[];
  voices?: string[];
  assets?: string[];
};

export type CustomAppEventName =
  | "app.installed"
  | "app.launched"
  | "chat.message.created"
  | "chat.directive.parsed"
  | "chat.card.clicked"
  | "memory.updated"
  | "character.state.changed"
  | "notification.clicked"
  | "task.due"
  | "wallet.paid"
  | string;

export type CustomAppEventSubscription = {
  event: CustomAppEventName;
  entry?: string;
  background?: boolean;
  timeoutMs?: number;
  description?: string;
};

export type CustomAppExtensions = {
  chat?: CustomAppChatExtensions;
  ui?: CustomAppUiExtensions;
  prompt?: {
    profiles?: CustomAppPromptProfile[];
  };
  tools?: CustomAppToolDefinition[];
  events?: CustomAppEventSubscription[];
};

export type CustomAppNetworkPolicy = {
  allowedDomains?: string[];
  mode?: "direct" | "proxy";
};

export type CustomAppManifest = {
  id: string;
  name: string;
  version: string;
  sdkVersion?: CustomAppSdkVersion;
  author?: string;
  description?: string;
  icon?: string;
  entry?: string;
  permissions?: CustomAppPermission[];
  resources?: CustomAppResourceDeclarations;
  primaryTags?: string[];
  extensions?: CustomAppExtensions;
  promptProfiles?: CustomAppPromptProfile[];
  events?: CustomAppEventSubscription[];
  network?: CustomAppNetworkPolicy;
  slots?: Record<string, {
    label?: string;
    required?: boolean;
  }>;
  chatDirectives?: CustomAppChatDirective[];
  chatPlusActions?: CustomAppChatPlusAction[];
  chatExtensions?: CustomAppChatExtensions;
  triggers?: Array<Record<string, unknown>>;
};

export type CustomAppAsset = {
  path: string;
  mime: string;
  dataUrl: string;
};

export type InstalledCustomApp = {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  iconDataUrl?: string;
  entryHtml: string;
  permissions: CustomAppPermission[];
  manifest: CustomAppManifest;
  assets: Record<string, CustomAppAsset>;
  installedAt: string;
  updatedAt: string;
  /** 来源标记:从应用广场安装/更新时记录市场条目 id;本地导入的没有此字段 */
  marketItemId?: string;
};

export function isCustomAppIconId(value: string): value is CustomAppIconId {
  return value.startsWith(CUSTOM_APP_ICON_PREFIX) && value.length > CUSTOM_APP_ICON_PREFIX.length;
}

export function toCustomAppIconId(appId: string): CustomAppIconId {
  return `${CUSTOM_APP_ICON_PREFIX}${appId}` as CustomAppIconId;
}

export function customAppIdFromIconId(iconId: string): string | null {
  return isCustomAppIconId(iconId) ? iconId.slice(CUSTOM_APP_ICON_PREFIX.length) : null;
}
