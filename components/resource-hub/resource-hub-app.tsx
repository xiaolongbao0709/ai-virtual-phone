"use client";

// 资源集市：社区资源市场（GitHub 仓库当后端，浏览走 CDN）。
// 首页自动显示仓库根目录的文件夹（仿文件管理器），文件夹页为古早论坛式列表，
// 资源可下载或导入（导入时选择目的地）。整体为复古 Windows 风格。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import {
    checkImportFileForDestination,
    downloadResourceHubFile,
    fetchShareIndex,
    importResourceHubFile,
    fetchPresetEntry,
    applyPresetEntry,
    loadResourceHubSource,
    purgeShareIndexCache,
    resolveResourceHubAssetUrl,
    saveResourceHubSource,
} from "@/lib/resource-hub-client";
import {
    IMPORT_DESTINATIONS,
    stripAssetImageMark,
    type ImportDestination,
    type ResourceHubSource,
    type ShareIndex,
    type ShareIndexEntry,
} from "@/lib/resource-hub-types";
import {
    editResource,
    fileToUploadEntry,
    loadMyUploads,
    loadUploadConfig,
    ownerDeleteViaService,
    saveUploadConfig,
    uploadResource,
    type MyUploadRecord,
    type ResourceHubUploadConfig,
} from "@/lib/resource-hub-upload";
import { avatarBase64, fileToAvatarDataUrl, loadHubProfile, saveHubProfile, type HubProfile } from "@/lib/resource-hub-profile";
import { fetchMergedContributions, type MergedContribution } from "@/lib/community-contrib";
import {
    ensureIdentityKey,
    exportKeyBundle,
    parseKeyBundle,
    setIdentityKey,
    sha256Hex,
} from "@/lib/resource-hub-identity";
import { mergeMyUploads, submitOwnershipClaim } from "@/lib/resource-hub-upload";
import { DefaultPixelAvatar } from "@/components/resource-hub/pixel-avatar";
import { DestPixelIcon, FileTypePixelIcon, fileExtension } from "@/components/resource-hub/pixel-icons";
import { loadPresets } from "@/lib/settings-storage";
import { displayOrderPrompts } from "@/lib/preset-entry-import";
import type { Prompt, PresetConfig } from "@/lib/settings-types";
// 标题栏图标用 lucide 矢量图：⚙/⟳ 这些字符在 iOS 上会被当彩色 emoji 画、
// 或者字形本身偏小，各设备长相不一；矢量图标则处处一致且小尺寸清晰。
import { RotateCw, Settings, X } from "lucide-react";
import { deleteShareEntry } from "@/lib/resource-hub-review";
import { MediaPreviewOverlay } from "@/components/chat/media-preview-overlay";
import { fetchFlowerCounts, hasSentFlowerToday, sendFlower, type FlowerCounts } from "@/lib/resource-hub-flowers";
import { STICKER_NAMES, StickerPixelIcon } from "@/components/resource-hub/pixel-stickers";
import { RICH_COLORS, RichText } from "@/components/resource-hub/rich-text";
import { RichEditor, type RichEditorHandle } from "@/components/resource-hub/rich-editor";
import { PixelHourglass } from "@/components/pixel-hourglass";

type LoadState = "loading" | "ready" | "error";

/** 富文本编辑器的四个落点：上传弹窗和编辑弹窗各有标题与说明 */
type RichField = "uploadTitle" | "uploadDesc" | "editTitle" | "editDesc";

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 再次点选择器时追加到已选清单，而不是把之前选的顶掉——用户没叉掉就不该丢。
 * 同名文件会原地替换成新选的那份：上传后按文件名落库，留两份同名的必然互相覆盖。
 */
function appendPickedFiles(current: File[], incoming: File[]): File[] {
    const next = [...current];
    for (const file of incoming) {
        const at = next.findIndex(f => f.name === file.name);
        if (at >= 0) next[at] = file;
        else next.push(file);
    }
    return next;
}

