import type { LLMMessage } from "./llm-prompt-assembler";

export type GameTemplateSource = "builtin" | "community" | "local";

export type GameRoleSlot = {
  id: string;
  label: string;
  description: string;
  required: boolean;
  min: number;
  max: number;
};

export type GameTemplate = {
  id: string;
  title: string;
  codeName: string;
  subtitle: string;
  synopsis: string;
  playNote: string;
  coverImage: string;
  tags: string[];
  authorId: string;
  authorName: string;
  authorAvatar: string;
  source: GameTemplateSource;
  version: number;
  roleSlots: GameRoleSlot[];
  pickerHtml: string;
  gameHtml: string;
  allowExternalControl: boolean;
  purchaseCount: number;
  rating: number;
  likeCount: number;
  favoriteCount: number;
  commentCount: number;
  likedByMe?: boolean;
  favoritedByMe?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GameRoleAssignment = {
  slotId: string;
  characterIds: string[];
};

export type GameInstalledStatus = "installed" | "archived";

export type GameInstalledItem = {
  localId: string;
  remoteTemplateId: string;
  installedAt: string;
  templateSnapshot: GameTemplate;
  roleAssignments: GameRoleAssignment[];
  status: GameInstalledStatus;
  playCount: number;
  lastPlayedAt?: string;
};

export type GameCollectionFolder = {
  id: string;
  name: string;
  description: string;
  colorA: string;
  colorB: string;
  gameIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type GameSaveRecord = {
  id: string;
  localGameId: string;
  updatedAt: string;
  data: unknown;
};

export type GameProjectionEntry = {
  id: string;
  localGameId: string;
  remoteTemplateId: string;
  templateTitle: string;
  characterId: string;
  characterName: string;
  playerName: string;
  summary: string;
  timestamp: string;
};

export type GameState = {
  userId: string;
  displayName: string;
  avatarUrl: string;
  likedGameIds: string[];
  installedGames: GameInstalledItem[];
  collectionFolders: GameCollectionFolder[];
  hiddenDefaultCollectionIds: string[];
  saves: GameSaveRecord[];
  gameEvents: GameProjectionEntry[];
  updatedAt: string;
};

export type GameInstallResult = {
  ok: boolean;
  state: GameState;
  installedGame?: GameInstalledItem;
  error?: string;
};

export type GameRolePackageMode = "light" | "full";

export type GameRolePackage = {
  characterId: string;
  characterName: string;
  slotId?: string;
  mode: GameRolePackageMode;
  messages: LLMMessage[];
  tokenEstimate: number;
};

export type GameHallDraft = {
  id: string;
  title: string;
  draft: GameTemplateDraft;
  /** 显式关联：本草稿发布对应的共享大厅条目 id。有值时「发布」= 同步更新该条目。 */
  publishedTemplateId?: string;
  /** 关联发布条目后,本机又存过草稿但还没提交更新时为 true;更新发布成功后清除 */
  hasUnpublishedChanges?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GameTemplateDraft = {
  title: string;
  codeName: string;
  subtitle: string;
  synopsis: string;
  playNote: string;
  coverImage: string;
  tagsText: string;
  authorName: string;
  roleSlotsText: string;
  pickerHtml: string;
  gameHtml: string;
  allowExternalControl: boolean;
};

export type GameComment = {
  id: string;
  gameId: string;
  parentId?: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  createdAt: string;
};
