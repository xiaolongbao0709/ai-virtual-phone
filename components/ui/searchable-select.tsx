"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Search, X, Check, ChevronDown, MoreVertical } from "lucide-react";

export type SearchableOption = {
  value: string;
  label?: string;
  description?: string;
  onAction?: () => void;
  actionTitle?: string;
};

export type SearchableSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: (string | SearchableOption)[];
  placeholder?: string;
  searchPlaceholder?: string;
  title?: string;
  allowCustom?: boolean;
  disabled?: boolean;
  className?: string;
  /** 
   * 模式:
   * - "select": 点击整体唤起搜索选择面板，外观与原生 ui-select 一致，右侧仅保留向下箭头
   * - "input": 保持文本输入框本体可直接打字，右侧带精巧的向下箭头按钮唤起面板
   */
  mode?: "select" | "input";
  /** 无选项时的提示文案 */
  emptyText?: string;
};

/** 统一转为标准 SearchableOption 结构 */
function normalizeOptions(options: (string | SearchableOption)[]): SearchableOption[] {
  return options.map((opt) => {
    if (typeof opt === "string") {
      return { value: opt, label: opt };
    }
    return {
      value: opt.value,
      label: opt.label || opt.value,
      description: opt.description,
      onAction: opt.onAction,
      actionTitle: opt.actionTitle,
    };
  });
}

