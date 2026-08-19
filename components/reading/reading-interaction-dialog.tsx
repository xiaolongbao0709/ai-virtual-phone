"use client";

import { useState } from "react";
import { BookOpenText, LocateFixed, Minus, Plus, Repeat2, Rocket, RotateCcw, Settings } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { Toggle } from "@/components/ui/form";
import {
    loadReadingInteractionConfig,
    saveReadingInteractionConfig,
    type ReadingInteractionConfig,
    type ReadingParagraphMode,
    type ReadingViewMode,
} from "@/lib/reading-storage";

const PARAGRAPH_MODE_OPTIONS: { value: ReadingParagraphMode; label: string; desc: string }[] = [
    { value: "auto", label: "自动", desc: "自动识别书的段落格式（推荐）" },
    { value: "blank", label: "空行", desc: "段落之间有空行（标准导出格式）" },
    { value: "indent", label: "段首缩进", desc: "每段以全角空格缩进、无空行" },
    { value: "line", label: "每行一段", desc: "纯回车换行分段落（无空行无缩进）" },
];

const TXT_ENCODING_OPTIONS: { value: NonNullable<ReadingInteractionConfig["txtEncoding"]>; label: string; desc: string }[] = [
    { value: "auto", label: "自动", desc: "自动识别文件的编码（推荐）" },
    { value: "utf-8", label: "UTF-8", desc: "现代标准编码，多数文件默认" },
    { value: "gb18030", label: "GB18030", desc: "中文国标全集（含 GBK/GB2312）" },
    { value: "gbk", label: "GBK", desc: "简体中文常用编码" },
    { value: "big5", label: "Big5", desc: "繁体中文常用编码" },
    { value: "utf-16le", label: "UTF-16LE", desc: "Windows 记事本可存此编码" },
    { value: "utf-16be", label: "UTF-16BE", desc: "大端 UTF-16" },
];

const VIEW_MODE_OPTIONS: { value: ReadingViewMode; label: string; desc: string }[] = [
    { value: "page", label: "翻页", desc: "一屏一页，左右点击/滑动翻页" },
    { value: "scroll", label: "滚动", desc: "连续滚动阅读，上下滑动翻读" },
];

const RETRY_MIN = 0;
const RETRY_MAX = 5;

type Props = {
    onClose: () => void;
};