function formatEntryDate(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 开屏须知的「永不显示」记忆键（值为 "1" 即不再弹）。
 * 须知内容有实质改动时要升版本号：旧键的「永不显示」不该压住新内容，
 * 否则老用户永远看不到新增的隐私告知。
 */
const NOTICE_DISMISSED_KEY = "ai_phone_resource_hub_notice_v2";
registerKvMigration(NOTICE_DISMISSED_KEY);
/** 摊主钥匙强制备份：确认保存过一次后不再打扰 */
const KEY_BACKUP_DONE_KEY = "ai_phone_resource_hub_key_backup_v1";

export function ResourceHubApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [source, setSource] = useState<ResourceHubSource>(() => loadResourceHubSource());
    const [index, setIndex] = useState<ShareIndex | null>(null);
    const [loadState, setLoadState] = useState<LoadState>("loading");
    const [loadError, setLoadError] = useState("");
    const [activeFolder, setActiveFolder] = useState<string | null>(null);
    const [activeEntry, setActiveEntry] = useState<ShareIndexEntry | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<ShareIndexEntry | null>(null);
    const [deleting, setDeleting] = useState(false);
    // 浏览集市 / 我的货摊
    const [viewMode, setViewMode] = useState<"market" | "mine" | "build">("market");
    // 共同建设：贡献墙（只展示已被官方采纳=已合并的社区 PR）
    const [buildWall, setBuildWall] = useState<MergedContribution[] | null>(null);
    const [buildWallState, setBuildWallState] = useState<"idle" | "loading" | "error">("idle");
    const enterBuildTab = useCallback(() => {
        setViewMode("build");
        setActiveFolder(null);
        setSearchQuery("");
        if (buildWall || buildWallState === "loading") return;
        setBuildWallState("loading");
        fetchMergedContributions()
            .then(list => { setBuildWall(list); setBuildWallState("idle"); })
            .catch(() => setBuildWallState("error"));
    }, [buildWall, buildWallState]);
    // 图片全屏预览（点开可保存）
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    // 送花：各资源花数（我的货摊展示用）+ 非阻塞小提示
    const [flowerCounts, setFlowerCounts] = useState<FlowerCounts | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    // 摊主资料（昵称 + 头像，本机存；上传/编辑时头像一并发布）
    const [profile, setProfile] = useState<HubProfile>(() => loadHubProfile());
    const [editingNickname, setEditingNickname] = useState(false);
    // 摊主钥匙与它的指纹：指纹用来在索引里认领"哪些资源是我发的"。
    // 钥匙只在这个 effect 里取一次（要等存储加载完），渲染期一律读这份状态。
    const [identityKey, setIdentityKeyState] = useState("");
    const [identityHash, setIdentityHash] = useState("");
    const [showKeyDialog, setShowKeyDialog] = useState(false);
    // 发布成功后的强制钥匙备份弹窗（存过文件/复制过才能点「我已保存好」）
    const [showKeyBackup, setShowKeyBackup] = useState(false);
    const [keyBackupTouched, setKeyBackupTouched] = useState(false);
    // 找回作品：丢了钥匙的作者选择资源 + 上传证明材料，开申请等管理员人工审核
    const [showClaim, setShowClaim] = useState(false);
    const [claimFolder, setClaimFolder] = useState("");
    const [claimPath, setClaimPath] = useState("");
    const [claimFiles, setClaimFiles] = useState<File[]>([]);
    const [claimNote, setClaimNote] = useState("");
    const [claimSubmitting, setClaimSubmitting] = useState(false);
    const [keyImportText, setKeyImportText] = useState("");
    // 作者编辑已发布资源
    const [editEntry, setEditEntry] = useState<ShareIndexEntry | null>(null);
    const [editRecord, setEditRecord] = useState<MyUploadRecord | null>(null);
    const [editAuthor, setEditAuthor] = useState("");
    const [editTitle, setEditTitle] = useState("");
    const [editDesc, setEditDesc] = useState("");
    const [editAddFiles, setEditAddFiles] = useState<File[]>([]);
    const [editAddImages, setEditAddImages] = useState<File[]>([]);
    const [editRemoved, setEditRemoved] = useState<string[]>([]);
    const [savingEdit, setSavingEdit] = useState(false);
    const editTitleRef = useRef<RichEditorHandle | null>(null);
    const editDescRef = useRef<RichEditorHandle | null>(null);
    // 联网中的按钮（各自显示像素沙漏）
    const [sendingFlower, setSendingFlower] = useState(false);
    const [importingTo, setImportingTo] = useState<string | null>(null);
    const [busyFile, setBusyFile] = useState<string | null>(null);
    // 导入流程：选文件 → 选目的地 →（聊天室CSS再选角色）
    const [importFile, setImportFile] = useState<string | null>(null);
    const [pickCharacterFor, setPickCharacterFor] = useState<string | null>(null);
    const [showSourceEditor, setShowSourceEditor] = useState(false);
    const [sourceDraft, setSourceDraft] = useState<ResourceHubSource>(source);
    // 上传（分类下拉：CUSTOM_FOLDER 表示自定义新分类，配合手动输入框）
    const CUSTOM_FOLDER = "__custom__";
    const [showUpload, setShowUpload] = useState(false);
    const [uploadFolder, setUploadFolder] = useState("");
    const [uploadFolderCustom, setUploadFolderCustom] = useState("");
    const [uploadName, setUploadName] = useState("");
    const [uploadAuthor, setUploadAuthor] = useState("");
    const [uploadDesc, setUploadDesc] = useState("");
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
    const [uploadImages, setUploadImages] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    // 提交前的公开性确认（资源会进公开仓库，先让人心里有数）
    const [confirmUpload, setConfirmUpload] = useState(false);
    // 开屏版权提示（勾了「永不显示」就不再弹）
    const [showNotice, setShowNotice] = useState(false);
    // 安装插件前的风险告知：待安装的插件文件路径
    const [confirmPlugin, setConfirmPlugin] = useState<string | null>(null);
    // 应用主题包前的覆盖确认：待导入的主题包文件路径
    const [confirmTheme, setConfirmTheme] = useState<string | null>(null);
    // 「预设条目」四步流程：取到的条目 → 选新增/覆盖 → 选预设 → 选位置
    const [entryImport, setEntryImport] = useState<{
        prompt: Prompt;
        mode: "insert" | "replace" | null;
        preset: PresetConfig | null;
    } | null>(null);
    const [entryBusy, setEntryBusy] = useState(false);
    const [uploadCfg, setUploadCfg] = useState<ResourceHubUploadConfig>(() => loadUploadConfig());
    // 所见即所得编辑器：贴纸/颜色面板都记着"当前作用于哪个输入框"。
    // 上传和编辑两个弹窗各有标题+说明两处，共四个目标，面板必须认得出是谁开的，
    // 否则在编辑弹窗里点贴纸会插进上传弹窗的编辑器。
    const [stickerPickerFor, setStickerPickerFor] = useState<RichField | null>(null);
    const [colorPickerFor, setColorPickerFor] = useState<RichField | null>(null);
    const uploadNameRef = useRef<RichEditorHandle | null>(null);
    const uploadDescRef = useRef<RichEditorHandle | null>(null);

    /**
     * 这条资源是不是我发的：先看本机记录，再看索引里的钥匙指纹是否与本机钥匙吻合。
     * 后者让换了设备、只导入了钥匙的人也能直接编辑/删除自己的旧发布。
     */
    const myRecordFor = useCallback((path: string): MyUploadRecord | null => {
        const local = loadMyUploads().find(r => r.path === path);
        if (local) return local;
        const entry = index?.entries.find(e => e.path === path);
        if (identityHash && identityKey && entry?.ownerHash && entry.ownerHash === identityHash) {
            return { path, name: entry.name, ownerKey: identityKey, uploadedAt: entry.updatedAt || "" };
        }
        return null;
    }, [identityHash, identityKey, index]);

    const showToast = useCallback((msg: string) => {
        setToast(msg);
        window.setTimeout(() => setToast(current => (current === msg ? null : current)), 2600);
    }, []);

    const editorRefFor = useCallback((field: RichField) => (
        field === "uploadTitle" ? uploadNameRef
            : field === "uploadDesc" ? uploadDescRef
                : field === "editTitle" ? editTitleRef
                    : editDescRef
    ), []);

    // 颜色/字号/加粗都是"选中文字再操作"：没选中就提示
    const wrapTag = useCallback((tag: string, field: RichField) => {
        if (!editorRefFor(field).current?.applyTag(tag)) showToast("先选中要排版的文字，再点按钮");
    }, [editorRefFor, showToast]);

    // 颜色和字号都只能「加」不能「减」：调色盘里没有黑、字号只有大和小，
    // 套错了就退不回默认。这里统一给一个「清除」把选区还原成普通文字。
    const clearFormat = useCallback((field: RichField) => {
        if (!editorRefFor(field).current?.clearFormat()) showToast("先选中要还原的文字，再点清除");
    }, [editorRefFor, showToast]);

    // 换弹窗时把面板收掉，免得残留的目标指向另一个弹窗里的编辑器
    const closeRichPickers = useCallback(() => {
        setStickerPickerFor(null);
        setColorPickerFor(null);
    }, []);

    // 工具栏按钮按下时不抢走编辑器焦点，选区才能保住（iOS 上尤其关键）
    const keepSelection = useCallback((e: React.PointerEvent) => e.preventDefault(), []);

    // 本机钥匙取一次就够（钥匙不变）。必须等 kv 从 IndexedDB 加载完再判断，
    // 否则冷启动瞬间会误判成"没有钥匙"而新生成一把，把原来的覆盖掉。
    useEffect(() => {
        let cancelled = false;
        void ensureIdentityKey().then(async key => {
            if (cancelled) return;
            setIdentityKeyState(key);
            const hash = await sha256Hex(key);
            if (!cancelled) setIdentityHash(hash);
        });
        return () => { cancelled = true; };
    }, []);

    // 开屏版权提示：必须等 kv 从 IndexedDB 加载完再判断，
    // 否则冷启动瞬间读不到「永不显示」，每次进来都会弹一遍。
    useEffect(() => {
        let cancelled = false;
        void hydrateKvDb().then(() => {
            if (!cancelled && kvGet(NOTICE_DISMISSED_KEY) !== "1") setShowNotice(true);
        });
        return () => { cancelled = true; };
    }, []);

    // 编辑弹窗打开时把现有标题/正文灌进所见即所得编辑器（编辑器是非受控的）
    useEffect(() => {
        if (!editEntry) return;
        editTitleRef.current?.setMarkup(editEntry.name);
        editDescRef.current?.setMarkup(editEntry.description);
    }, [editEntry]);

    const reload = useCallback((activeSource: ResourceHubSource, options?: { purge?: boolean }) => {
        setLoadState("loading");
        setLoadError("");
        const run = () => fetchShareIndex(activeSource)
            .then(data => { setIndex(data); setLoadState("ready"); })
            .catch(err => {
                setLoadError(err instanceof Error ? err.message : String(err));
                setLoadState("error");
            });
        if (options?.purge) {
            // 手动刷新时先强刷 CDN，让新上架的资源尽快可见
            purgeShareIndexCache(activeSource);
            setTimeout(run, 1500);
        } else {
            void run();
        }
    }, []);

    useEffect(() => { reload(source); }, [reload, source]);

    // 切到我的货摊时拉取花数（仅作者本人可见的统计）
    useEffect(() => {
        if (viewMode !== "mine") return;
        let cancelled = false;
        void fetchFlowerCounts(source).then(counts => { if (!cancelled) setFlowerCounts(counts); });
        return () => { cancelled = true; };
    }, [viewMode, source, index]);

    const folderEntries = useMemo(() => {
        if (!index || !activeFolder) return [];
        return index.entries
            .filter(e => e.folder === activeFolder)
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name, "zh"));
    }, [index, activeFolder]);

    // 关键词搜索：跨全部分类，匹配名称/说明/分类/文件名
    const searchResults = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q || !index) return null;
        return index.entries
            .filter(e => [e.name, e.description, e.folder, ...e.files, ...e.images]
                .join(" ").toLowerCase().includes(q))
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name, "zh"));
    }, [index, searchQuery]);

    // 我的货摊：本机上传记录与目录比对——在目录里的可点进详情，不在的显示待审/未上架
    const myStall = useMemo(() => {
        const records = loadMyUploads();
        const published: ShareIndexEntry[] = [];
        const pending: { name: string; uploadedAt: string }[] = [];
        const claimed = new Set<string>();
        for (const record of records) {
            const entry = index?.entries.find(e => e.path === record.path);
            if (entry) { published.push(entry); claimed.add(entry.path); }
            else pending.push({ name: record.name, uploadedAt: record.uploadedAt });
        }
        // 换设备后本机没有记录，但索引里的钥匙指纹对得上，一样是我的摊位
        if (identityHash) {
            for (const entry of index?.entries ?? []) {
                if (!claimed.has(entry.path) && entry.ownerHash && entry.ownerHash === identityHash) {
                    published.push(entry);
                    claimed.add(entry.path);
                }
            }
        }
        return { published, pending };
        // index 变化或切到货摊时重算
    }, [index, viewMode, identityHash]); // eslint-disable-line react-hooks/exhaustive-deps

    const chatContacts = useMemo(() => {
        if (pickCharacterFor === null) return [];
        const characters = loadCharacters();
        // ChatSession.contactId 存的是「角色 id」（全仓 createOrGetSession 都传角色 id，
        // chat-storage 也用它反查角色名）。这里必须给 characterId，给 contact.id 会建出
        // 一个谁都匹配不上的游离会话，CSS 写进去等于扔了。
        return loadChatContacts().map(contact => ({
            contactId: contact.characterId,
            name: contact.nickname || characters.find(c => c.id === contact.characterId)?.name || "未知角色",
        }));
    }, [pickCharacterFor]);

    // 手动送花（详情页按钮）。自动送花复用同一函数。
    const handleSendFlower = useCallback(async (entryPath: string, silent = false) => {
        if (!silent) setSendingFlower(true);
        try {
            const sent = await sendFlower(loadUploadConfig().endpoint, entryPath);
            if (sent) showToast("已送出一朵花 🌸");
            else if (!silent) showToast("今天已经给它送过花啦");
        } finally {
            if (!silent) setSendingFlower(false);
        }
    }, [showToast]);

    const handleDownload = useCallback(async (path: string) => {
        setBusyFile(path);
        try {
            await downloadResourceHubFile(source, path);
            // 下载成功默认送出一朵花（今天送过则静默跳过，失败不影响下载）
            if (activeEntry) void handleSendFlower(activeEntry.path, true);
        } catch (err) {
            onNotice?.(`下载失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusyFile(null);
        }
    }, [activeEntry, handleSendFlower, onNotice, source]);

    // 导入时弹窗不立刻关闭：在刚点的那个图标上转沙漏，做完再关，
    // 免得反馈跑到别的位置去（用户看不到自己点的东西有反应）
    const runImport = useCallback(async (path: string, destination: ImportDestination, contactId?: string) => {
        setBusyFile(path);
        setImportingTo(contactId ?? destination);
        try {
            // authorName：条目投稿人署名，特调入柜时随材料带入（别的目的地忽略）
            const message = await importResourceHubFile(source, path, destination, { contactId, authorName: activeEntry?.author?.trim() || undefined });
            onNotice?.(message);
        } catch (err) {
            onNotice?.(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusyFile(null);
            setImportingTo(null);
            setImportFile(null);
            setPickCharacterFor(null);
        }
    }, [activeEntry, onNotice, source]);

    /** 第三步点下去：落盘并收尾。 */
    const runEntryImport = useCallback(async (anchorIdentifier: string | null) => {
        if (!entryImport?.mode || !entryImport.preset) return;
        setEntryBusy(true);
        try {
            const message = await applyPresetEntry(entryImport.prompt, entryImport.preset.id, entryImport.mode, anchorIdentifier);
            onNotice?.(message);
            setEntryImport(null);
        } catch (err) {
            onNotice?.(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setEntryBusy(false);
        }
    }, [entryImport, onNotice]);

    const handlePickDestination = useCallback((destination: ImportDestination) => {
        if (!importFile) return;
        const typeError = checkImportFileForDestination(destination, importFile);
        if (typeError) {
            onNotice?.(typeError);
            return;
        }
        if (destination === "chat_session_css") {
            setPickCharacterFor(importFile);
            setImportFile(null);
            return;
        }
        // 插件与本应用同权限，装上即执行；集市来源必然是陌生人写的代码，先问一句
        if (destination === "plugin") {
            setConfirmPlugin(importFile);
            setImportFile(null);
            return;
        }
        // 主题包是整体覆盖当前外观（主题色/壁纸/图标/组件/桌面布局），不是叠加
        if (destination === "theme") {
            setConfirmTheme(importFile);
            setImportFile(null);
            return;
        }
        // 预设条目：先把条目取下来（顺便校验是不是单条），再走选预设/选位置
        if (destination === "preset_entry") {
            const target = importFile;
            setImportingTo(destination);
            void fetchPresetEntry(source, target)
                .then(prompt => {
                    setEntryImport({ prompt, mode: null, preset: null });
                    setImportFile(null);
                })
                .catch(err => onNotice?.(`导入失败：${err instanceof Error ? err.message : String(err)}`))
                .finally(() => setImportingTo(null));
            return;
        }
        void runImport(importFile, destination);
    }, [importFile, onNotice, runImport]);

    const openEdit = useCallback((entry: ShareIndexEntry) => {
        const record = myRecordFor(entry.path);
        if (!record) { showToast("只有发布者本人可以编辑"); return; }
        closeRichPickers();
        setEditRecord(record);
        setEditEntry(entry);
        setEditTitle(entry.name);
        setEditDesc(entry.description);
        setEditAuthor(entry.author?.trim() || profile.nickname);
        setEditAddFiles([]);
        setEditAddImages([]);
        setEditRemoved([]);
    }, [closeRichPickers, myRecordFor, profile.nickname, showToast]);

    const handleSaveEdit = useCallback(async () => {
        if (!editEntry || !editRecord) return;
        const title = editTitle.trim();
        if (!title) { showToast("标题不能为空"); return; }
        setSavingEdit(true);
        try {
            // 与上传一致：「资源文件」里的图片要标成资源本体（PNG 角色卡、表情包），
            // 不标的话索引会按扩展名把它当配图，详情页里就只能看不能下载。
            const addFiles = await Promise.all([
                ...editAddFiles.map(file => fileToUploadEntry(file, { asset: true })),
                ...editAddImages.map(file => fileToUploadEntry(file)),
            ]);
            await editResource(source, editRecord, {
                title,
                author: editAuthor.trim(),
                description: editDesc.trim(),
                avatarBase64: avatarBase64(profile.avatarDataUrl) || undefined,
                addFiles,
                removeFiles: editRemoved,
            });
            // 乐观更新：CDN 索引重建要一会儿，先让界面显示新内容
            const keep = (list: string[]) => list.filter(f => !editRemoved.includes(f));
            const updated: ShareIndexEntry = {
                ...editEntry,
                name: title,
                description: editDesc.trim(),
                author: editAuthor.trim(),
                files: keep(editEntry.files),
                images: keep(editEntry.images),
            };
            setIndex(current => current
                ? { ...current, entries: current.entries.map(e => (e.path === updated.path ? updated : e)) }
                : current);
            setActiveEntry(current => (current?.path === updated.path ? updated : current));
            setEditEntry(null);
            closeRichPickers();
            setEditRecord(null);
            onNotice?.("已保存，索引刷新后所有人都能看到新内容");
        } catch (err) {
            onNotice?.(`保存失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setSavingEdit(false);
        }
    }, [editAddFiles, editAddImages, editAuthor, editDesc, editEntry, editRecord, editRemoved, editTitle, onNotice, profile.avatarDataUrl, showToast, source]);

    const handlePickAvatar = useCallback(async (file: File) => {
        try {
            const dataUrl = await fileToAvatarDataUrl(file);
            const next = { ...profile, avatarDataUrl: dataUrl };
            setProfile(next);
            saveHubProfile(next);
            showToast("头像已更新（发布新资源时同步）");
        } catch {
            showToast("这张图片处理失败，换一张试试");
        }
    }, [profile, showToast]);

    const handleDeleteEntry = useCallback(async (entry: ShareIndexEntry) => {
        setDeleting(true);
        try {
            // 本人上传的用删除凭证走上传服务；否则按管理员 Token 直删
            const myRecord = loadMyUploads().find(r => r.path === entry.path);
            if (myRecord) {
                await ownerDeleteViaService(loadUploadConfig().endpoint, myRecord);
            } else {
                await deleteShareEntry(entry.path);
            }
            setConfirmDeleteEntry(null);
            setActiveEntry(null);
            // 乐观更新本地目录，CDN 缓存刷新前列表就正确
            setIndex(current => current ? {
                ...current,
                entries: current.entries.filter(e => e.path !== entry.path),
                folders: current.folders.map(f => f.name === entry.folder ? { ...f, count: Math.max(0, f.count - 1) } : f),
            } : current);
            onNotice?.(`「${entry.name}」已下架`);
        } catch (err) {
            onNotice?.(`删除失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setDeleting(false);
        }
    }, [onNotice]);

    const handleSubmitClaim = useCallback(async () => {
        const entry = index?.entries.find(e => e.path === claimPath);
        if (!entry) { showToast("请选择要找回的作品"); return; }
        if (claimFiles.length === 0) { showToast("请上传证明文件"); return; }
        if (!identityHash) { showToast("摊主钥匙尚未就绪，稍等两秒再试"); return; }
        setClaimSubmitting(true);
        try {
            const files = await Promise.all(claimFiles.map(file => fileToUploadEntry(file)));
            await submitOwnershipClaim({
                endpoint: uploadCfg.endpoint,
                path: entry.path,
                name: entry.name,
                ownerHash: identityHash,
                nickname: profile.nickname || "匿名",
                note: claimNote.trim(),
                files,
            });
            setShowClaim(false);
            setClaimPath(""); setClaimFiles([]); setClaimNote("");
            onNotice?.("找回申请已提交。管理员核实证明后，作品所有权会自动绑定到这台设备的钥匙上");
        } catch (err) {
            onNotice?.(`提交失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setClaimSubmitting(false);
        }
    }, [claimFiles, claimNote, claimPath, identityHash, index, onNotice, profile.nickname, showToast, uploadCfg.endpoint]);

    const handleUploadSubmit = useCallback(async () => {
        const folder = (uploadFolder === CUSTOM_FOLDER ? uploadFolderCustom : uploadFolder).trim();
        const name = uploadName.trim();
        if (!folder || !name) { onNotice?.("请填写分类和资源名称"); return; }
        // 文件不再是必须的：资源文件、配图都可以没有，纯说明文字也能发帖。
        // 只有分类和名称仍然必填（它们决定资源在仓库里的落点）。
        setUploading(true);
        try {
            // 「选择资源文件」里的图片要标成资源本体（PNG 角色卡、表情包），
            // 否则索引会按扩展名把它当配图，详情页里就只能看不能下载了。
            const files = await Promise.all([
                ...uploadFiles.map(file => fileToUploadEntry(file, { asset: true })),
                ...uploadImages.map(file => fileToUploadEntry(file)),
            ]);
            const result = await uploadResource(source, {
                folder, name,
                author: uploadAuthor.trim() || profile.nickname,
                description: uploadDesc.trim(),
                files,
                // 头像随资源发布，别人在详情页也能看到作者头像
                avatarBase64: avatarBase64(profile.avatarDataUrl) || undefined,
            });
            setShowUpload(false);
            closeRichPickers();
            uploadNameRef.current?.setMarkup(""); uploadDescRef.current?.setMarkup("");
            setUploadFiles([]); setUploadImages([]); setUploadFolderCustom("");
            onNotice?.(result.merged
                ? `「${name}」已上架（CDN 缓存刷新后可见）`
                : `「${name}」已提交，等待管理员审核上架`);
            // 没确认备份过摊主钥匙的，发布完强制提醒一次（直到确认为止）
            if (kvGet(KEY_BACKUP_DONE_KEY) !== "1") {
                setKeyBackupTouched(false);
                setShowKeyBackup(true);
            }
        } catch (err) {
            onNotice?.(`上传失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setUploading(false);
        }
    }, [onNotice, profile, source, uploadAuthor, uploadDesc, uploadFiles, uploadFolder, uploadFolderCustom, uploadImages, uploadName]);

    // 贴纸/颜色面板 + 排版工具栏：上传弹窗和编辑弹窗共用，靠 field 决定写进哪个编辑器
    const renderStickerPanel = (field: RichField) => (
        <div className="rh-sticker-panel">
            {STICKER_NAMES.map(name => (
                <button key={name} type="button" className="rh-sticker-btn" title={name} onPointerDown={keepSelection} onClick={() => {
                    editorRefFor(field).current?.insertSticker(name);
                    setStickerPickerFor(null);
                }}>
                    <StickerPixelIcon name={name} size={24} />
                </button>
            ))}
        </div>
    );
    const renderColorPanel = (field: RichField) => (
        <div className="rh-color-panel">
            {Object.entries(RICH_COLORS).map(([name, hex]) => (
                <button key={name} type="button" className="rh-color-chip" style={{ background: hex }} title={name} onPointerDown={keepSelection}
                    onClick={() => { wrapTag(name, field); setColorPickerFor(null); }} />
            ))}
        </div>
    );
    /** 标题那种单行输入只给贴纸；说明是整条工具栏 */
    const renderStickerButton = (field: RichField) => (
        <button type="button" className="rh-fmt-btn" data-active={stickerPickerFor === field ? "1" : undefined} onPointerDown={keepSelection}
            onClick={() => { setStickerPickerFor(current => current === field ? null : field); setColorPickerFor(null); }}>贴纸</button>
    );
    const renderFormatBar = (field: RichField) => (
        <div className="rh-fmt-bar">
            {renderStickerButton(field)}
            <button type="button" className="rh-fmt-btn" data-active={colorPickerFor === field ? "1" : undefined} onPointerDown={keepSelection}
                onClick={() => { setColorPickerFor(current => current === field ? null : field); setStickerPickerFor(null); }}>颜色</button>
            <button type="button" className="rh-fmt-btn" onPointerDown={keepSelection} onClick={() => wrapTag("大", field)}>大</button>
            <button type="button" className="rh-fmt-btn" onPointerDown={keepSelection} onClick={() => wrapTag("小", field)}>小</button>
            <button type="button" className="rh-fmt-btn rh-fmt-bold" onPointerDown={keepSelection} onClick={() => wrapTag("粗", field)}>粗</button>
            <button type="button" className="rh-fmt-btn" onPointerDown={keepSelection} onClick={() => clearFormat(field)}>清除</button>
        </div>
    );
    const renderRichPanels = (field: RichField) => (
        <>
            {stickerPickerFor === field && renderStickerPanel(field)}
            {colorPickerFor === field && renderColorPanel(field)}
        </>
    );

    const title = activeEntry ? activeEntry.name : activeFolder ? activeFolder : "资源集市";
    const handleBack = activeEntry
        ? () => setActiveEntry(null)
        : activeFolder
            ? () => setActiveFolder(null)
            : onClose;

    /** 作者头像：优先用随资源发布的 .avatar.png；自己的帖子退回本机头像；都没有就用默认像素头像 */
    const renderAuthorAvatar = (entry: ShareIndexEntry | null, size: number) => {
        const published = entry?.avatar ? resolveResourceHubAssetUrl(source, entry.avatar) : "";
        const local = !entry || myRecordFor(entry.path) ? profile.avatarDataUrl : "";
        const url = published || local;
        return (
            <span className="rh-avatar" style={{ width: size, height: size }}>
                {url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={url} alt="" width={size} height={size} />
                    : <DefaultPixelAvatar size={size} />}
            </span>
        );
    };

    /** 已选文件清单：图标 + 文件名，可单个移除（比只报个数量有用得多） */
    const renderPickedFiles = (files: File[], onRemove: (index: number) => void) => (
        files.length > 0 ? (
            <div className="rh-picked-list">
                {files.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="rh-picked">
                        <FileTypePixelIcon filename={file.name} size={20} />
                        <span className="rh-picked-name">{file.name}</span>
                        <span className="rh-picked-size">{formatFileSize(file.size)}</span>
                        <button type="button" className="rh-picked-x" aria-label={`移除 ${file.name}`}
                            onClick={e => { e.preventDefault(); onRemove(index); }}>✕</button>
                    </div>
                ))}
            </div>
        ) : null
    );

    const renderEntryRow = (entry: ShareIndexEntry, showFolder = false, flowers?: number | "loading") => (
        <button key={entry.path} className="rh-entry" onClick={() => { setActiveEntry(entry); setSelectedFile(entry.files[0] ?? null); }}>
            {entry.images.length > 0 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="rh-entry-thumb" src={resolveResourceHubAssetUrl(source, entry.images[0])} alt="" loading="lazy" />
            ) : (
                <span className="rh-entry-thumb rh-entry-thumb-blank">📄</span>
            )}
            <span className="rh-entry-main">
                <span className="rh-entry-title"><RichText text={entry.name} mode="sticker" /></span>
                {entry.description && <span className="rh-entry-desc"><RichText text={entry.description} mode="inline" /></span>}
                <span className="rh-entry-meta">
                    {[showFolder ? entry.folder : "", formatEntryDate(entry.updatedAt), `${entry.files.length} 个文件`,
                        flowers === undefined ? "" : `🌸 ${flowers === "loading" ? "…" : flowers}`].filter(Boolean).join(" · ")}
                </span>
            </span>
        </button>
    );

    return (
        <div className="rh-root page-shell">
            {/* 窗口标题栏 */}
            <div className="rh-window">
                <div className="rh-titlebar">
                    <span className="rh-titlebar-icon">🗂️</span>
                    <span className="rh-titlebar-text"><RichText text={title} mode="sticker" /> - 资源集市</span>
                    <span className="rh-titlebar-controls">
                        <button className="rh-tb-btn" aria-label="资源仓库设置" onClick={() => { setSourceDraft(source); setShowSourceEditor(true); }}><Settings size={15} strokeWidth={2.25} /></button>
                        <button className="rh-tb-btn" aria-label="刷新" disabled={loadState === "loading"} onClick={() => reload(source, { purge: true })}>
                            {loadState === "loading" ? <PixelHourglass size={13} /> : <RotateCw size={15} strokeWidth={2.25} />}
                        </button>
                        <button className="rh-tb-btn" aria-label="关闭" onClick={onClose}><X size={15} strokeWidth={2.75} /></button>
                    </span>
                </div>

                {/* 工具条（返回/地址） */}
                <div className="rh-toolbar">
                    <button className="rh-btn" onClick={handleBack}>← 返回</button>
                    <span className="rh-address">
                        地址：C:\资源集市{viewMode === "mine" ? "\\我的货摊" : viewMode === "build" ? "\\共同建设" : ""}{activeFolder ? `\\${activeFolder}` : ""}{activeEntry ? `\\${activeEntry.name}` : ""}
                    </span>
                    <button className="rh-btn" onClick={() => setConfirmUpload(true)}>上传</button>
                </div>

                {/* 浏览集市 / 我的货摊 切换 */}
                {!activeEntry && (
                    <div className="rh-tabs">
                        <button className="rh-tab" data-active={viewMode === "market" ? "1" : undefined}
                            onClick={() => setViewMode("market")}>浏览集市</button>
                        <button className="rh-tab" data-active={viewMode === "mine" ? "1" : undefined}
                            onClick={() => { setViewMode("mine"); setActiveFolder(null); setSearchQuery(""); }}>我的货摊</button>
                        <button className="rh-tab" data-active={viewMode === "build" ? "1" : undefined}
                            onClick={enterBuildTab}>共同建设</button>
                    </div>
                )}

                {/* 内容区 */}
                <div className={`rh-body${activeEntry ? " rh-body-detail" : ""}`}>
                    {loadState === "loading" && <div className="rh-center-hint">正在读取目录，请稍候...</div>}

                    {loadState === "error" && (
                        <div className="rh-center-hint">
                            <div className="ts-24 mb-2">🚧</div>
                            资源仓库暂时无法访问（{loadError}）。
                            <br />可能是网络问题或仓库尚未就绪，可点右上角 ⟳ 重试。
                        </div>
                    )}

                    {/* 我的货摊 */}
                    {loadState === "ready" && viewMode === "mine" && !activeEntry && (
                        (myStall.published.length > 0 || myStall.pending.length > 0) ? (
                            <div className="rh-entry-list">
                                {/* 摊主资料卡：头像 + 昵称 + 统计 */}
                                <div className="rh-profile-card">
                                    <label className="rh-profile-avatar" title="点击更换头像">
                                        {renderAuthorAvatar(null, 54)}
                                        <input type="file" accept="image/*" hidden
                                            onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handlePickAvatar(f); }} />
                                        <span className="rh-profile-avatar-hint">换头像</span>
                                    </label>
                                    <div className="rh-profile-main">
                                        <div className="rh-profile-name-row">
                                        {editingNickname ? (
                                            <input
                                                className="rh-input rh-profile-nickname-input"
                                                autoFocus
                                                value={profile.nickname}
                                                placeholder="给自己起个昵称"
                                                maxLength={24}
                                                onChange={e => setProfile(current => ({ ...current, nickname: e.target.value }))}
                                                onBlur={() => { saveHubProfile(profile); setEditingNickname(false); }}
                                                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                            />
                                        ) : (
                                            <button className="rh-profile-nickname" onClick={() => setEditingNickname(true)}>
                                                {profile.nickname || "点这里起个昵称"} <span className="rh-profile-edit-hint">✎</span>
                                            </button>
                                        )}
                                            <button className="rh-key-link" onClick={() => { setClaimFolder(""); setClaimPath(""); setClaimFiles([]); setClaimNote(""); setShowClaim(true); }}>🧾 找回作品</button>
                                        </div>
                                        <div className="rh-profile-stats">
                                            <span>已发布 <b>{myStall.published.length}</b></span>
                                            <span>待审核 <b>{myStall.pending.length}</b></span>
                                            <span>收到 <b>{flowerCounts
                                                ? myStall.published.reduce((sum, e) => sum + (flowerCounts[e.path] ?? 0), 0)
                                                : "…"}</b> 🌸</span>
                                            <button className="rh-key-link" onClick={() => { setKeyImportText(""); setShowKeyDialog(true); }}>🔑 摊主钥匙</button>
                                        </div>
                                    </div>
                                </div>
                                {myStall.published.length > 0 && (
                                    <div className="rh-stall-flowers">
                                        {flowerCounts
                                            ? `🌸 共收到 ${myStall.published.reduce((sum, e) => sum + (flowerCounts[e.path] ?? 0), 0)} 朵花`
                                            : <><PixelHourglass size={13} /> 正在统计收到的花…</>}
                                    </div>
                                )}
                                {myStall.published.map(entry => renderEntryRow(entry, true, flowerCounts ? (flowerCounts[entry.path] ?? 0) : "loading"))}
                                {myStall.pending.map(item => (
                                    <div key={item.name + item.uploadedAt} className="rh-entry rh-entry-pending">
                                        <span className="rh-entry-thumb rh-entry-thumb-blank">⏳</span>
                                        <span className="rh-entry-main">
                                            <span className="rh-entry-title"><RichText text={item.name} mode="sticker" /></span>
                                            <span className="rh-entry-meta">待管理员审核，或索引尚未更新</span>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <>
                                <div className="rh-profile-card">
                                    <label className="rh-profile-avatar" title="点击更换头像">
                                        {renderAuthorAvatar(null, 54)}
                                        <input type="file" accept="image/*" hidden
                                            onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handlePickAvatar(f); }} />
                                        <span className="rh-profile-avatar-hint">换头像</span>
                                    </label>
                                    <div className="rh-profile-main">
                                        <div className="rh-profile-name-row">
                                        {editingNickname ? (
                                            <input
                                                className="rh-input rh-profile-nickname-input"
                                                autoFocus
                                                value={profile.nickname}
                                                placeholder="给自己起个昵称"
                                                maxLength={24}
                                                onChange={e => setProfile(current => ({ ...current, nickname: e.target.value }))}
                                                onBlur={() => { saveHubProfile(profile); setEditingNickname(false); }}
                                                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                            />
                                        ) : (
                                            <button className="rh-profile-nickname" onClick={() => setEditingNickname(true)}>
                                                {profile.nickname || "点这里起个昵称"} <span className="rh-profile-edit-hint">✎</span>
                                            </button>
                                        )}
                                            <button className="rh-key-link" onClick={() => { setClaimFolder(""); setClaimPath(""); setClaimFiles([]); setClaimNote(""); setShowClaim(true); }}>🧾 找回作品</button>
                                        </div>
                                        <div className="rh-profile-stats">
                                            <span>已发布 <b>0</b></span>
                                            <span>待审核 <b>0</b></span>
                                            <span>收到 <b>0</b> 🌸</span>
                                            <button className="rh-key-link" onClick={() => { setKeyImportText(""); setShowKeyDialog(true); }}>🔑 摊主钥匙</button>
                                        </div>
                                    </div>
                                </div>
                                <div className="rh-center-hint">你还没有上传过资源，点右上角「上传」摆个摊吧</div>
                            </>
                        )
                    )}

                    {/* 搜索框（首页与文件夹页显示） */}
                    {loadState === "ready" && viewMode === "market" && !activeEntry && (
                        <div className="rh-search-row">
                            <input
                                className="rh-input rh-search-input"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="搜索资源名称、说明、文件名..."
                            />
                            {searchQuery.trim() && (
                                <button className="rh-btn" onClick={() => setSearchQuery("")}>清除</button>
                            )}
                        </div>
                    )}

                    {/* 搜索结果（有关键词时替代当前列表） */}
                    {loadState === "ready" && viewMode === "market" && !activeEntry && searchResults && (
                        searchResults.length > 0 ? (
                            <div className="rh-entry-list">
                                {searchResults.map(entry => renderEntryRow(entry, true))}
                            </div>
                        ) : (
                            <div className="rh-center-hint">没有匹配「{searchQuery.trim()}」的资源</div>
                        )
                    )}

                    {/* 共同建设：说明 + 贡献墙（只列已采纳） */}
                    {viewMode === "build" && !activeEntry && (
                        <div className="rh-build">
                            <div className="rh-build-intro">
                                <div className="rh-build-stickers">🛠️ ✨ 📱 ✨ 🧸</div>
                                <div className="rh-build-title">一起改进小手机吧～</div>
                                <p>
                                    贡献公开仓库功能已接入<b>工坊</b>，<br />
                                    可以<b className="rh-build-hot">让小坊将你的修改贡献到公开仓库哦～</b><br />
                                    float 会进行飞速审核，感谢您的付出～
                                </p>
                                <div className="rh-build-note">需要自部署版本（有自己的 fork）</div>
                            </div>
                            <div className="rh-build-wall-head">
                                <span className="rh-build-wall-line" />
                                <span className="rh-build-wall-title">🏅 贡 献 墙 🏅</span>
                                <span className="rh-build-wall-line" />
                            </div>
                            <div className="rh-build-wall-sub">每一条被采纳的改进，都会刻在这里</div>
                            {buildWallState === "loading" && <div className="rh-center-hint">正在读取贡献墙...</div>}
                            {buildWallState === "error" && (
                                <div className="rh-center-hint">贡献墙暂时读取失败（GitHub 接口限流），稍后再来看看</div>
                            )}
                            {buildWall && buildWall.length === 0 && (
                                <div className="rh-center-hint">虚位以待——第一个被采纳的改进会出现在这里</div>
                            )}
                            {buildWall && buildWall.length > 0 && (
                                <div className="rh-build-wall">
                                    {buildWall.map(item => (
                                        <div key={item.number} className="rh-build-card">
                                            <div className="rh-build-card-medal">🎖️</div>
                                            <div className="rh-build-card-main">
                                                <div className="rh-build-card-title">{item.title}</div>
                                                <div className="rh-build-card-meta">
                                                    <span className="rh-build-card-name">{item.contributor}</span>
                                                    <span className="rh-build-card-date">{item.mergedAt ? new Date(item.mergedAt).toLocaleDateString("zh-CN") : ""} 采纳</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 首页：文件夹（一行两个） */}
                    {loadState === "ready" && viewMode === "market" && !activeFolder && !searchResults && (
                        index && index.folders.length > 0 ? (
                            <div className="rh-folder-grid">
                                {index.folders.map(folder => (
                                    <button key={folder.name} className="rh-folder" onDoubleClick={() => setActiveFolder(folder.name)} onClick={() => setActiveFolder(folder.name)}>
                                        <span className="rh-folder-icon">📁</span>
                                        <span className="rh-folder-name">{folder.name}</span>
                                        <span className="rh-folder-count">{folder.count} 个对象</span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="rh-center-hint">仓库里还没有资源文件夹</div>
                        )
                    )}

                    {/* 文件夹页：论坛式列表 */}
                    {loadState === "ready" && viewMode === "market" && activeFolder && !activeEntry && !searchResults && (
                        folderEntries.length > 0 ? (
                            <div className="rh-entry-list">
                                {folderEntries.map(entry => renderEntryRow(entry))}
                            </div>
                        ) : (
                            <div className="rh-center-hint">这个文件夹还是空的</div>
                        )
                    )}

                    {/* 资源详情页：上=图文内容区，下=横滑文件条 + 操作按钮 */}
                    {loadState === "ready" && activeEntry && (
                        <div className="rh-detail2">
                            <div className="rh-detail2-main">
                                {/* 发帖式排版：标题 → 正文 → 图片（标记语法经 RichText 安全渲染） */}
                                {/* 第一行：头像 + 昵称/时间 +（作者才有的）编辑、删除 */}
                                <div className="rh-detail2-head">
                                    {renderAuthorAvatar(activeEntry, 40)}
                                    <div className="rh-detail2-head-main">
                                        <div className="rh-detail2-author">
                                            {activeEntry.author?.trim()
                                                || (myRecordFor(activeEntry.path) ? profile.nickname : "")
                                                || "匿名投稿人"}
                                        </div>
                                        <div className="rh-detail2-time">{formatEntryDate(activeEntry.updatedAt)}</div>
                                    </div>
                                    {myRecordFor(activeEntry.path) && (
                                        <div className="rh-detail2-head-actions">
                                            <button className="rh-icon-btn" aria-label="编辑" title="编辑"
                                                onClick={() => openEdit(activeEntry)}>✎</button>
                                            <button className="rh-icon-btn rh-icon-btn-danger" aria-label="删除" title="删除"
                                                onClick={() => setConfirmDeleteEntry(activeEntry)}>🗑</button>
                                        </div>
                                    )}
                                </div>
                                <div className="rh-detail2-title">
                                    <RichText text={activeEntry.name} mode="sticker" />
                                </div>
                                {activeEntry.description
                                    ? <div className="rh-detail2-desc"><RichText text={activeEntry.description} mode="full" /></div>
                                    : <div className="rh-detail2-desc rh-detail2-desc-empty">（该资源没有说明文字）</div>}
                                {activeEntry.images.map(img => {
                                    const url = resolveResourceHubAssetUrl(source, img);
                                    return (
                                        // 点击层放在外层 div 而非 img 本身：iOS WebKit 对非交互元素
                                        // 的点击合成不可靠，聊天页同款结构在 iOS 上验证可用
                                        <div
                                            key={img}
                                            className="rh-detail2-imgwrap"
                                            role="button"
                                            style={{ cursor: "pointer" }}
                                            onClick={e => { e.stopPropagation(); setPreviewImage(url); }}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={url} alt="" loading="lazy" />
                                        </div>
                                    );
                                })}
                            </div>

                            {activeEntry.files.length > 0 ? (
                                    <div className="rh-file-strip">
                                        {activeEntry.files.map(file => {
                                            const base = stripAssetImageMark(file.split("/").pop() || file);
                                            const ext = fileExtension(base);
                                            return (
                                                <button
                                                    key={file}
                                                    className="rh-file-tile"
                                                    data-selected={selectedFile === file ? "1" : undefined}
                                                    onClick={() => setSelectedFile(file)}
                                                >
                                                    <FileTypePixelIcon filename={base} size={36} />
                                                    <span className="rh-file-tile-ext">{ext ? `.${ext.toUpperCase()}` : "FILE"}</span>
                                                    <span className="rh-file-tile-name">{base}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                            ) : (
                                <div className="rh-center-hint">该资源没有可下载的文件</div>
                            )}
                            {/* 操作行不依赖文件：纯文字/纯配图的帖子也要能送花、能被管理员下架 */}
                            <div className="rh-detail2-actions">
                                <button
                                    className="rh-btn rh-flower-btn"
                                    disabled={sendingFlower || hasSentFlowerToday(activeEntry.path)}
                                    title="给作者送一朵花"
                                    onClick={() => void handleSendFlower(activeEntry.path)}
                                >
                                    {sendingFlower
                                        ? <><PixelHourglass size={13} /> 送出中</>
                                        : hasSentFlowerToday(activeEntry.path) ? "已送🌸" : "送花🌸"}
                                </button>
                                {activeEntry.files.length > 0 && (
                                    <>
                                        <button className="rh-btn rh-action-half" disabled={!selectedFile || busyFile === selectedFile} onClick={() => selectedFile && handleDownload(selectedFile)}>
                                            {busyFile === selectedFile && !importingTo
                                                ? <><PixelHourglass size={13} /> 下载中</>
                                                : "下载"}
                                        </button>
                                        <button className="rh-btn rh-btn-primary rh-action-half" disabled={!selectedFile || busyFile === selectedFile} onClick={() => selectedFile && setImportFile(selectedFile)}>
                                            {busyFile === selectedFile && importingTo
                                                ? <><PixelHourglass size={13} /> 导入中</>
                                                : "导入"}
                                        </button>
                                    </>
                                )}
                                {/* 作者的编辑/删除已移到顶部作者行；这里只留管理员下架入口 */}
                                {uploadCfg.githubToken.trim() && !myRecordFor(activeEntry.path) && (
                                    <button className="rh-btn rh-action-del" onClick={() => setConfirmDeleteEntry(activeEntry)}>下架</button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* 状态栏 */}
                <div className="rh-statusbar">
                    <span>
                        {loadState === "ready"
                            ? activeFolder
                                ? `${folderEntries.length} 个对象`
                                : `${index?.folders.length ?? 0} 个文件夹`
                            : "..."}
                    </span>
                    <span>资源仓库：{source.owner}/{source.repo}</span>
                </div>
            </div>

            {/* 导入目的地选择 */}
            {importFile && (
                <div className="rh-dialog-overlay" onClick={importingTo ? undefined : () => setImportFile(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">导入到...</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={!!importingTo} onClick={() => setImportFile(null)}>✕</button>
                            </span>
                        </div>
                        {/* 文件全名（文件条里显示不全，这里完整展示） */}
                        <div className="rh-import-filename">{stripAssetImageMark(importFile.split("/").pop() || importFile)}</div>
                        <div className="rh-dialog-body rh-dest-grid">
                            {IMPORT_DESTINATIONS.map(dest => (
                                <button key={dest.key} className="rh-dest-tile" title={dest.hint}
                                    disabled={!!importingTo} onClick={() => handlePickDestination(dest.key)}>
                                    {/* 正在导入的那一格换成沙漏，反馈就在刚点的位置上 */}
                                    {importingTo === dest.key ? <PixelHourglass size={34} /> : <DestPixelIcon dest={dest.key} />}
                                    <span className="rh-dest-tile-label">{importingTo === dest.key ? "导入中…" : dest.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* 聊天室 CSS：选择角色 */}
            {pickCharacterFor && (
                <div className="rh-dialog-overlay" onClick={importingTo ? undefined : () => setPickCharacterFor(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">应用到哪个角色的聊天室？</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={!!importingTo} onClick={() => setPickCharacterFor(null)}>✕</button>
                            </span>
                        </div>
                        <div className="rh-dialog-body rh-dest-list">
                            {chatContacts.length > 0 ? chatContacts.map(contact => (
                                <button key={contact.contactId} className="rh-dest" disabled={!!importingTo}
                                    onClick={() => void runImport(pickCharacterFor, "chat_session_css", contact.contactId)}>
                                    <span className="rh-dest-label">
                                        {importingTo === contact.contactId && <><PixelHourglass size={13} /> </>}
                                        {contact.name}
                                    </span>
                                </button>
                            )) : (
                                <div className="rh-center-hint">还没有聊天联系人，先去聊天里添加角色吧</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* 删除确认（管理员） */}
            {confirmDeleteEntry && (
                <div className="rh-dialog-overlay" onClick={deleting ? undefined : () => setConfirmDeleteEntry(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">下架资源</span></div>
                        <div className="rh-dialog-body">
                            <span className="rh-dialog-icon">🗑️</span>
                            确认删除「{confirmDeleteEntry.name}」？将从资源仓库移除其全部文件，此操作对所有用户生效。
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={deleting} onClick={() => setConfirmDeleteEntry(null)}>取消</button>
                            <button className="rh-btn rh-action-del" disabled={deleting} onClick={() => void handleDeleteEntry(confirmDeleteEntry)}>
                                {deleting ? <><PixelHourglass size={13} /> 删除中…</> : "确认删除"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 摊主钥匙：换设备时带走它，就能继续管理自己的发布 */}
            {showKeyDialog && (
                <div className="rh-dialog-overlay" onClick={() => setShowKeyDialog(false)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">摊主钥匙</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" onClick={() => setShowKeyDialog(false)}>✕</button>
                            </span>
                        </div>
                        <div className="rh-dialog-body rh-form">
                            <div className="rh-key-warning">
                                🔑 这串码就是你对自己所有发布的所有权证明。<b>换手机/重装前请存好</b>，
                                在新设备粘贴它，货摊和编辑权限就都回来了。<b>不要发给任何人</b>——
                                拿到的人能改能删你的全部资源。
                            </div>
                            <div className="rh-form-field">
                                <span>我的钥匙（长按可复制）</span>
                                <textarea className="rh-input rh-key-text" readOnly rows={3} value={exportKeyBundle(identityKey)}
                                    onFocus={e => e.currentTarget.select()} />
                            </div>
                            <button className="rh-btn" onClick={async () => {
                                try {
                                    await navigator.clipboard.writeText(exportKeyBundle(identityKey));
                                    showToast("钥匙已复制，找个安全地方存好");
                                } catch {
                                    showToast("复制失败，请长按上面的文字手动复制");
                                }
                            }}>复制钥匙</button>
                            <div className="rh-form-field">
                                <span>在新设备上：粘贴钥匙并导入</span>
                                <textarea className="rh-input rh-key-text" rows={3} value={keyImportText}
                                    placeholder="粘贴从旧设备复制的钥匙…"
                                    onChange={e => setKeyImportText(e.target.value)} />
                            </div>
                            <button className="rh-btn rh-btn-primary" disabled={!keyImportText.trim()} onClick={() => {
                                try {
                                    const parsed = parseKeyBundle(keyImportText);
                                    setIdentityKey(parsed.identity);
                                    setIdentityKeyState(parsed.identity);
                                    if (parsed.legacy.length) mergeMyUploads(parsed.legacy);
                                    void sha256Hex(parsed.identity).then(setIdentityHash);
                                    setShowKeyDialog(false);
                                    setKeyImportText("");
                                    onNotice?.("钥匙已导入，你的发布正在认领回来");
                                } catch (err) {
                                    showToast(err instanceof Error ? err.message : "导入失败");
                                }
                            }}>导入钥匙</button>
                            <div className="rh-form-hint">
                                导入后本机原来的钥匙会被替换。如果两台设备都发过资源，
                                请先在另一台导出、这里导入，两边的发布才会合并到一把钥匙下管理。
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* 找回作品：选资源 + 传证明，开申请给管理员人工审核 */}
            {showClaim && (
                <div className="rh-dialog-overlay" onClick={claimSubmitting ? undefined : () => setShowClaim(false)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">找回作品</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={claimSubmitting} onClick={() => setShowClaim(false)}>✕</button>
                            </span>
                        </div>
                        <div className="rh-dialog-body rh-form">
                            <div className="rh-form-hint">
                                换设备或丢失摊主钥匙后，可以在这里申请找回自己发布的作品。
                                管理员核实证明材料后，作品所有权会绑定到你现在这台设备的钥匙上。
                            </div>
                            <div className="rh-form-field">
                                <span>要找回的作品</span>
                                <select className="rh-input" value={claimFolder}
                                    onChange={e => { setClaimFolder(e.target.value); setClaimPath(""); }}>
                                    <option value="">先选文件夹…</option>
                                    {(index?.folders ?? []).map(folder => (
                                        <option key={folder.name} value={folder.name}>{folder.name}</option>
                                    ))}
                                </select>
                                <select className="rh-input" value={claimPath} disabled={!claimFolder}
                                    onChange={e => setClaimPath(e.target.value)}>
                                    <option value="">{claimFolder ? "再选作品…" : "（先选上面的文件夹）"}</option>
                                    {(index?.entries ?? [])
                                        .filter(entry => entry.folder === claimFolder && !myRecordFor(entry.path))
                                        .map(entry => (
                                            <option key={entry.path} value={entry.path}>{entry.name}</option>
                                        ))}
                                </select>
                            </div>
                            <div className="rh-form-field">
                                <span>证明文件（必传，最多 6 个，共 ≤4MB）</span>
                                <label className="rh-btn rh-file-pick-btn">
                                    选择证明文件…
                                    <input type="file" multiple hidden onChange={e => {
                                        const picked = Array.from(e.target.files ?? []);
                                        setClaimFiles(current => [...current, ...picked].slice(0, 6));
                                        e.target.value = "";
                                    }} />
                                </label>
                                {claimFiles.length > 0 && (
                                    <div className="rh-claim-files">
                                        {claimFiles.map((file, i) => (
                                            <button key={`${file.name}-${i}`} className="rh-claim-file" title="点击移除"
                                                onClick={() => setClaimFiles(current => current.filter((_, idx) => idx !== i))}>
                                                {file.name} ✕
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="rh-form-hint">
                                    需要能<b>完整证明作品是你创作的</b>的材料：原始工程文件、创作过程截图、
                                    带时间的草稿等。证明不足会被拒绝。
                                </div>
                            </div>
                            <div className="rh-form-field">
                                <span>备注（选填）</span>
                                <textarea className="rh-input" rows={2} maxLength={500} value={claimNote}
                                    placeholder="例如：换手机丢了钥匙，原昵称是……"
                                    onChange={e => setClaimNote(e.target.value)} />
                            </div>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={claimSubmitting} onClick={() => setShowClaim(false)}>取消</button>
                            <button className="rh-btn rh-btn-primary" disabled={claimSubmitting || !claimPath || claimFiles.length === 0}
                                onClick={() => void handleSubmitClaim()}>
                                {claimSubmitting ? <><PixelHourglass size={13} /> 提交中</> : "提交申请"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 发布成功后的强制钥匙备份（不可跳过：必须保存或复制后才能关闭） */}
            {showKeyBackup && (
                <div className="rh-dialog-overlay">
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">请备份你的摊主钥匙</span></div>
                        <div className="rh-dialog-body rh-form">
                            <div className="rh-key-danger">⚠️ 钥匙丢失将无法找回作品所有权</div>
                            <div className="rh-form-hint">
                                这串码是你对自己所有发布的唯一所有权证明，换设备、清理浏览器数据后全靠它找回。
                                请立刻保存到文件或备忘录（只需这一次）。不要发给任何人。
                            </div>
                            <textarea className="rh-input rh-key-text" readOnly rows={3} value={exportKeyBundle(identityKey)}
                                onFocus={e => e.currentTarget.select()} />
                            <div className="rh-key-backup-actions">
                                <button className="rh-btn" onClick={() => {
                                    try {
                                        const blob = new Blob([exportKeyBundle(identityKey)], { type: "text/plain;charset=utf-8" });
                                        const url = URL.createObjectURL(blob);
                                        const anchor = document.createElement("a");
                                        anchor.href = url;
                                        anchor.download = "小手机摊主钥匙.txt";
                                        anchor.click();
                                        setTimeout(() => URL.revokeObjectURL(url), 4000);
                                        setKeyBackupTouched(true);
                                        showToast("已开始保存，请确认文件存好了");
                                    } catch {
                                        showToast("保存失败，请用「复制钥匙」");
                                    }
                                }}>保存为文件</button>
                                <button className="rh-btn" onClick={async () => {
                                    try {
                                        await navigator.clipboard.writeText(exportKeyBundle(identityKey));
                                        setKeyBackupTouched(true);
                                        showToast("已复制，请立刻粘贴到备忘录保存");
                                    } catch {
                                        showToast("复制失败，请长按上面的文字手动复制");
                                    }
                                }}>复制钥匙</button>
                            </div>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn rh-btn-primary" disabled={!keyBackupTouched}
                                title={keyBackupTouched ? undefined : "先保存或复制钥匙"}
                                onClick={() => { kvSet(KEY_BACKUP_DONE_KEY, "1"); setShowKeyBackup(false); }}>
                                我已保存好
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 编辑已发布的资源（仅作者，凭本机凭证） */}
            {editEntry && (
                <div className="rh-dialog-overlay" onClick={savingEdit ? undefined : () => { setEditEntry(null); closeRichPickers(); }}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">编辑资源</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={savingEdit} onClick={() => { setEditEntry(null); closeRichPickers(); }}>✕</button>
                            </span>
                        </div>
                        <div className="rh-dialog-body rh-form">
                            <div className="rh-form-field">
                                <span>标题（可加像素贴纸）</span>
                                <div className="rh-input-row">
                                    <RichEditor ref={editTitleRef} className="rh-input rh-editor rh-editor-line"
                                        placeholder="标题" ariaLabel="编辑标题" singleLine onChange={setEditTitle} />
                                    {renderStickerButton("editTitle")}
                                </div>
                                {renderRichPanels("editTitle")}
                            </div>
                            <label>投稿人
                                <input className="rh-input" value={editAuthor} maxLength={24}
                                    onChange={e => setEditAuthor(e.target.value)} />
                            </label>
                            <div className="rh-form-field">
                                <span>说明文字（选中文字后点按钮排版）</span>
                                {renderFormatBar("editDesc")}
                                {renderRichPanels("editDesc")}
                                <RichEditor ref={editDescRef} className="rh-input rh-editor rh-editor-area"
                                    placeholder="写点介绍吧～" ariaLabel="编辑说明" onChange={setEditDesc} />
                            </div>
                            <div className="rh-form-field">
                                <span>现有文件（打叉即移除）</span>
                                <div className="rh-edit-files">
                                    {[...editEntry.files, ...editEntry.images].map(file => {
                                        const base = stripAssetImageMark(file.split("/").pop() || file);
                                        const removed = editRemoved.includes(file);
                                        const isImage = editEntry.images.includes(file);
                                        return (
                                            <button key={file} className="rh-edit-file" data-removed={removed ? "1" : undefined}
                                                onClick={() => setEditRemoved(current =>
                                                    removed ? current.filter(f => f !== file) : [...current, file])}>
                                                <span className="rh-edit-file-name">{isImage ? `${base}（配图）` : base}</span>
                                                <span className="rh-edit-file-x">{removed ? "撤销" : "✕"}</span>
                                            </button>
                                        );
                                    })}
                                    {editEntry.files.length + editEntry.images.length === 0 && (
                                        <span className="rh-form-hint">（这个资源还没有文件）</span>
                                    )}
                                </div>
                            </div>
                            <label className="rh-file-picker">
                                <span className="rh-btn">{editAddFiles.length > 0 ? "继续添加资源文件" : "添加/替换资源文件"}</span>
                                <input type="file" multiple hidden onChange={e => { const picked = Array.from(e.target.files ?? []); setEditAddFiles(current => appendPickedFiles(current, picked)); e.target.value = ""; }} />
                            </label>
                            {renderPickedFiles(editAddFiles, index => setEditAddFiles(current => current.filter((_, i) => i !== index)))}
                            <label className="rh-file-picker">
                                <span className="rh-btn">{editAddImages.length > 0 ? "继续添加配图" : "添加配图"}</span>
                                <input type="file" accept="image/*" multiple hidden onChange={e => { const picked = Array.from(e.target.files ?? []); setEditAddImages(current => appendPickedFiles(current, picked)); e.target.value = ""; }} />
                            </label>
                            {renderPickedFiles(editAddImages, index => setEditAddImages(current => current.filter((_, i) => i !== index)))}
                            <div className="rh-form-hint">同名文件会被覆盖；保存后立即生效，索引刷新后所有人可见。</div>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={savingEdit} onClick={() => { setEditEntry(null); closeRichPickers(); }}>取消</button>
                            <button className="rh-btn rh-btn-primary" disabled={savingEdit} onClick={() => void handleSaveEdit()}>
                                {savingEdit ? <><PixelHourglass size={13} /> 保存中…</> : "保存"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 上传对话框 */}
            {showUpload && (
                <div className="rh-dialog-overlay" onClick={uploading ? undefined : () => { setShowUpload(false); closeRichPickers(); }}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">上传资源</span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={uploading} onClick={() => { setShowUpload(false); closeRichPickers(); }}>✕</button>
                            </span>
                        </div>
                        <div className="rh-dialog-body rh-form">
                            <label>分类
                                <select className="rh-input" value={uploadFolder} onChange={e => setUploadFolder(e.target.value)}>
                                    <option value="">请选择分类...</option>
                                    {(index?.folders ?? []).map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                                    <option value={CUSTOM_FOLDER}>＋ 自定义新分类</option>
                                </select>
                            </label>
                            {uploadFolder === CUSTOM_FOLDER && (
                                <label>新分类名
                                    <input className="rh-input" value={uploadFolderCustom} placeholder="例如：表情包" onChange={e => setUploadFolderCustom(e.target.value)} />
                                </label>
                            )}
                            <div className="rh-form-field">
                                <span>资源名称（可加像素贴纸）</span>
                                <div className="rh-input-row">
                                    <RichEditor
                                        ref={uploadNameRef}
                                        className="rh-input rh-editor rh-editor-line"
                                        placeholder="例如：唐簪雪"
                                        ariaLabel="资源名称"
                                        singleLine
                                        onChange={setUploadName}
                                    />
                                    {renderStickerButton("uploadTitle")}
                                </div>
                                {renderRichPanels("uploadTitle")}
                            </div>
                            <label>投稿人（可选）
                                <input className="rh-input" value={uploadAuthor} onChange={e => setUploadAuthor(e.target.value)} />
                            </label>
                            <div className="rh-form-field">
                                <span>说明文字（可选，会显示在列表里。选中文字后点按钮排版）</span>
                                {renderFormatBar("uploadDesc")}
                                {renderRichPanels("uploadDesc")}
                                <RichEditor
                                    ref={uploadDescRef}
                                    className="rh-input rh-editor rh-editor-area"
                                    placeholder="写点介绍吧～选中文字可以改颜色、字号、加粗"
                                    ariaLabel="说明文字"
                                    onChange={setUploadDesc}
                                />
                            </div>
                            <label className="rh-file-picker">
                                <span className="rh-btn">{uploadFiles.length > 0 ? "继续添加文件" : "选择资源文件"}</span>
                                <input type="file" multiple hidden onChange={e => { const picked = Array.from(e.target.files ?? []); setUploadFiles(current => appendPickedFiles(current, picked)); e.target.value = ""; }} />
                            </label>
                            {renderPickedFiles(uploadFiles, index => setUploadFiles(current => current.filter((_, i) => i !== index)))}
                            <label className="rh-file-picker">
                                <span className="rh-btn">{uploadImages.length > 0 ? "继续添加配图" : "选择配图（可选）"}</span>
                                <input type="file" accept="image/*" multiple hidden onChange={e => { const picked = Array.from(e.target.files ?? []); setUploadImages(current => appendPickedFiles(current, picked)); e.target.value = ""; }} />
                            </label>
                            {renderPickedFiles(uploadImages, index => setUploadImages(current => current.filter((_, i) => i !== index)))}
                            <div className="rh-form-hint">
                                {uploadCfg.githubToken
                                    ? "将使用你的 GitHub Token 提交（有仓库权限则直接上架，否则生成待审核投稿）。"
                                    : "将匿名提交到审核队列，管理员通过后上架。单次总量 ≤5MB。"}
                            </div>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={uploading} onClick={() => { setShowUpload(false); closeRichPickers(); }}>取消</button>
                            <button className="rh-btn rh-btn-primary" disabled={uploading} onClick={() => void handleUploadSubmit()}>
                                {uploading ? <><PixelHourglass size={13} /> 提交中…</> : "提交"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 公开性确认：点「上传」先过这一关，确认后才打开上传表单 */}
            {confirmUpload && (
                <div className="rh-dialog-overlay" onClick={() => setConfirmUpload(false)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">确认上传</span></div>
                        <div className="rh-dialog-body">
                            <span className="rh-dialog-icon">⚠️</span>
                            <span>
                                上传文件将会上传到公开 GitHub 仓库，<b>所有人可见</b>，请确保这是你的意愿。
                            </span>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" onClick={() => setConfirmUpload(false)}>取消</button>
                            <button className="rh-btn rh-btn-primary" onClick={() => {
                                setConfirmUpload(false);
                                setUploadFolder(activeFolder || "");
                                setUploadAuthor(profile.nickname);
                                setShowUpload(true);
                                closeRichPickers();
                            }}>确认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 预设条目：新增 or 覆盖 → 选预设 → 选位置 */}
            {entryImport && (
                <div className="rh-dialog-overlay" onClick={entryBusy ? undefined : () => setEntryImport(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar">
                            <span className="rh-titlebar-text">
                                {!entryImport.mode ? "导入预设条目"
                                    : !entryImport.preset ? "导入到哪个预设？"
                                        : entryImport.mode === "insert" ? "插到哪一条后面？" : "覆盖哪一条？"}
                            </span>
                            <span className="rh-titlebar-controls">
                                <button className="rh-tb-btn" disabled={entryBusy} onClick={() => setEntryImport(null)}>✕</button>
                            </span>
                        </div>
                        <div className="rh-import-filename">条目：{entryImport.prompt.name || entryImport.prompt.identifier}</div>

                        {/* 第一步：新增还是覆盖 */}
                        {!entryImport.mode && (
                            <div className="rh-dialog-body rh-dest-list">
                                <button className="rh-dest" onClick={() => setEntryImport(v => v && { ...v, mode: "insert" })}>
                                    <span className="rh-dest-label">新增 —— 插入到某一条之后</span>
                                </button>
                                <button className="rh-dest" onClick={() => setEntryImport(v => v && { ...v, mode: "replace" })}>
                                    <span className="rh-dest-label">覆盖 —— 替换掉某一条</span>
                                </button>
                            </div>
                        )}

                        {/* 第二步：选预设 */}
                        {entryImport.mode && !entryImport.preset && (
                            <div className="rh-dialog-body rh-dest-list">
                                {loadPresets().length > 0 ? loadPresets().map(preset => (
                                    <button key={preset.id} className="rh-dest"
                                        onClick={() => setEntryImport(v => v && { ...v, preset })}>
                                        <span className="rh-dest-label">{preset.name}</span>
                                        <span className="rh-dest-hint">{preset.prompts.length} 条</span>
                                    </button>
                                )) : <div className="rh-center-hint">还没有任何预设，先去设置里建一个吧</div>}
                            </div>
                        )}

                        {/* 第三步：选位置。用显示顺序，与预设管理页看到的一致 */}
                        {entryImport.mode && entryImport.preset && (
                            <div className="rh-dialog-body rh-dest-list">
                                {entryImport.mode === "insert" && (
                                    <button className="rh-dest" disabled={entryBusy}
                                        onClick={() => void runEntryImport(null)}>
                                        <span className="rh-dest-label">▲ 放到最前面</span>
                                    </button>
                                )}
                                {displayOrderPrompts(entryImport.preset).map(p => (
                                    <button key={p.identifier} className="rh-dest" disabled={entryBusy}
                                        onClick={() => void runEntryImport(p.identifier)}>
                                        <span className="rh-dest-label">
                                            {entryBusy && <><PixelHourglass size={13} /> </>}
                                            {p.name || p.identifier}
                                        </span>
                                        <span className="rh-dest-hint">{p.marker ? "占位条目" : p.role}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 主题包覆盖确认：主题包是整体替换当前外观，不是叠加 */}
            {confirmTheme && (
                <div className="rh-dialog-overlay" onClick={importingTo ? undefined : () => setConfirmTheme(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">应用主题包</span></div>
                        <div className="rh-dialog-body">
                            <span className="rh-dialog-icon">🎨</span>
                            <span>
                                主题包会<b>整体覆盖你当前的外观</b>——主题色、壁纸、图标样式、桌面组件和图标位置都会换成这一套。
                                想留住现在的样子，可以先去外观页导出一份自己的主题包。已安装的自定义 App 图标会自动排回桌面空位，不会丢。
                            </span>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={!!importingTo} onClick={() => setConfirmTheme(null)}>取消</button>
                            <button className="rh-btn rh-btn-primary" disabled={!!importingTo} onClick={() => {
                                const target = confirmTheme;
                                setConfirmTheme(null);
                                void runImport(target, "theme");
                            }}>确认应用</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 插件安装告知：插件与本应用同权限，装上即执行，必须先问一句 */}
            {confirmPlugin && (
                <div className="rh-dialog-overlay" onClick={importingTo ? undefined : () => setConfirmPlugin(null)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">安装插件</span></div>
                        <div className="rh-dialog-body">
                            <span className="rh-dialog-icon">⚠️</span>
                            <span>
                                插件将与应用本身拥有<b>相同的能力</b>（包括访问你的 API 配置与全部聊天数据），
                                且安装后立即启用。这是其他用户上传的代码，请只安装你信任的来源。确认安装吗？
                            </span>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" disabled={!!importingTo} onClick={() => setConfirmPlugin(null)}>取消</button>
                            <button className="rh-btn rh-btn-primary" disabled={!!importingTo} onClick={() => {
                                const target = confirmPlugin;
                                setConfirmPlugin(null);
                                void runImport(target, "plugin");
                            }}>确认安装</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 开屏版权提示：进 app 先说清楚集市作品只能本机用，「永不显示」写进 kv 后不再弹 */}
            {showNotice && (
                <div className="rh-dialog-overlay">
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">资源市场 APP 须知</span></div>
                        <div className="rh-dialog-body rh-notice-body">
                            <p>
                                <span className="rh-notice-no">1.</span>
                                上传内容将会发布于公开仓库，你设置的头像、昵称、正文内容、资源文件<b>所有人可见</b>，
                                请确保你知晓以上内容，<b>保护个人隐私</b>，并发布<b>网络允许的安全内容</b>。
                            </p>
                            <p>
                                <span className="rh-notice-no">2.</span>
                                为了保护创作者权益，从资源市场导入的他人作品，仅限于本地运行，
                                <b>不能将他人的作品发布市场</b>。
                            </p>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" onClick={() => {
                                kvSet(NOTICE_DISMISSED_KEY, "1");
                                setShowNotice(false);
                            }}>永不显示</button>
                            <button className="rh-btn rh-btn-primary" onClick={() => setShowNotice(false)}>确认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 资源仓库设置 */}
            {showSourceEditor && (
                <div className="rh-dialog-overlay" onClick={() => setShowSourceEditor(false)}>
                    <div className="rh-dialog" onClick={e => e.stopPropagation()}>
                        <div className="rh-titlebar"><span className="rh-titlebar-text">资源仓库</span></div>
                        <div className="rh-dialog-body rh-form">
                            <label>GitHub 用户/组织
                                <input className="rh-input" value={sourceDraft.owner} onChange={e => setSourceDraft(prev => ({ ...prev, owner: e.target.value }))} />
                            </label>
                            <label>仓库名
                                <input className="rh-input" value={sourceDraft.repo} onChange={e => setSourceDraft(prev => ({ ...prev, repo: e.target.value }))} />
                            </label>
                            <label>分支
                                <input className="rh-input" value={sourceDraft.branch} placeholder="main" onChange={e => setSourceDraft(prev => ({ ...prev, branch: e.target.value }))} />
                            </label>
                            <div className="rh-form-hint">资源经 jsDelivr CDN 读取，公开仓库无需登录。除非换资源源，一般不用改。</div>
                            <label>GitHub Token（可选，上传直传用）
                                <input className="rh-input" type="password" value={uploadCfg.githubToken} placeholder="不填则上传走匿名审核队列" onChange={e => setUploadCfg(prev => ({ ...prev, githubToken: e.target.value }))} />
                            </label>
                            <label>上传服务地址
                                <input className="rh-input" value={uploadCfg.endpoint} onChange={e => setUploadCfg(prev => ({ ...prev, endpoint: e.target.value }))} />
                            </label>
                        </div>
                        <div className="rh-dialog-footer">
                            <button className="rh-btn" onClick={() => setShowSourceEditor(false)}>取消</button>
                            <button className="rh-btn rh-btn-primary" onClick={() => {
                                const next: ResourceHubSource = {
                                    owner: sourceDraft.owner.trim(),
                                    repo: sourceDraft.repo.trim(),
                                    branch: sourceDraft.branch.trim() || "main",
                                };
                                if (!next.owner || !next.repo) { onNotice?.("仓库 owner 和名称不能为空"); return; }
                                saveResourceHubSource(next);
                                saveUploadConfig(uploadCfg);
                                setUploadCfg(loadUploadConfig());
                                setSource(next);
                                setActiveFolder(null);
                                setActiveEntry(null);
                                setShowSourceEditor(false);
                            }}>保存</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 非阻塞小提示（送花等轻量反馈） */}
            {toast && <div className="rh-toast">{toast}</div>}

            {/* 图片全屏预览（与聊天/动态页一致，含保存按钮） */}
            {previewImage && (
                <MediaPreviewOverlay
                    imageUrl={previewImage}
                    saveFilename={(previewImage.split("/").pop() || "图片").split("?")[0]}
                    onClose={() => setPreviewImage(null)}
                />
            )}

            <style>{`
                .rh-root {
                    position: absolute;
                    inset: 0;
                    background: #008080;
                    padding: calc(var(--status-bar-top, 12px) + 48px) 10px 16px;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .rh-root, .rh-root button, .rh-root input {
                    font-family: "Microsoft YaHei", "PingFang SC", Tahoma, "MS Sans Serif", sans-serif;
                }
                .rh-window {
                    flex: 1;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    background: #c0c0c0;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    box-shadow: 1px 1px 0 #000;
                }
                .rh-titlebar {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 3px 4px 3px 6px;
                    background: linear-gradient(90deg, #000080, #1084d0);
                    color: #fff;
                    font-size: calc(13px * var(--app-text-scale, 1));
                    font-weight: 700;
                    user-select: none;
                    flex-shrink: 0;
                }
                .rh-titlebar-text {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-titlebar-controls { display: flex; gap: 3px; }
                .rh-tb-btn {
                    width: 28px;
                    height: 24px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    background: #c0c0c0;
                    color: #000;
                    font-size: 15px;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                    padding: 0;
                }
                .rh-tb-btn:active { border-color: #404040 #ffffff #ffffff #404040; }
                .rh-toolbar {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 5px 6px;
                    border-bottom: 1px solid #808080;
                    box-shadow: 0 1px 0 #fff;
                    flex-shrink: 0;
                }
                .rh-address {
                    flex: 1;
                    min-width: 0;
                    background: #fff;
                    border: 2px solid;
                    border-color: #404040 #ffffff #ffffff #404040;
                    padding: 3px 6px;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #000;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-btn {
                    background: #c0c0c0;
                    color: #000;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    padding: 4px 12px;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .rh-btn:active { border-color: #404040 #ffffff #ffffff #404040; }
                /* 忙碌态：按钮里的沙漏与文字并排居中 */
                .rh-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
                .rh-btn:disabled { color: #808080; text-shadow: 1px 1px 0 #fff; cursor: default; }
                .rh-btn-primary { font-weight: 700; outline: 1px solid #000; }
                /* 浏览集市 / 我的货摊 切换（仿 Win98 标签页按钮） */
                .rh-tabs {
                    display: flex;
                    gap: 4px;
                    padding: 5px 6px 0;
                    flex-shrink: 0;
                }
                .rh-tab {
                    flex: 1;
                    padding: 5px 0;
                    background: #b0b0b0;
                    color: #404040;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                }
                .rh-tab[data-active] {
                    background: #fff;
                    color: #000080;
                    font-weight: 700;
                    border-color: #404040 #ffffff #ffffff #404040;
                }
                .rh-body {
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    background: #fff;
                    border: 2px solid;
                    border-color: #404040 #ffffff #ffffff #404040;
                    margin: 6px;
                    color: #000;
                }
                .rh-center-hint {
                    padding: 42px 20px;
                    text-align: center;
                    color: #404040;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    line-height: 1.8;
                }
                /* 首页文件夹网格：一行两个 */
                .rh-folder-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 4px;
                    padding: 10px;
                }
                .rh-folder {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 2px;
                    padding: 14px 6px 10px;
                    background: none;
                    border: 1px dotted transparent;
                    cursor: pointer;
                }
                .rh-folder:active { border-color: #000080; background: #e4ecf7; }
                .rh-folder-icon { font-size: 40px; line-height: 1; }
                .rh-build { display: flex; flex-direction: column; gap: 12px; padding: 6px 2px; }
                .rh-build-intro { padding: 14px 8px 6px; text-align: center; }
                .rh-build-stickers { font-size: 19px; letter-spacing: 7px; margin-bottom: 8px; }
                .rh-build-title { font-weight: 800; font-size: 16px; color: #000080; margin-bottom: 7px; }
                .rh-build-intro p { margin: 0; font-size: 12.5px; line-height: 1.9; color: #333; }
                .rh-build-intro p b { color: #000080; }
                .rh-build-intro p b.rh-build-hot { color: #cc0000; }
                .rh-build-note { font-size: 11px; color: #888; margin-top: 7px; }
                .rh-build-wall-head { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
                .rh-build-wall-line { flex: 1; height: 0; border-top: 1px solid #808080; box-shadow: 0 1px 0 #fff; }
                .rh-build-wall-title { font-weight: 800; font-size: 13px; color: #000080; white-space: nowrap; }
                .rh-build-wall-sub { text-align: center; font-size: 11px; color: #666; margin-top: -6px; }
                .rh-build-wall { display: flex; flex-direction: column; gap: 8px; }
                .rh-build-card {
                    display: flex; align-items: center; gap: 10px;
                    border: 1px solid #b8bfc9;
                    background: #fff;
                    padding: 10px 10px;
                }
                .rh-build-card-medal { font-size: 22px; line-height: 1; flex: none; }
                .rh-build-card-main { flex: 1; min-width: 0; }
                .rh-build-card-title { font-size: 12.5px; font-weight: 700; line-height: 1.5; color: #000; }
                .rh-build-card-meta { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; margin-top: 4px; }
                .rh-build-card-name { font-weight: 700; color: #000080; }
                .rh-build-card-date { color: #555; }
                .rh-folder-name {
                    font-size: calc(13px * var(--app-text-scale, 1));
                    color: #000;
                    word-break: break-all;
                }
                .rh-folder-count { font-size: calc(10px * var(--app-text-scale, 1)); color: #808080; }
                /* 论坛式条目列表 */
                .rh-entry-list { display: flex; flex-direction: column; }
                .rh-entry {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    padding: 10px;
                    background: none;
                    border: none;
                    border-bottom: 1px solid #d4d0c8;
                    cursor: pointer;
                    text-align: left;
                }
                .rh-entry:active { background: #e4ecf7; }
                .rh-entry-pending { cursor: default; opacity: 0.72; }
                .rh-entry-pending:active { background: none; }
                .rh-entry-pending .rh-entry-title { color: #404040; text-decoration: none; }
                .rh-entry-thumb {
                    width: 52px;
                    height: 52px;
                    flex-shrink: 0;
                    object-fit: cover;
                    border: 1px solid #808080;
                    background: #f4f4f4;
                }
                .rh-entry-thumb-blank {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                }
                .rh-entry-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
                .rh-entry-title {
                    font-size: calc(13px * var(--app-text-scale, 1));
                    color: #000080;
                    font-weight: 700;
                    text-decoration: underline;
                    word-break: break-all;
                }
                .rh-entry-desc {
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #404040;
                    line-height: 1.5;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    white-space: pre-line;
                }
                .rh-entry-meta { font-size: calc(10px * var(--app-text-scale, 1)); color: #808080; }
                /* 详情：上=图文内容区（内部滚动），下=横滑文件条 + 操作按钮（钉底） */
                .rh-body-detail { overflow: hidden; display: flex; }
                .rh-detail2 {
                    flex: 1;
                    /* min-width 不能省：外层 .rh-body-detail 是横向 flex，本项默认 min-width:auto
                       不许缩到内容最小宽以下，而文件条的格子全部 flex-shrink:0，文件一多（4 个起）
                       最小内容宽就超过容器，把整列撑爆——正文按撑爆后的宽度换行、右侧被裁，
                       文件条 clientWidth==scrollWidth 变得根本没有可滚区间。 */
                    min-width: 0;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                }
                .rh-detail2-main {
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .rh-detail2-imgwrap {
                    display: flex;
                    justify-content: center;
                    -webkit-tap-highlight-color: rgba(0, 0, 128, 0.15);
                }
                /* 只作用于配图；写成 .rh-detail2-main img 会连作者头像一起套住，
                   头像格子才 36px 宽，88% 一算就缩成 31px，右边空出一条 */
                .rh-detail2-imgwrap img {
                    max-width: min(300px, 88%);
                    max-height: 360px;
                    width: auto;
                    height: auto;
                    align-self: center;
                    border: 1px solid #808080;
                    pointer-events: none;
                }
                /* 发帖式排版：标题字号更大更粗，下带分隔线 */
                .rh-detail2-title {
                    font-size: calc(16px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #000;
                    line-height: 1.4;
                    word-break: break-all;
                    padding-bottom: 8px;
                    border-bottom: 1px solid #d4d0c8;
                }
                /* 详情页第一行：头像 + 昵称/时间 + 作者操作 */
                .rh-detail2-head {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .rh-detail2-head-main { flex: 1; min-width: 0; }
                .rh-detail2-author {
                    font-size: calc(12px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #000080;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-detail2-time { font-size: calc(10px * var(--app-text-scale, 1)); color: #808080; }
                .rh-detail2-head-actions { display: flex; gap: 4px; flex-shrink: 0; }
                .rh-icon-btn {
                    width: 26px;
                    height: 24px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 13px;
                    background: #c0c0c0;
                    color: #000;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                    padding: 0;
                }
                .rh-icon-btn:active { border-color: #404040 #ffffff #ffffff #404040; }
                .rh-icon-btn-danger { color: #a01818; }
                /* 头像：矩形，带凹边框 */
                .rh-avatar {
                    display: inline-block;
                    flex-shrink: 0;
                    overflow: hidden;
                    background: #dcd8d0;
                    border: 2px solid;
                    border-color: #404040 #ffffff #ffffff #404040;
                }
                .rh-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
                /* 我的货摊资料卡 */
                .rh-profile-card {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px;
                    background: #ececec;
                    border-bottom: 1px solid #808080;
                }
                .rh-profile-avatar { position: relative; cursor: pointer; display: inline-block; }
                .rh-profile-avatar-hint {
                    position: absolute;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    text-align: center;
                    font-size: calc(9px * var(--app-text-scale, 1));
                    color: #fff;
                    background: rgba(0, 0, 0, 0.55);
                    padding: 1px 0;
                }
                .rh-profile-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
                .rh-profile-nickname {
                    align-self: flex-start;
                    max-width: 100%;
                    background: none;
                    border: none;
                    padding: 0;
                    font-size: calc(14px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #000080;
                    cursor: pointer;
                    text-align: left;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-profile-edit-hint { font-size: calc(11px * var(--app-text-scale, 1)); color: #808080; }
                .rh-profile-nickname-input { font-size: calc(13px * var(--app-text-scale, 1)); }
                .rh-profile-stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #404040;
                }
                .rh-profile-stats b { color: #000; font-size: calc(13px * var(--app-text-scale, 1)); }
                /* 摊主钥匙 */
                .rh-key-link {
                    background: none;
                    border: none;
                    padding: 0;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #000080;
                    text-decoration: underline;
                    cursor: pointer;
                }
                .rh-profile-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
                .rh-profile-name-row .rh-key-link { margin-left: auto; flex: none; }
                .rh-profile-name-row .rh-profile-nickname { min-width: 0; }
                .rh-profile-name-row .rh-profile-nickname-input { flex: 1; min-width: 0; }
                .rh-profile-stats .rh-key-link { margin-left: auto; }
                .rh-claim-files { display: flex; flex-wrap: wrap; gap: 4px; }
                .rh-claim-file {
                    background: #fff;
                    border: 1px solid #b8bfc9;
                    padding: 3px 8px;
                    font-size: 11px;
                    cursor: pointer;
                    max-width: 100%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-file-pick-btn { align-self: flex-start; }
                .rh-key-danger {
                    color: #cc0000;
                    font-weight: 800;
                    font-size: 14px;
                    text-align: center;
                }
                .rh-key-backup-actions { display: flex; gap: 8px; }
                .rh-key-backup-actions .rh-btn { flex: 1; }
                .rh-key-warning {
                    background: #ffffe1;
                    border: 1px solid #808080;
                    padding: 8px;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    line-height: 1.7;
                    color: #000;
                }
                .rh-key-text {
                    font-family: Consolas, "Courier New", monospace;
                    font-size: calc(10px * var(--app-text-scale, 1));
                    word-break: break-all;
                    resize: none;
                }
                /* 已选文件清单（上传/编辑弹窗共用） */
                .rh-picked-list { display: flex; flex-direction: column; gap: 3px; }
                .rh-picked {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 6px;
                    background: #fff;
                    border: 1px solid #808080;
                }
                .rh-picked-name {
                    flex: 1;
                    min-width: 0;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #000;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-picked-size {
                    font-size: calc(10px * var(--app-text-scale, 1));
                    color: #808080;
                    flex-shrink: 0;
                }
                .rh-picked-x {
                    flex-shrink: 0;
                    width: 18px;
                    height: 18px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #a01818;
                    background: none;
                    border: none;
                    cursor: pointer;
                }
                /* 编辑弹窗的文件清单 */
                .rh-edit-files { display: flex; flex-direction: column; gap: 3px; }
                .rh-edit-file {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 6px;
                    background: #fff;
                    border: 1px solid #808080;
                    cursor: pointer;
                    text-align: left;
                }
                .rh-edit-file[data-removed] { background: #f0d0d0; text-decoration: line-through; color: #a01818; }
                .rh-edit-file-name {
                    flex: 1;
                    min-width: 0;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-edit-file-x { font-size: calc(11px * var(--app-text-scale, 1)); color: #a01818; flex-shrink: 0; }
                .rh-detail2-desc {
                    font-size: calc(12px * var(--app-text-scale, 1));
                    line-height: 1.8;
                    white-space: pre-wrap;
                    color: #000;
                }
                .rh-detail2-desc-empty { color: #808080; }
                .rh-file-strip {
                    flex-shrink: 0;
                    display: flex;
                    gap: 6px;
                    overflow-x: auto;
                    padding: 8px;
                    background: #c0c0c0;
                    border-top: 2px solid;
                    border-color: #808080 transparent transparent transparent;
                    box-shadow: inset 0 1px 0 #404040;
                }
                .rh-file-tile {
                    flex-shrink: 0;
                    width: 84px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 2px;
                    padding: 7px 4px 5px;
                    background: #fff;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                }
                .rh-file-tile[data-selected] {
                    border-color: #000080;
                    background: #e4ecf7;
                    outline: 1px solid #000080;
                }
                .rh-file-tile-ext {
                    font-size: calc(9px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #000080;
                    letter-spacing: 0.04em;
                }
                .rh-file-tile-name {
                    max-width: 100%;
                    font-size: calc(10px * var(--app-text-scale, 1));
                    color: #000;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .rh-detail2-actions {
                    flex-shrink: 0;
                    display: flex;
                    gap: 8px;
                    padding: 8px;
                    background: #c0c0c0;
                    border-top: 1px solid #fff;
                }
                .rh-action-half { flex: 1; padding: 8px 0; }
                .rh-action-del { color: #a01818; font-weight: 700; padding: 8px 10px; }
                .rh-flower-btn { padding: 8px 8px; }
                /* 我的货摊：花数汇总行 */
                .rh-stall-flowers {
                    padding: 8px 10px;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #a04060;
                    background: #fff0f4;
                    border-bottom: 1px solid #d4d0c8;
                }
                /* 非阻塞小提示 */
                .rh-toast {
                    position: absolute;
                    left: 50%;
                    bottom: 60px;
                    transform: translateX(-50%);
                    z-index: 70;
                    background: #ffffe1;
                    color: #000;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    padding: 6px 16px;
                    border: 1px solid #000;
                    box-shadow: 2px 2px 0 #000;
                    white-space: nowrap;
                    pointer-events: none;
                }
                .rh-search-row {
                    display: flex;
                    gap: 6px;
                    padding: 8px 10px 4px;
                }
                /* 搜索框在白底上：右/下边也要有可见描边，不然和背景融为一体 */
                .rh-input.rh-search-input {
                    flex: 1;
                    min-width: 0;
                    border-color: #404040 #808080 #808080 #404040;
                    background: #fffff4;
                }
                .rh-statusbar {
                    display: flex;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 3px 8px;
                    font-size: calc(10px * var(--app-text-scale, 1));
                    color: #000;
                    border-top: 1px solid #fff;
                    box-shadow: 0 -1px 0 #808080;
                    flex-shrink: 0;
                }
                .rh-statusbar span {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                /* 对话框 */
                .rh-dialog-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.3);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 60;
                    padding: 20px;
                }
                .rh-dialog {
                    width: min(340px, 92%);
                    max-height: 76vh;
                    display: flex;
                    flex-direction: column;
                    background: #c0c0c0;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    box-shadow: 2px 2px 0 #000;
                }
                .rh-dialog-body {
                    padding: 14px 12px;
                    font-size: calc(13px * var(--app-text-scale, 1));
                    color: #000;
                    overflow-y: auto;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .rh-dialog-icon { font-size: 30px; }
                .rh-notice-body { flex-direction: column; align-items: stretch; gap: 10px; line-height: 1.6; }
                .rh-notice-body p { margin: 0; }
                .rh-notice-no { font-weight: 700; margin-right: 2px; }
                .rh-dialog-footer {
                    display: flex;
                    justify-content: center;
                    gap: 10px;
                    padding: 0 12px 12px;
                }
                /* 导入弹窗：文件全名（不截断，允许换行） */
                .rh-import-filename {
                    padding: 8px 12px 0;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    font-weight: 700;
                    color: #000;
                    word-break: break-all;
                    line-height: 1.5;
                }
                .rh-dest-list { flex-direction: column; align-items: stretch; gap: 3px; }
                /* 目的地图标网格（仿桌面图标：图标 + 名字，一行三个） */
                .rh-dest-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 6px;
                    align-items: stretch;
                }
                .rh-dest-tile {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 5px;
                    padding: 12px 4px 9px;
                    background: none;
                    border: 1px dotted transparent;
                    cursor: pointer;
                }
                .rh-dest-tile:active { border-color: #000080; background: #e4ecf7; }
                .rh-dest-tile-label {
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #000;
                    text-align: center;
                    line-height: 1.3;
                    word-break: break-all;
                }
                .rh-dest {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 1px;
                    padding: 7px 10px;
                    background: #fff;
                    border: 1px solid #808080;
                    cursor: pointer;
                    text-align: left;
                }
                .rh-dest:active { background: #000080; }
                .rh-dest:active .rh-dest-label, .rh-dest:active .rh-dest-hint { color: #fff; }
                .rh-dest-label { font-size: calc(13px * var(--app-text-scale, 1)); color: #000; font-weight: 700; }
                .rh-dest-hint { font-size: calc(10px * var(--app-text-scale, 1)); color: #808080; }
                .rh-form { flex-direction: column; align-items: stretch; gap: 8px; }
                .rh-form label, .rh-form-field {
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    color: #000;
                }
                /* 排版工具栏（上传弹窗：贴纸/颜色/字号/加粗/预览） */
                .rh-input-row { display: flex; gap: 4px; }
                .rh-input-row .rh-input { flex: 1; min-width: 0; }
                .rh-fmt-bar { display: flex; gap: 4px; flex-wrap: wrap; }
                .rh-fmt-btn {
                    background: #c0c0c0;
                    color: #000;
                    font-size: calc(11px * var(--app-text-scale, 1));
                    padding: 2px 8px;
                    border: 2px solid;
                    border-color: #ffffff #404040 #404040 #ffffff;
                    cursor: pointer;
                }
                .rh-fmt-btn:active, .rh-fmt-btn[data-active] { border-color: #404040 #ffffff #ffffff #404040; background: #d8d8d8; }
                .rh-fmt-bold { font-weight: 700; }
                .rh-sticker-panel {
                    display: grid;
                    grid-template-columns: repeat(8, 1fr);
                    gap: 2px;
                    padding: 4px;
                    background: #fff;
                    border: 1px solid #808080;
                }
                .rh-sticker-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 3px;
                    background: none;
                    border: 1px dotted transparent;
                    cursor: pointer;
                }
                .rh-sticker-btn:active { border-color: #000080; background: #e4ecf7; }
                .rh-color-panel { display: flex; gap: 4px; padding: 4px; background: #fff; border: 1px solid #808080; }
                .rh-color-chip { width: 20px; height: 20px; border: 1px solid #404040; cursor: pointer; padding: 0; }
                .rh-desc-preview {
                    background: #fff;
                    border: 1px solid #808080;
                    padding: 8px;
                    font-size: calc(12px * var(--app-text-scale, 1));
                    line-height: 1.7;
                    white-space: pre-wrap;
                    color: #000;
                }
                /* 所见即所得编辑器：外观与 rh-input 一致，内容直接显示排版效果 */
                .rh-editor {
                    line-height: 1.7;
                    word-break: break-word;
                    white-space: pre-wrap;
                    -webkit-user-select: text;
                    user-select: text;
                    cursor: text;
                }
                .rh-editor-line { min-height: calc(20px * var(--app-text-scale, 1)); overflow-x: auto; white-space: nowrap; }
                .rh-editor-area { min-height: calc(66px * var(--app-text-scale, 1)); max-height: 40vh; overflow-y: auto; }
                .rh-editor[data-empty]::before {
                    content: attr(data-placeholder);
                    color: #a0a0a0;
                    pointer-events: none;
                }
                .rh-editor img { display: inline; vertical-align: -0.22em; }
                .rh-preview-label {
                    font-size: calc(10px * var(--app-text-scale, 1));
                    color: #808080;
                    margin-bottom: 5px;
                }
                .rh-preview-title {
                    font-weight: 700;
                    font-size: calc(14px * var(--app-text-scale, 1));
                    border-bottom: 1px solid #d4d0c8;
                    padding-bottom: 4px;
                    margin-bottom: 6px;
                }
                .rh-input {
                    background: #fff;
                    border: 2px solid;
                    border-color: #404040 #ffffff #ffffff #404040;
                    padding: 4px 6px;
                    font-size: calc(13px * var(--app-text-scale, 1));
                    color: #000;
                    outline: none;
                }
                /* 分类下拉：Win98 风格，去掉系统原生外观 */
                select.rh-input {
                    appearance: none;
                    -webkit-appearance: none;
                    background-color: #fff;
                    background-image: linear-gradient(45deg, transparent 50%, #000 50%), linear-gradient(135deg, #000 50%, transparent 50%);
                    background-position: calc(100% - 13px) center, calc(100% - 8px) center;
                    background-size: 5px 5px, 5px 5px;
                    background-repeat: no-repeat;
                    padding-right: 26px;
                    border-radius: 0;
                }
                .rh-form-hint { font-size: calc(10px * var(--app-text-scale, 1)); color: #606060; line-height: 1.6; }
                .rh-file-picker { cursor: pointer; }
                .rh-file-picker .rh-btn { display: block; text-align: center; }
                textarea.rh-input { resize: vertical; font-family: inherit; }
            `}</style>
        </div>
    );
}