/** 关键词高亮渲染辅助函数 */
function renderHighlightedText(text: string, query: string) {
  if (!query.trim()) return text;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return text;

  const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escapedTerms.join("|")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, index) => {
    const isMatch = terms.some((t) => t.toLowerCase() === part.toLowerCase());
    return isMatch ? (
      <span
        key={index}
        className="font-bold underline decoration-2 underline-offset-2"
        style={{ color: "var(--c-icon-active, #07c160)" }}
      >
        {part}
      </span>
    ) : (
      part
    );
  });
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "请选择...",
  searchPlaceholder = "输入关键字搜索...",
  title = "选择模型",
  allowCustom = true,
  disabled = false,
  className = "",
  mode = "select",
  emptyText = "暂无可选项目，可先拉取列表",
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 规范化所有选项
  const normalizedOptions = useMemo(() => normalizeOptions(options), [options]);

  // 挂载到手机外壳或 body
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".phone-shell");
    setPortalTarget(shell ?? document.body);
  }, []);

  // 关闭弹窗
  const handleClose = useCallback(() => {
    if (document.activeElement === searchInputRef.current) {
      searchInputRef.current?.blur();
    }
    setIsOpen(false);
    setSearchQuery("");
  }, []);



  // 打开弹窗：清空搜索，安全内部定位到当前选中项（纯内部 scrollTop 赋值，绝不使用 scrollIntoView，绝不波及外层容器）
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      const timer = setTimeout(() => {
        const container = listRef.current;
        const selectedEl = container?.querySelector<HTMLElement>('[data-selected="true"]');
        if (container && selectedEl) {
          // 只修改列表容器内部滚动，严禁触发外层容器或 window 的滚动！
          const containerRect = container.getBoundingClientRect();
          const selectedRect = selectedEl.getBoundingClientRect();
          const relativeTop = selectedRect.top - containerRect.top + container.scrollTop;
          container.scrollTop = Math.max(0, relativeTop - 60);
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // 按 Escape 键关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  // 搜索过滤计算
  const filteredOptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return normalizedOptions;
    const terms = q.split(/\s+/).filter(Boolean);
    return normalizedOptions.filter((opt) => {
      const targetStr = `${opt.value} ${opt.label ?? ""} ${opt.description ?? ""}`.toLowerCase();
      return terms.every((term) => targetStr.includes(term));
    });
  }, [normalizedOptions, searchQuery]);

  // 当前选中项的展示文本
  const currentLabel = useMemo(() => {
    if (!value) return "";
    const matched = normalizedOptions.find((opt) => opt.value === value);
    return matched?.label || value;
  }, [normalizedOptions, value]);

  // 选择某项
  const handleSelect = useCallback(
    (selectedValue: string) => {
      onChange(selectedValue);
      handleClose();
    },
    [onChange, handleClose]
  );

  // 滑动列表时自动收起软键盘，视野更开阔，且避免手势冲突
  const handleListTouch = useCallback(() => {
    if (document.activeElement === searchInputRef.current) {
      searchInputRef.current?.blur();
    }
  }, []);

  // 弹窗本体：硬件加速稳定定位，兼顾平板与手机，彻底杜绝软键盘遮挡与动画重播
  const modalContent = isOpen && portalTarget ? (
    createPortal(
      <div
        className="modal-overlay modal-overlay-bottom"
        data-ui="modal"
        style={{
          zIndex: 10002, // 稳定置于编辑配置弹窗（z-index: 9999）最上层
          WebkitTapHighlightColor: "transparent",
        }}
        onClick={handleClose}
      >
        <div
          className="modal-sheet sm:max-w-[420px]"
          data-ui="modal-sheet"
          style={{
            // 采用 72% 高度与父遮罩直接关联，平板/大屏上限高 580px 保持克制，避免移动端 vh 视口震荡
            height: "min(72%, 580px)",
            maxHeight: "84%",
            boxShadow: "0 -4px 24px rgba(0,0,0,0.18)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 顶部微小滑块手柄 */}
          <div className="flex justify-center pt-2 pb-0.5 sm:hidden">
            <div className="w-10 h-1 rounded-full opacity-25 bg-current" />
          </div>

          {/* 1. 顶部标题栏：左侧标题与列表数量，右侧关闭按钮 */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--c-panel-border,rgba(0,0,0,0.08))]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-[calc(15px*var(--app-text-scale,1))] truncate">
                {title}
              </span>
              {normalizedOptions.length > 0 && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{
                    background: "color-mix(in srgb, var(--c-icon-active, #07c160) 12%, transparent)",
                    color: "var(--c-icon-active, #07c160)",
                  }}
                >
                  {searchQuery.trim() ? `${filteredOptions.length} / ${normalizedOptions.length}` : `${normalizedOptions.length} 个`}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="p-1.5 rounded-full hover:bg-[var(--c-input)] active:scale-95 transition-all text-[var(--c-icon,#888)] hover:text-[var(--c-text-title,#111)]"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>

          {/* 2. 当前选中与清空选择（常驻在搜索框上方，避免底部遮挡） */}
          <div className="px-4 py-2 bg-[var(--c-input)]/45 border-b border-[var(--c-panel-border,rgba(0,0,0,0.06))] flex items-center justify-between text-xs text-[var(--c-icon,#888)]">
            <div className="flex items-center gap-1.5 min-w-0 flex-1 pr-2">
              <span className="shrink-0 opacity-75">当前已选:</span>
              <span className="font-semibold truncate text-[var(--c-text-title,#111)]">
                {currentLabel || "未选择"}
              </span>
            </div>
            {value && (
              <button
                type="button"
                onClick={() => handleSelect("")}
                className="shrink-0 hover:underline text-[var(--c-danger,#fa5151)] font-medium transition-colors"
              >
                清空选择
              </button>
            )}
          </div>

          {/* 3. 快捷搜索栏 */}
          <div className="p-3 border-b border-[var(--c-panel-border,rgba(0,0,0,0.06))] bg-[var(--c-panel)]">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all border"
              style={{
                background: "var(--c-input, #f3f4f6)",
                borderColor: "var(--c-input-border, rgba(0,0,0,0.12))",
              }}
            >
              <Search size={16} className="text-[var(--c-icon,#9ca3af)] shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (filteredOptions.length === 1) {
                      handleSelect(filteredOptions[0].value);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                className="flex-1 bg-transparent border-none outline-none text-[calc(13.5px*var(--app-text-scale,1))] text-[var(--c-text-title,#111)] placeholder-[var(--c-icon,#9ca3af)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  className="p-0.5 rounded-full hover:bg-black/10 active:scale-90 text-[var(--c-icon,#888)]"
                  title="清空"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* 4. 候选列表区（滑动时自动收键盘，视野更开阔） */}
          <div
            ref={listRef}
            onTouchStart={handleListTouch}
            className="flex-1 overflow-y-auto px-2 py-2 space-y-1 hide-scrollbar pb-6"
          >
            {/* 正常筛选列表 */}
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    role="button"
                    tabIndex={0}
                    data-selected={isSelected}
                    onClick={() => handleSelect(opt.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(opt.value);
                      }
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 min-h-[40px] rounded-xl text-left transition-all active:scale-[0.99] cursor-pointer select-none box-border"
                    style={{
                      background: isSelected
                        ? "color-mix(in srgb, var(--c-icon-active, #07c160) 12%, transparent)"
                        : "transparent",
                      color: isSelected ? "var(--c-icon-active, #07c160)" : "var(--c-text-title, #1f2937)",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = "var(--c-input, #f3f4f6)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="text-[calc(13.5px*var(--app-text-scale,1))] font-medium break-all leading-snug">
                        {renderHighlightedText(opt.label || opt.value, searchQuery)}
                      </div>
                      {opt.description && (
                        <div className="text-xs text-[var(--c-icon,#9ca3af)] mt-0.5 truncate">
                          {renderHighlightedText(opt.description, searchQuery)}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 ml-2 flex items-center gap-1.5">
                      {isSelected && (
                        <div className="w-5 h-5 flex items-center justify-center shrink-0" style={{ color: "var(--c-icon-active, #07c160)" }}>
                          <Check size={17} strokeWidth={2.5} />
                        </div>
                      )}
                      {opt.onAction && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleClose();
                            opt.onAction!();
                          }}
                          className="w-6 h-6 rounded-full text-[var(--c-icon,#9ca3af)] hover:text-[var(--c-text-title,#111)] hover:bg-[var(--c-input,rgba(0,0,0,0.08))] active:scale-90 transition-all flex items-center justify-center cursor-pointer p-0 shrink-0"
                          title={opt.actionTitle || "编辑"}
                          aria-label={opt.actionTitle || "编辑"}
                        >
                          <MoreVertical size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-center text-[var(--c-icon,#9ca3af)]">
                <Search size={28} className="mb-2 opacity-40" />
                <span className="text-sm font-medium">
                  {normalizedOptions.length === 0 ? emptyText : `未找到包含 "${searchQuery}" 的结果`}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>,
      portalTarget
    )
  ) : null;

  // 模式一：外观与原生 ui-select 100% 一致，右侧仅保留一个向下的箭头
  if (mode === "select") {
    return (
      <div className={`relative flex items-center min-w-0 ${className}`}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen(true)}
          className="ui-select flex-1 flex items-center justify-between text-left cursor-pointer transition-all hover:border-[var(--c-icon-active,rgba(0,0,0,0.3))] active:scale-[0.995]"
          style={{
            paddingRight: "14px",
          }}
          title={currentLabel || placeholder}
        >
          <span
            className="truncate flex-1 pr-2"
            style={{
              color: currentLabel ? "var(--c-text-title)" : "var(--c-icon, #9ca3af)",
            }}
          >
            {currentLabel || placeholder}
          </span>
          <ChevronDown size={16} className="opacity-60 text-[var(--c-icon)] shrink-0" />
        </button>

        {modalContent}
      </div>
    );
  }

  // 模式二：表现为常规 Input 输入框 + 右侧仅保留向下箭头展开按钮
  return (
    <div className={`relative flex items-center flex-1 min-w-0 ${className}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="ui-input w-full pr-10"
      />
      <div className="absolute right-1 inset-y-1 flex items-center pr-1">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={disabled}
          className="h-full px-2 flex items-center justify-center rounded-lg text-xs font-medium transition-all hover:bg-[var(--c-input)] active:scale-95 text-[var(--c-icon,#888)] hover:text-[var(--c-text-title,#111)]"
          title="展开选择列表"
        >
          <ChevronDown size={15} className="opacity-70" />
        </button>
      </div>

      {modalContent}
    </div>
  );
}
