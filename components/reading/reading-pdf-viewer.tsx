"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { loadRawFileBlob } from "@/lib/reading-storage";
import { splitBilingualText } from "@/lib/bilingual-text";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";

import type { ReadingAnnotation, BookChapter } from "@/lib/reading-types";

type Props = {
    bookId: string;
    chapter?: BookChapter;
    annotations?: ReadingAnnotation[];
    bilingualTranslationEnabled?: boolean;
    collapseBilingualTranslation?: boolean;
    onTotalPages?: (n: number) => void;
    onCurrentPage?: (page: number) => void;
    jumpToPage?: number;
    onJumpComplete?: () => void;
    onCopyAnnotation?: (text: string) => void;
    onDeleteAnnotation?: (annotationId: string) => void;
    /** 页面缩放率：1=按容器宽度原样，>1 放大（如 1.5 一页近似一屏） */
    zoom?: number;
    /** 当前页前后各预渲染几页（懒加载粒度） */
    preloadRadius?: number;
    /** 是否预加载后续页（阅读时提前渲染视口之外的页，滚动更平滑） */
    preloadEnabled?: boolean;
};

const PDFJS_VERSION = "3.11.174";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
const PRELOAD_ROOT_MARGIN = "1800px 0px";
/** 渲染并发上限：预加载页多时限制同时光栅化的页数，避免一次把主线程塞满导致卡顿 */
const MAX_CONCURRENT_RENDERS = 2;
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else reject(new Error("pdfjsLib not found"));
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