/** 阅读交互设置：导入段落划分 / 阅读模式 / 自动批注失败静默重试次数 */
export function ReadingInteractionDialog({ onClose }: Props) {
    const [config, setConfig] = useState<ReadingInteractionConfig>(() => loadReadingInteractionConfig());
    const [saving, setSaving] = useState(false);

    const handleSave = () => {
        setSaving(true);
        saveReadingInteractionConfig(config);
        setSaving(false);
        // 阅读器保持挂载，通过事件让它在下次显示时同步新配置
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("reading-interaction-config-changed"));
        }
        onClose();
    };

    const setRetry = (delta: number) => {
        setConfig((prev) => ({
            ...prev,
            annotationRetryCount: Math.max(RETRY_MIN, Math.min(RETRY_MAX, prev.annotationRetryCount + delta)),
        }));
    };

    return (
        <ContentDialog
            title="阅读设置"
            confirmLabel={saving ? "保存中..." : "保存"}
            cancelLabel="取消"
            onConfirm={handleSave}
            onCancel={onClose}
        >
            <div className="reading-settings-grid">
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Settings size={15} />
                        <span>导入段落划分</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>导入 TXT 小说时如何划分段落。选错可在导入后重新导入生效。</span>
                    </p>
                    <div className="reading-option-grid">
                        {PARAGRAPH_MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`reading-option-card ${config.paragraphMode === opt.value ? "is-active" : ""}`}
                                onClick={() => setConfig((prev) => ({ ...prev, paragraphMode: opt.value }))}
                            >
                                <span className="reading-option-card-label">{opt.label}</span>
                                <span className="reading-option-card-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Settings size={15} />
                        <span>导入 TXT 编码</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>导入 TXT 小说时按哪种编码解析。自动识别一般够用；个别 TXT 自动识别出错导致乱码时，可手动指定其真实编码后重新导入。</span>
                    </p>
                    <div className="reading-option-grid">
                        {TXT_ENCODING_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`reading-option-card ${config.txtEncoding === opt.value ? "is-active" : ""}`}
                                onClick={() => setConfig((prev) => ({ ...prev, txtEncoding: opt.value }))}
                            >
                                <span className="reading-option-card-label">{opt.label}</span>
                                <span className="reading-option-card-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <BookOpenText size={15} />
                        <span>阅读模式</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>切换后重新打开书籍生效。</span>
                    </p>
                    <div className="reading-option-grid reading-option-grid--two">
                        {VIEW_MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`reading-option-card ${config.readingMode === opt.value ? "is-active" : ""}`}
                                onClick={() => setConfig((prev) => ({ ...prev, readingMode: opt.value }))}
                            >
                                <span className="reading-option-card-label">{opt.label}</span>
                                <span className="reading-option-card-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Repeat2 size={15} />
                        <span>自动批注失败重试</span>
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>生成失败时静默重试的次数，全部失败后才提示错误。</span>
                    </p>
                    <div className="reading-retry-row">
                        <button
                            type="button"
                            className="reading-retry-btn"
                            onClick={() => setRetry(-1)}
                            disabled={config.annotationRetryCount <= RETRY_MIN}
                            aria-label="减少重试次数"
                        >
                            <Minus size={15} strokeWidth={2} />
                        </button>
                        <span className="reading-retry-value">
                            {config.annotationRetryCount}
                            <em>次</em>
                        </span>
                        <button
                            type="button"
                            className="reading-retry-btn"
                            onClick={() => setRetry(1)}
                            disabled={config.annotationRetryCount >= RETRY_MAX}
                            aria-label="增加重试次数"
                        >
                            <Plus size={15} strokeWidth={2} />
                        </button>
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Rocket size={15} />
                        <span>批注预生成</span>
                    </div>
                    <div className="reading-settings-toggle-row">
                        <span className="reading-settings-toggle-label">
                            TXT 预批注
                        </span>
                        <Toggle
                            checked={config.autoAnnotatePrefetch === true}
                            onChange={(next) => setConfig((prev) => ({ ...prev, autoAnnotatePrefetch: next }))}
                        />
                    </div>
                    <div className="reading-settings-toggle-row">
                        <span className="reading-settings-toggle-label">
                            PDF 预批注
                        </span>
                        <Toggle
                            checked={config.autoAnnotatePrefetchPdf === true}
                            onChange={(next) => setConfig((prev) => ({ ...prev, autoAnnotatePrefetchPdf: next }))}
                        />
                    </div>
                    {(config.autoAnnotatePrefetch || config.autoAnnotatePrefetchPdf) && (
                        <>
                            <div className="reading-settings-inline-note">
                                <span>读到当前批的多少时预生成下一批</span>
                                <span>{Math.round((config.annotationPrefetchThreshold ?? 2 / 3) * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                className="w-full my-1"
                                min={0.05}
                                max={0.95}
                                step={0.05}
                                value={config.annotationPrefetchThreshold ?? 2 / 3}
                                onChange={(e) => setConfig((prev) => ({ ...prev, annotationPrefetchThreshold: Number(e.target.value) }))}
                            />
                            <p className="reading-settings-inline-note">
                                <span>百分比越低，越早开始预生成下一批——设得很低（如 5%）时，刚开始读当前批，下一批批注就已经在生成/已生成，阅读不等待。默认 2/3。</span>
                            </p>
                        </>
                    )}
                    <p className="reading-settings-inline-note">
                        <span>TXT 预批注按段落分批，PDF 预批注按页分批，批次大小与自动批注一致（可在批注对话框里调整）。利用读上一批批注的时间生成下一批，不会重复批注。</span>
                    </p>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <LocateFixed size={15} />
                        <span>悬浮聊天窗</span>
                    </div>
                    <div className="reading-settings-toggle-row">
                        <span className="reading-settings-toggle-label">
                            展开时自动滚动到最新消息
                        </span>
                        <Toggle
                            checked={config.chatAutoScrollOnOpen !== false}
                            onChange={(next) => setConfig((prev) => ({ ...prev, chatAutoScrollOnOpen: next }))}
                        />
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>打开讨论窗口时自动滚到最新消息；打开后你可自由上下滑动打断，不会被拉回。</span>
                    </p>
                    <p className="reading-settings-inline-note">
                        <span>悬浮球/悬浮条被拖到屏幕外、无法交互时，点此恢复到默认位置。</span>
                    </p>
                    <button
                        type="button"
                        className="reading-reset-float-btn"
                        onClick={() => {
                            if (typeof window !== "undefined") {
                                window.dispatchEvent(new CustomEvent("reading-chat-float-reset"));
                            }
                        }}
                    >
                        <RotateCcw size={15} strokeWidth={2} />
                        重置悬浮球位置
                    </button>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Settings size={15} />
                        <span>PDF 渲染</span>
                    </div>
                    <div className="reading-settings-toggle-row">
                        <span className="reading-settings-toggle-label">预加载后续页</span>
                        <Toggle
                            checked={config.pdfPreloadEnabled !== false}
                            onChange={(next) => setConfig((prev) => ({ ...prev, pdfPreloadEnabled: next }))}
                        />
                    </div>
                    <p className="reading-settings-inline-note">
                        <span>开启后阅读 PDF 时会提前渲染当前页之后的页面，滚动更平滑；关闭则只渲染屏幕内的页。</span>
                    </p>
                    <div className="reading-settings-inline-note">
                        <span>页面缩放率</span>
                        <span>{Math.round((config.pdfZoom ?? 1) * 100)}%</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={0.5}
                        max={2}
                        step={0.05}
                        value={config.pdfZoom ?? 1}
                        onChange={(e) => setConfig((prev) => ({ ...prev, pdfZoom: Number(e.target.value) }))}
                    />
                    <div className="reading-settings-inline-note">
                        <span>一次渲染页数（当前页前后各几页）</span>
                        <span>{config.pdfPreloadRadius ?? 3} 页</span>
                    </div>
                    <input
                        type="range"
                        className="w-full my-1"
                        min={1}
                        max={8}
                        step={1}
                        value={config.pdfPreloadRadius ?? 3}
                        onChange={(e) => setConfig((prev) => ({ ...prev, pdfPreloadRadius: Number(e.target.value) }))}
                    />
                    <p className="reading-settings-inline-note">
                        <span>提示：一次渲染页数过少时，滑动到未渲染的页会反复渲染，造成闪烁卡顿；调大并开启预加载可缓解。缩放率调大后一页更接近一屏。</span>
                    </p>
                </section>
            </div>
        </ContentDialog>
    );
}