export function PdfPageRenderer({
    bookId,
    chapter,
    annotations,
    bilingualTranslationEnabled = false,
    collapseBilingualTranslation = true,
    onTotalPages,
    onCurrentPage,
    jumpToPage,
    onJumpComplete,
    onCopyAnnotation,
    onDeleteAnnotation,
    zoom = 1,
    preloadRadius = 3,
    preloadEnabled = true,
}: Props) {
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<any | null>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const renderSeqRef = useRef(0);
    /** 正在光栅化的页数（并发限流用） */
    const activeRendersRef = useRef(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [docVersion, setDocVersion] = useState(0);
    /** 上一次完成渲染的 pdf 文档对象：换书（docVersion 变化）时旧 canvas 一律不复用，防止串书 */
    const renderedPdfRef = useRef<any | null>(null);
    const scaleRef = useRef(1);
    const [scale, setScale] = useState(1);
    const renderedPagesRef = useRef(new Set<number>());
    const renderingPagesRef = useRef(new Map<number, Promise<void>>());
    const reportedPageRef = useRef(0);
    const cleanupRef = useRef<(() => void) | null>(null);

    const pinchRef = useRef({
        startDist: 0,
        startScale: 1,
        screenX: 0,
        screenY: 0,
        contentX: 0,
        contentY: 0,
    });

    const getRenderMetrics = () => {
        const scrollParent = canvasContainerRef.current?.closest("[data-ui='body']") as HTMLElement | null;
        const cssWidth = wrapperRef.current?.clientWidth || scrollParent?.clientWidth || 350;
        // 页面有效宽度 = 容器宽度 × 用户缩放率（zoom 可调，放大后一页接近一屏）
        const effectiveWidth = Math.max(1, cssWidth * zoom);
        // 渲染分辨率封顶 2 倍：@3x 设备上 3 倍 canvas 像素量是 2 倍的 2.25 倍，
        // PDF.js 光栅化与 canvas 上传都明显变慢，是滚动卡顿的重要放大器；
        // 手机上 2x 已足够清晰（4 倍像素），降到 2x 渲染速度大幅提升。
        const renderDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
        return { cssWidth, effectiveWidth, scrollParent, renderDpr };
    };

    /** 渲染完成版本号：渲染 effect 每完成一轮全量渲染 +1，驱动待处理的跳页定位 */
    const [renderDone, setRenderDone] = useState(0);

    /**
     * 批注钉与页面渲染解耦：页面 canvas 渲染只依赖文档与渲染参数；
     * 文本层解析（chapter 变化）或批注增删时，仅通过本函数局部重建批注钉，
     * 不再触发整本页面重建（开自动批注/生成批注也不闪烁）。
     */
    const createAnnotationPin = useCallback((pageNum: number) => {
        if (!chapter?.paragraphPages || !annotations?.length) return [] as HTMLDivElement[];
        const elements: HTMLDivElement[] = [];
        for (const ann of annotations) {
            const pIdx = ann.paragraphIndex;
            if (pIdx < 0 || pIdx >= (chapter.paragraphPages?.length || 0)) continue;
            if (chapter.paragraphPages[pIdx] !== pageNum) continue;
            const yRatio = chapter.paragraphYPositions?.[pIdx] ?? 0.5;

            const annEl = document.createElement("div");
            annEl.className = "reading-ann-pin";
            annEl.style.top = `${yRatio * 100}%`;
            annEl.dataset.expanded = "false";
            annEl.dataset.noNav = "true";
            const tagEl = document.createElement("span");
            tagEl.className = "reading-ann-pin-tag";
            tagEl.textContent = `💬 ${ann.characterName}`;

            const bodyEl = document.createElement("div");
            bodyEl.className = "reading-ann-pin-body";

            const nameEl = document.createElement("span");
            nameEl.className = "reading-annotation-name";
            nameEl.textContent = ann.characterName;

            const textEl = document.createElement("div");
            textEl.className = "reading-annotation-text";

            const bilingual = bilingualTranslationEnabled ? splitBilingualText(ann.content) : null;
            if (!bilingual) {
                textEl.textContent = ann.content;
            } else {
                const originalEl = document.createElement("div");
                originalEl.textContent = bilingual.original;

                const toggleBtn = document.createElement("button");
                toggleBtn.type = "button";
                toggleBtn.className = "chat-bilingual-toggle reading-annotation-bilingual-toggle";
                toggleBtn.textContent = collapseBilingualTranslation ? "中文" : "收起中文";

                const translationEl = document.createElement("div");
                translationEl.className = "reading-annotation-translation";
                translationEl.textContent = bilingual.translated;
                translationEl.style.display = collapseBilingualTranslation ? "none" : "block";

                toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    const expanded = translationEl.style.display !== "none";
                    translationEl.style.display = expanded ? "none" : "block";
                    toggleBtn.textContent = expanded ? "中文" : "收起中文";
                };

                textEl.append(originalEl, toggleBtn, translationEl);
            }

            const menuEl = document.createElement("div");
            menuEl.className = "ctx-menu reading-annotation-menu";

            const copyBtn = document.createElement("button");
            copyBtn.className = "ctx-menu-btn";
            copyBtn.textContent = "复制";
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                onCopyAnnotation?.(ann.content);
                menuEl.dataset.open = "false";
            };

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "ctx-menu-btn ctx-menu-btn-danger";
            deleteBtn.textContent = "删除";
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                onDeleteAnnotation?.(ann.id);
                menuEl.dataset.open = "false";
            };

            menuEl.dataset.open = "false";
            menuEl.append(copyBtn, deleteBtn);
            bodyEl.append(nameEl, textEl, menuEl);
            annEl.append(tagEl, bodyEl);

            let longPressTimer: number | null = null;
            let didLongPress = false;
            const clearLongPress = () => {
                if (longPressTimer !== null) {
                    window.clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            };
            const openMenu = () => {
                annEl.dataset.expanded = "true";
                menuEl.dataset.open = "true";
                didLongPress = true;
            };
            bodyEl.onpointerdown = (e) => {
                e.stopPropagation();
                clearLongPress();
                longPressTimer = window.setTimeout(openMenu, 500);
            };
            bodyEl.onpointerup = clearLongPress;
            bodyEl.onpointercancel = clearLongPress;
            bodyEl.onpointerleave = clearLongPress;
            annEl.onclick = (e) => {
                e.stopPropagation();
                clearLongPress();
                if (didLongPress) {
                    didLongPress = false;
                    return;
                }
                const isExpanded = annEl.dataset.expanded === "true";
                annEl.dataset.expanded = isExpanded ? "false" : "true";
                if (isExpanded) menuEl.dataset.open = "false";
            };
            elements.push(annEl);
        }
        return elements;
    }, [annotations, bilingualTranslationEnabled, chapter, collapseBilingualTranslation, onCopyAnnotation, onDeleteAnnotation]);

    // 懒加载页可能在批注同步 effect 之后才完成渲染；始终从 ref 读取最新的批注工厂，
    // 避免 canvas 替换占位内容时把已经生成的批注钉永久丢掉。
    const annotationPinFactoryRef = useRef(createAnnotationPin);
    useEffect(() => {
        annotationPinFactoryRef.current = createAnnotationPin;
    }, [createAnnotationPin]);

    // Load PDF document once per book.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let objectUrl: string | null = null;
            try {
                setError(null);
                setLoading(true);
                pdfDocRef.current = null;
                observerRef.current?.disconnect();
                scaleRef.current = 1;
                setScale(1);

                const rawData = await loadRawFileBlob(bookId);
                if (cancelled) return;
                if (!rawData || rawData.size === 0) {
                    setError("PDF 文件未找到或为空");
                    setLoading(false);
                    return;
                }
                const pdfjsLib = await loadPdfjs();
                objectUrl = URL.createObjectURL(rawData);
                const pdf = await pdfjsLib.getDocument({ url: objectUrl }).promise;
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
                if (cancelled) return;
                pdfDocRef.current = pdf;
                onTotalPages?.(pdf.numPages);
                setDocVersion((v) => v + 1);
            } catch (err) {
                if (!cancelled) setError(`PDF 加载失败: ${err instanceof Error ? err.message : String(err)}`);
                if (!cancelled) setLoading(false);
            } finally {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            }
        })();
        return () => {
            cancelled = true;
            observerRef.current?.disconnect();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookId]);

    // Re-render every page at the committed zoom level after the gesture ends.
    useEffect(() => {
        const pdf = pdfDocRef.current;
        const container = canvasContainerRef.current;
        if (!pdf || !container) return;

        let cancelled = false;
        const renderSeq = ++renderSeqRef.current;

        (async () => {
            try {
                // 记录重建前正在看的页：缩放率/预渲染设置变化导致重建后仍停留在该页，避免跳位
                const prevReportedPage = reportedPageRef.current;
                observerRef.current?.disconnect();
                renderedPagesRef.current.clear();
                renderingPagesRef.current.clear();
                reportedPageRef.current = 0;

                const { effectiveWidth, scrollParent, renderDpr } = getRenderMetrics();
                const pageRoot = scrollParent || wrapperRef.current;
                const firstPage = await pdf.getPage(1);
                const firstViewport = firstPage.getViewport({ scale: 1 });
                const defaultCssHeight = effectiveWidth * (firstViewport.height / firstViewport.width);
                firstPage.cleanup?.();

                // 换书（pdf 对象变化）时旧 canvas 一律丢弃重渲；同书重建（缩放/预渲染设置变化）时尽量复用已渲染的 canvas，
                // 避免整本闪回米黄色占位块。
                const isNewPdf = renderedPdfRef.current !== pdf;
                if (isNewPdf) renderedPdfRef.current = pdf;
                const reusableCanvases = new Map<number, HTMLCanvasElement>();
                if (!isNewPdf) {
                    for (const child of Array.from(container.children)) {
                        const n = Number((child as HTMLElement).dataset.page);
                        const canvas = (child as HTMLElement).querySelector("canvas[data-page]") as HTMLCanvasElement | null;
                        if (n && canvas) reusableCanvases.set(n, canvas);
                    }
                }

                const fragment = document.createDocumentFragment();
                const pageWrappers = new Map<number, HTMLDivElement>();

                const renderRadius = Math.max(0, Math.min(8, Math.round(preloadRadius) || 0));
                const buildRenderOrder = (centerPage: number) => {
                    const ordered = [centerPage];
                    for (let offset = 1; offset <= renderRadius; offset += 1) {
                        ordered.push(centerPage + offset);
                        ordered.push(centerPage - offset);
                    }
                    return ordered.filter((pageNum, index, list) => pageNum >= 1 && pageNum <= pdf.numPages && list.indexOf(pageNum) === index);
                };

                const preloadNeighborhood = (centerPage: number) => {
                    if (!preloadEnabled) return; // 关闭预加载：只渲染进入视口的页
                    for (const pageNum of buildRenderOrder(centerPage)) {
                        void renderPage(pageNum);
                    }
                };

                const renderPage = async (pageNum: number) => {
                    if (cancelled || renderSeq !== renderSeqRef.current) return;
                    if (renderedPagesRef.current.has(pageNum)) return;
                    const inFlight = renderingPagesRef.current.get(pageNum);
                    if (inFlight) {
                        await inFlight;
                        return;
                    }

                    const pageWrapper = pageWrappers.get(pageNum);
                    if (!pageWrapper) return;
                    const renderTask = (async () => {
                        // 并发限流：同时最多光栅化 MAX_CONCURRENT_RENDERS 页，
                        // 预加载页多时不把主线程一次性塞满（轮询等待，16ms 一拍）
                        while (activeRendersRef.current >= MAX_CONCURRENT_RENDERS) {
                            if (cancelled || renderSeq !== renderSeqRef.current) return;
                            await new Promise<void>((resolve) => setTimeout(resolve, 16));
                        }
                        activeRendersRef.current += 1;
                        try {
                        const page = await pdf.getPage(pageNum);
                        const viewport = page.getViewport({ scale: 1 });
                        const cssHeight = effectiveWidth * (viewport.height / viewport.width);
                        const bufferWidth = Math.round(effectiveWidth * renderDpr * scale);
                        const bufferHeight = Math.round(cssHeight * renderDpr * scale);
                        const renderScale = bufferWidth / viewport.width;
                        const scaledViewport = page.getViewport({ scale: renderScale });

                        const canvas = document.createElement("canvas");
                        canvas.width = bufferWidth;
                        canvas.height = bufferHeight;
                        canvas.style.width = `${effectiveWidth}px`;
                        canvas.style.height = `${cssHeight}px`;
                        canvas.style.display = "block";
                        canvas.dataset.page = String(pageNum);

                        const ctx = canvas.getContext("2d", { alpha: false });
                        if (!ctx) throw new Error("Canvas 2D context unavailable");
                        await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
                        page.cleanup?.();

                        if (cancelled || renderSeq !== renderSeqRef.current) return;

                        renderedPagesRef.current.add(pageNum);
                        pageWrapper.style.height = `${cssHeight}px`;
                        pageWrapper.replaceChildren(canvas, ...annotationPinFactoryRef.current(pageNum));
                        } finally {
                            activeRendersRef.current -= 1;
                        }
                    })();

                    renderingPagesRef.current.set(pageNum, renderTask);
                    try {
                        await renderTask;
                    } finally {
                        renderingPagesRef.current.delete(pageNum);
                    }
                };

                for (let i = 1; i <= pdf.numPages; i++) {
                    const pageWrapper = document.createElement("div");
                    pageWrapper.style.position = "relative";
                    pageWrapper.style.width = `${effectiveWidth}px`;
                    pageWrapper.style.height = `${defaultCssHeight}px`;
                    pageWrapper.dataset.page = String(i);
                    // 注意：页面容器不能标 data-no-nav，否则点击页面唤不出沉浸菜单
                    // （底部翻页/批注/设置按钮）。批注钉与「点击恢复原始大小」自身仍保留 noNav。

                    // 同书重建且缩放率未变：复用已渲染的 canvas，不闪回米黄占位
                    const reused = reusableCanvases.get(i);
                    if (reused && Math.abs(parseFloat(reused.style.width || "0") - effectiveWidth) < 1) {
                        pageWrapper.style.height = reused.style.height || `${defaultCssHeight}px`;
                        pageWrapper.replaceChildren(reused, ...annotationPinFactoryRef.current(i));
                        renderedPagesRef.current.add(i);
                    } else {
                        const placeholder = document.createElement("div");
                        placeholder.style.width = "100%";
                        placeholder.style.height = "100%";
                        placeholder.style.borderRadius = "12px";
                        placeholder.style.background = "rgba(255, 252, 237, 0.5)";
                        pageWrapper.appendChild(placeholder);
                    }

                    pageWrappers.set(i, pageWrapper);
                    fragment.appendChild(pageWrapper);
                }

                container.replaceChildren(fragment);

                let currentPageFrame: number | null = null;
                const reportCurrentPage = () => {
                    if (!onCurrentPage || !pageRoot) return;

                    const rootRect = pageRoot.getBoundingClientRect();
                    let bestPage = 1;
                    let bestVisibleHeight = -1;
                    let bestDistance = Number.POSITIVE_INFINITY;

                    for (const [pageNum, pageWrapper] of pageWrappers.entries()) {
                        const rect = pageWrapper.getBoundingClientRect();
                        const visibleTop = Math.max(rect.top, rootRect.top);
                        const visibleBottom = Math.min(rect.bottom, rootRect.bottom);
                        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                        const distanceToTop = Math.abs(rect.top - rootRect.top);

                        if (
                            visibleHeight > bestVisibleHeight ||
                            (visibleHeight === bestVisibleHeight && distanceToTop < bestDistance)
                        ) {
                            bestPage = pageNum;
                            bestVisibleHeight = visibleHeight;
                            bestDistance = distanceToTop;
                        }
                    }

                    if (bestVisibleHeight < 0) return;
                    if (reportedPageRef.current === bestPage) return;
                    reportedPageRef.current = bestPage;
                    onCurrentPage(bestPage);
                };

                const scheduleCurrentPageReport = () => {
                    if (currentPageFrame !== null) cancelAnimationFrame(currentPageFrame);
                    currentPageFrame = requestAnimationFrame(() => {
                        currentPageFrame = null;
                        reportCurrentPage();
                    });
                };

                observerRef.current = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const pageNum = Number((entry.target as HTMLElement).dataset.page);
                        if (!pageNum) continue;
                        void renderPage(pageNum);
                        preloadNeighborhood(pageNum);
                    }
                }, { root: scrollParent, threshold: 0.01, rootMargin: PRELOAD_ROOT_MARGIN });

                for (const child of Array.from(container.children)) {
                    observerRef.current.observe(child);
                }

                // 优先跳转目标页；没有跳转目标时停留在重建前正在读的页（缩放/预渲染设置调整后不跳位）
                const initialPage = Math.min(Math.max(jumpToPage || prevReportedPage || 1, 1), pdf.numPages);
                await renderPage(initialPage);
                preloadNeighborhood(initialPage);
                // 恢复进度：渲染完目标页后把滚动容器滚到目标页，确保打开即停在上次读的页（而非开头）
                if (jumpToPage) {
                    const targetEl = pageWrappers.get(initialPage);
                    const sc = canvasContainerRef.current?.closest("[data-ui='body']") as HTMLElement | null;
                    if (targetEl) {
                        scrollElementWithinContainer(sc || wrapperRef.current, targetEl, { block: "start" });
                        onJumpComplete?.();
                    }
                }
                scheduleCurrentPageReport();

                pageRoot?.addEventListener("scroll", scheduleCurrentPageReport, { passive: true });
                wrapperRef.current?.addEventListener("scroll", scheduleCurrentPageReport, { passive: true });
                window.addEventListener("resize", scheduleCurrentPageReport);

                if (!cancelled && renderSeq === renderSeqRef.current) {
                    setLoading(false);
                    // 通知批注钉同步 effect：整页渲染完成，可以重放批注钉
                    setRenderDone((v) => v + 1);
                }

                return () => {
                    if (currentPageFrame !== null) cancelAnimationFrame(currentPageFrame);
                    pageRoot?.removeEventListener("scroll", scheduleCurrentPageReport);
                    wrapperRef.current?.removeEventListener("scroll", scheduleCurrentPageReport);
                    window.removeEventListener("resize", scheduleCurrentPageReport);
                };
            } catch (err) {
                if (!cancelled && renderSeq === renderSeqRef.current) {
                    setError(`PDF 渲染失败: ${err instanceof Error ? err.message : String(err)}`);
                    setLoading(false);
                }
            }
        })().then((cleanup) => {
            if (typeof cleanup === "function") {
                if (cancelled) cleanup();
                else cleanupRef.current = cleanup;
            }
        });

        return () => {
            cancelled = true;
            observerRef.current?.disconnect();
            cleanupRef.current?.();
            cleanupRef.current = null;
        };
    // 渲染 effect 只依赖文档与渲染参数；chapter（文本层数据）/annotations（批注）变化不再触发整本重建。
    }, [docVersion, onCurrentPage, onJumpComplete, preloadEnabled, preloadRadius, scale, zoom]);

    // 批注钉同步：文本层更新（chapter 变化）/批注增删/双语开关变化时，只重放批注钉，不重建页面。
    // 与渲染 effect 解耦——渲染 effect 不再依赖 chapter/annotations，开自动批注/生成批注也不闪烁。
    useEffect(() => {
        const container = canvasContainerRef.current;
        if (!container) return;
        for (const child of Array.from(container.children)) {
            const pageNum = Number((child as HTMLElement).dataset.page);
            if (!pageNum || !child.querySelector("canvas[data-page]")) continue;
            child.querySelectorAll(".reading-ann-pin").forEach((pin) => pin.remove());
            const pins = createAnnotationPin(pageNum);
            if (pins.length) child.append(...pins);
        }
    }, [createAnnotationPin]);

    useEffect(() => {
        if (!jumpToPage || !canvasContainerRef.current || !wrapperRef.current) return;
        const target = canvasContainerRef.current.querySelector<HTMLElement>(`[data-page="${jumpToPage}"]`);
        if (!target) return;
        const scrollParent = canvasContainerRef.current.closest("[data-ui='body']") as HTMLElement | null;
        scrollElementWithinContainer(scrollParent || wrapperRef.current, target, { block: "start", behavior: "smooth" });
        onJumpComplete?.();
    }, [docVersion, jumpToPage, onJumpComplete, renderDone]);

    // Pinch-to-zoom
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const getDist = (t: TouchList) => {
            const dx = t[0].clientX - t[1].clientX;
            const dy = t[0].clientY - t[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 2) return;
            e.preventDefault();
            const dist = getDist(e.touches);
            const sx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const sy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const wRect = wrapper.getBoundingClientRect();
            pinchRef.current = {
                startDist: dist,
                startScale: scaleRef.current,
                screenX: sx,
                screenY: sy,
                contentX: (sx - wRect.left + wrapper.scrollLeft) / scaleRef.current,
                contentY: (sy - wRect.top + wrapper.scrollTop) / scaleRef.current,
            };
        };

        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || pinchRef.current.startDist === 0) return;
            e.preventDefault();
            const dist = getDist(e.touches);
            const newScale = Math.min(Math.max(pinchRef.current.startScale * (dist / pinchRef.current.startDist), 1), 4);
            scaleRef.current = newScale;

            const container = canvasContainerRef.current;
            if (container) {
                container.style.transform = `scale(${newScale})`;
                container.style.width = `${newScale * 100}%`;
            }

            const wRect = wrapper.getBoundingClientRect();
            wrapper.scrollLeft = pinchRef.current.contentX * newScale - (pinchRef.current.screenX - wRect.left);
            wrapper.scrollTop = pinchRef.current.contentY * newScale - (pinchRef.current.screenY - wRect.top);
        };

        const onTouchEnd = () => {
            pinchRef.current.startDist = 0;
            setScale((prev) => {
                const next = scaleRef.current;
                return Math.abs(prev - next) < 0.01 ? prev : next;
            });
        };

        wrapper.addEventListener("touchstart", onTouchStart, { passive: false });
        wrapper.addEventListener("touchmove", onTouchMove, { passive: false });
        wrapper.addEventListener("touchend", onTouchEnd);
        return () => {
            wrapper.removeEventListener("touchstart", onTouchStart);
            wrapper.removeEventListener("touchmove", onTouchMove);
            wrapper.removeEventListener("touchend", onTouchEnd);
        };
    }, []);

    return (
        <div ref={wrapperRef} className="w-full" style={{ overflow: "auto", WebkitOverflowScrolling: "touch" }}>
            {loading && (
                <div className="reading-loading-view">
                    <div className="reading-loading-mark" aria-hidden="true">
                        <span className="reading-loading-page reading-loading-page--back" />
                        <span className="reading-loading-page reading-loading-page--middle" />
                        <span className="reading-loading-page reading-loading-page--front" />
                    </div>
                    <div className="reading-loading-copy">
                        <span className="reading-loading-title">
                            正在打开 PDF
                            <span className="reading-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                        </span>
                        <span className="reading-loading-subtitle">正在准备页面渲染</span>
                    </div>
                    <div className="reading-loading-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                    </div>
                </div>
            )}
            {error && <div className="text-center ts-13 text-[var(--c-danger)] py-4">{error}</div>}
            <div
                ref={canvasContainerRef}
                className="flex flex-col gap-1"
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                    width: `${scale * 100}%`,
                    willChange: "transform",
                }}
            />
            {!loading && !error && scale > 1 && (
                <div
                    className="text-center ts-11 text-[var(--c-icon)] py-2 opacity-50 cursor-pointer"
                    data-no-nav="true"
                    onClick={() => { scaleRef.current = 1; setScale(1); }}
                >
                    点击恢复原始大小
                </div>
            )}
        </div>
    );
}
