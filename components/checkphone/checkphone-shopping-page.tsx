"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import { ChevronLeft, Heart, RefreshCw, Search, ShoppingBag, Store, Trash2, Truck, ShoppingCart, Home, User, Star, Plus, type LucideIcon } from "lucide-react";
import { CheckPhoneBilingualText, normalizeCheckPhoneText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneShoppingCartItem,
  CheckPhoneShoppingOrder,
  CheckPhoneShoppingOrderItem,
  CheckPhoneShoppingPayload,
  CheckPhoneShoppingProduct,
  CheckPhoneShoppingTone,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneShopping } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";
import { splitBilingualText } from "@/lib/bilingual-text";

type CheckPhoneShoppingPageProps = {
  character: Character;
  onBack: () => void;
};

type ShoppingTabId = "home" | "saved" | "cart" | "orders" | "account";

type ShoppingProductDetail = {
  title: string;
  merchantLabel: string;
  priceLabel: string;
  tagLabel: string;
  detailLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
  quantityLabel?: string;
};

type ShoppingTranslationPreview = {
  original: string;
  translated: string;
};

const SHOPPING_TABS: Array<{ id: ShoppingTabId; label: string; icon: LucideIcon }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "orders", label: "Orders", icon: Truck },
  { id: "cart", label: "Cart", icon: ShoppingCart },
  { id: "account", label: "Favorites", icon: Heart },
];

function ShoppingPreview({
  icon,
  tone,
  large = false,
}: {
  icon: string;
  tone: CheckPhoneShoppingTone;
  large?: boolean;
}) {
  return (
    <div className={`cp-shopping-thumb cp-shopping-thumb--${tone} ${large ? "cp-shopping-thumb--large" : ""}`}>
      <span className={`cp-shopping-preview-icon ${large ? "cp-shopping-preview-icon--large" : ""}`}>{icon}</span>
    </div>
  );
}

function toProductDetail(
  item: CheckPhoneShoppingProduct | CheckPhoneShoppingCartItem | CheckPhoneShoppingOrderItem,
  defaults?: { tagLabel?: string; quantityLabel?: string; detailLabel?: string },
): ShoppingProductDetail {
  return {
    title: item.title,
    merchantLabel: item.merchantLabel,
    priceLabel: item.priceLabel,
    tagLabel: "tagLabel" in item ? item.tagLabel : defaults?.tagLabel ?? "商品",
    detailLabel: defaults?.detailLabel ?? "Description",
    subtitle: item.subtitle,
    detail: item.detail,
    previewIcon: item.previewIcon,
    tone: item.tone,
    quantityLabel: "quantityLabel" in item ? item.quantityLabel : defaults?.quantityLabel,
  };
}

function parseShoppingAmount(label: string): number {
  const match = label.replace(/[¥￥元,\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  const amount = match ? Number(match[0]) : 0;
  return Number.isFinite(amount) ? amount : 0;
}

function parseShoppingQuantity(label?: string): number {
  const match = label?.match(/\d+/);
  const quantity = match ? Number(match[0]) : 1;
  return Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1;
}

function formatShoppingAmount(amount: number): string {
  const safeAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return `¥${Number.isInteger(safeAmount) ? safeAmount : safeAmount.toFixed(2).replace(/\.00$/, "")}`;
}

function getStableShoppingHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function calculateShoppingDiscount(items: CheckPhoneShoppingCartItem[], orderAmount: number): number {
  if (items.length === 0 || orderAmount <= 0) return 0;
  const seed = items.map((item) => `${item.id}:${item.priceLabel}:${item.quantityLabel}`).join("|");
  const rate = 0.05 + (getStableShoppingHash(seed) % 16) / 100;
  return Math.floor(orderAmount * rate * 100) / 100;
}

function getShoppingRating(product: ShoppingProductDetail): string {
  const seed = `${product.title}:${product.merchantLabel}:${product.priceLabel}`;
  return (4.5 + (getStableShoppingHash(seed) % 6) / 10).toFixed(1);
}

export function CheckPhoneShoppingPage({ character, onBack }: CheckPhoneShoppingPageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhoneShoppingPayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<ShoppingTabId>("home");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<ShoppingProductDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "shopping", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [translationPreview, setTranslationPreview] = useState<ShoppingTranslationPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setDebugRawOutput(null);
    setSnapshot(null);
    setSelectedTab("home");
    setSelectedOrderId(null);
    setSelectedProduct(null);
    setTranslationPreview(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneShoppingPayload>(character.id, "shopping");
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    const {
      payload,
      summary,
      error: nextError,
      rawOutput,
    } = await generateCheckPhoneShopping(
      character.id,
      snapshot?.payload ?? null,
      snapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneShoppingPayload> = {
        id: `${character.id}:shopping`,
        characterId: character.id,
        appId: "shopping",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedOrderId(null);
      setSelectedProduct(null);
      setTranslationPreview(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(rawOutput ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "shopping");
    setSnapshot(null);
    setSelectedTab("home");
    setSelectedOrderId(null);
    setSelectedProduct(null);
    setTranslationPreview(null);
    setError(null);
    setDebugRawOutput(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const activeOrder = useMemo(
    () => payload?.orders.find((order) => order.id === selectedOrderId) ?? null,
    [payload, selectedOrderId],
  );
  const cartTotals = useMemo(() => {
    const cartItems = payload?.cartItems ?? [];
    const orderAmount = cartItems.reduce(
      (sum, item) => sum + parseShoppingAmount(item.priceLabel) * parseShoppingQuantity(item.quantityLabel),
      0,
    );
    const discount = calculateShoppingDiscount(cartItems, orderAmount);
    return {
      orderAmount,
      discount,
      totalPayment: Math.max(0, orderAmount - discount),
    };
  }, [payload?.cartItems]);

  const subtitle = selectedProduct
    ? selectedProduct.tagLabel
    : activeOrder
      ? activeOrder.statusLabel
      : payload?.headerSubtitle || "最近的订单与心动";

  const backAction = selectedProduct
    ? () => {
        setTranslationPreview(null);
        setSelectedProduct(null);
      }
    : activeOrder
      ? () => {
          setTranslationPreview(null);
          setSelectedOrderId(null);
        }
      : onBack;

  function renderShoppingCardText(text: string) {
    const normalized = normalizeCheckPhoneText(text);
    const bilingual = splitBilingualText(normalized);

    if (!bilingual) {
      return <span className="cp-shopping-card-title-original">{normalized}</span>;
    }

    const openTranslation = () => setTranslationPreview(bilingual);

    return (
      <span className="cp-shopping-card-title-line">
        <span className="cp-shopping-card-title-original">{bilingual.original}</span>
        <span
          className="cp-shopping-card-title-translate"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openTranslation();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            openTranslation();
          }}
        >
          中文
        </span>
      </span>
    );
  }

  return (
    <div className="cp-shopping-module" style={{ background: "#f8f9fa", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--cp-appbar-safe-top) 24px 16px" }}>
        {!selectedProduct && !activeOrder && selectedTab === "home" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button type="button" onClick={backAction} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <ChevronLeft size={22} strokeWidth={2.5} />
              </button>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#888" }}>Welcome Back 👋</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button type="button" onClick={handleRefresh} style={{ position: "relative", width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <RefreshCw size={18} strokeWidth={2.5} className={loading ? "cp-spin" : ""} />
              </button>
              <button type="button" onClick={() => setConfirmClearOpen(true)} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <Trash2 size={17} strokeWidth={2.25} />
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" onClick={backAction} style={{ width: "34px", height: "34px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <div style={{ flex: 1, minWidth: 0, marginLeft: "12px", display: "flex", alignItems: "center", background: "#fff", borderRadius: "20px", padding: "0 14px", height: "34px", color: "#999", fontSize: "calc(13px*var(--app-text-scale,1))", gap: "10px", boxShadow: "0 3px 12px rgba(0,0,0,0.018)" }}>
              <Search size={17} />
              <span style={{ flex: 1 }}>{payload?.searchHint || "Search..."}</span>
            </div>
          </>
        )}
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">正在刷新购物</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      )}

      <div className="cp-shopping-body">
        {!loaded && <div className="cp-shopping-status">Syncing storefront...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-shopping-status cp-empty-copy">
            <p>暂无购物内容</p>
            <span className="cp-shopping-hint">点刷新同步最近浏览收藏购物车和订单</span>
          </div>
        )}

        {error ? <CheckPhoneDebugErrorCard error={error} debugRawOutput={debugRawOutput} /> : null}

        {payload && !selectedProduct && !activeOrder && (
          <>
            {selectedTab === "home" && (
              <div style={{ padding: "0 24px", marginTop: "-4px", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", background: "#fff", borderRadius: "20px", padding: "0 14px", height: "34px", color: "#999", fontSize: "calc(13px*var(--app-text-scale,1))", gap: "10px", boxShadow: "0 3px 12px rgba(0,0,0,0.018)" }}>
                  <Search size={17} />
                  <span style={{ flex: 1 }}>{payload.searchHint || "Search..."}</span>
                </div>
              </div>
            )}

            <div className="cp-shopping-scroll" style={{ padding: "0 24px 120px", display: "flex", flexDirection: "column", gap: "32px", marginTop: selectedTab === "home" ? 0 : "8px" }}>
              {selectedTab === "home" && (
                <>
                  <section>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                      <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 0 4px" }}>Recommended For You</h2>
                      <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#f46200", fontWeight: 500 }}>See All</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                      {payload.recommendations.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setTranslationPreview(null);
                            setSelectedProduct(toProductDetail(item));
                          }}
                          style={{ minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "12px", display: "flex", flexDirection: "column", textAlign: "left", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", position: "relative" }}
                        >
                          <div style={{ width: "100%", height: "120px", background: "#f5f5f5", borderRadius: "12px", marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(34px*var(--app-text-scale,1))" }}>
                            {item.previewIcon}
                          </div>
                          <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, marginBottom: "4px", display: "block", width: "100%", minWidth: 0 }}>{renderShoppingCardText(item.title)}</strong>
                          <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginBottom: "8px" }}>{item.merchantLabel}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
                            <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                            <div style={{ background: "#f46200", color: "#fff", width: "24px", height: "24px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <Plus size={16} />
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}
              {selectedTab === "cart" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Cart</h2>
                  {payload.cartItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setTranslationPreview(null);
                        setSelectedProduct(toProductDetail(item, { detailLabel: "Inner Thoughts" }));
                      }}
                      style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "16px", display: "flex", alignItems: "center", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", gap: "16px", textAlign: "left" }}
                    >
                      <div style={{ width: "80px", height: "80px", background: "#f5f5f5", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(36px*var(--app-text-scale,1))", flexShrink: 0 }}>
                        {item.previewIcon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", minWidth: 0, gap: "8px" }}>
                          <strong style={{ flex: "1 1 0", fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, display: "block", minWidth: 0 }}>{renderShoppingCardText(item.title)}</strong>
                          <Trash2 size={16} color="#ff6b00" style={{ opacity: 0.8 }} />
                        </div>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginTop: "4px" }}>{item.merchantLabel}</span>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                          <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "#f9f9f9", borderRadius: "14px", padding: "4px 8px" }}>
                            <span style={{ color: "#666", fontSize: "calc(12px*var(--app-text-scale,1))" }}>-</span>
                            <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500 }}>{item.quantityLabel?.replace(/[^0-9]/g, "") || "1"}</span>
                            <span style={{ color: "#333", fontSize: "calc(12px*var(--app-text-scale,1))" }}>+</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                  {payload.cartItems.length > 0 && (
                     <div style={{ marginTop: "16px", background: "#fff", borderRadius: "16px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
                       <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", marginBottom: "12px" }}>
                         <span>Order Amount</span>
                         <span style={{ color: "#222", fontWeight: 500 }}>{formatShoppingAmount(cartTotals.orderAmount)}</span>
                       </div>
                       <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", marginBottom: "16px" }}>
                         <span>Discount</span>
                         <span style={{ color: "#222", fontWeight: 500 }}>{cartTotals.discount > 0 ? `-${formatShoppingAmount(cartTotals.discount)}` : formatShoppingAmount(0)}</span>
                       </div>
                       <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold", borderTop: "1px dashed #eee", paddingTop: "16px", marginBottom: "24px" }}>
                         <span>Total Payment</span>
                         <span>{formatShoppingAmount(cartTotals.totalPayment)}</span>
                       </div>
                       <button style={{ width: "100%", background: "#ff6b00", color: "#fff", borderRadius: "24px", padding: "14px 0", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", border: "none" }}>Checkout</button>
                     </div>
                  )}
                </section>
              )}

              {selectedTab === "orders" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Orders</h2>
                  {payload.orders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => {
                        setTranslationPreview(null);
                        setSelectedOrderId(order.id);
                      }}
                      style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "16px 20px", display: "flex", flexDirection: "column", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", textAlign: "left", gap: "8px", lineHeight: 1.25 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                        <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222" }}>{order.merchantLabel}</strong>
                        <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#ff6b00", fontWeight: 500 }}>{order.statusLabel}</span>
                      </div>
                      <div style={{ display: "flex", gap: "10px", width: "100%", alignItems: "stretch" }}>
                        <div style={{ width: "56px", height: "56px", background: "#f5f5f5", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(24px*var(--app-text-scale,1))", flexShrink: 0 }}>
                          {order.items[0]?.previewIcon || "📦"}
                        </div>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: "56px" }}>
                          <div style={{ display: "flex", flexDirection: "column", transform: "translateY(10px)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <span style={{ flex: 1, minWidth: 0, fontSize: "calc(13px*var(--app-text-scale,1))", color: "#333" }}>{renderShoppingCardText(order.summary)}</span>
                              <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999", whiteSpace: "nowrap" }}>{order.items.length} items</span>
                            </div>
                            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{order.timeLabel}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", lineHeight: 1 }}>
                            <strong style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", lineHeight: 1 }}>{order.totalLabel}</strong>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </section>
              )}

              {selectedTab === "account" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Favorites</h2>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                    {payload.savedItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setTranslationPreview(null);
                          setSelectedProduct(toProductDetail(item, { detailLabel: "Inner Thoughts" }));
                        }}
                        style={{ minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "12px", display: "flex", flexDirection: "column", textAlign: "left", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", position: "relative" }}
                      >
                        <div style={{ position: "absolute", top: "12px", right: "12px", zIndex: 2, background: "#ff6b00", borderRadius: "50%", padding: "4px", color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                          <Heart size={16} fill="white" />
                        </div>
                        <div style={{ width: "100%", height: "120px", background: "#f5f5f5", borderRadius: "12px", marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(34px*var(--app-text-scale,1))" }}>
                          {item.previewIcon}
                        </div>
                        <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, marginBottom: "4px", display: "block", width: "100%", minWidth: 0 }}>{renderShoppingCardText(item.title)}</strong>
                        <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginBottom: "8px" }}>{item.merchantLabel}</div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
                          <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <nav style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "#fff", display: "flex", justifyContent: "space-around", padding: "12px 0 calc(12px + env(safe-area-inset-bottom, 0px))", borderTop: "1px solid #eaeaea", zIndex: 10 }}>
              {SHOPPING_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = selectedTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setTranslationPreview(null);
                      setSelectedTab(tab.id);
                    }}
                    style={{ background: "transparent", border: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", color: active ? "#ff6b00" : "#999" }}
                  >
                    {active ? (
                      <div style={{ background: "#ff6b00", color: "#fff", padding: "8px", borderRadius: "12px" }}>
                        <Icon size={20} strokeWidth={2.5} />
                      </div>
                    ) : (
                      <div style={{ padding: "8px" }}>
                        <Icon size={22} strokeWidth={2} />
                      </div>
                    )}
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: active ? 600 : 500 }}>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {payload && selectedProduct && (
          <div className="cp-scroll-guard" style={{ position: "absolute", inset: 0, zIndex: 20, background: "#fff", display: "flex", flexDirection: "column", overflowY: "auto" }}>
            <header style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--cp-appbar-safe-top) 24px 12px", background: "#fff" }}>
              <button type="button" onClick={() => {
                setTranslationPreview(null);
                setSelectedProduct(null);
              }} style={{ background: "#fff", width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", border: "1px solid #eee", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
                <ChevronLeft size={20} />
              </button>
              <strong style={{ position: "absolute", left: "50%", bottom: "20px", transform: "translateX(-50%)", fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222", fontWeight: 600 }}>Product Details</strong>
              <button type="button" style={{ background: "#fff", width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", border: "1px solid #eee", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
                <Heart size={17} />
              </button>
            </header>
            <div style={{ position: "relative", width: "100%", height: "220px", background: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(72px*var(--app-text-scale,1))" }}>
               {selectedProduct.previewIcon}
            </div>

            <div style={{ padding: "22px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
               <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#ff6b00", fontWeight: 600 }}>{selectedProduct.tagLabel}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>
                    <Star size={12} fill="#ffb800" color="#ffb800" />
                    <span>{getShoppingRating(selectedProduct)}</span>
                  </div>
               </div>

               <h1 style={{ fontSize: "calc(20px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 0", lineHeight: 1.22 }}><CheckPhoneBilingualText text={selectedProduct.title} tone="shopping" /></h1>
               <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#666", marginBottom: "16px" }}>{selectedProduct.merchantLabel}</div>

               <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: "16px", marginBottom: "20px" }}>
                  <h3 style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", marginBottom: "8px" }}>{selectedProduct.detailLabel}</h3>
                  <p style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#666", lineHeight: 1.5, margin: 0 }}>
                    <CheckPhoneBilingualText text={selectedProduct.detail || selectedProduct.subtitle} tone="shopping" />
                  </p>
               </div>

               <div style={{ marginTop: "4px", display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "14px" }}>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>Price</span>
                    <strong style={{ fontSize: "calc(18px*var(--app-text-scale,1))", color: "#222" }}>{selectedProduct.priceLabel}</strong>
                  </div>
                  <button style={{ background: "#222", color: "#fff", border: "none", borderRadius: "24px", padding: "12px 28px", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: "bold", display: "flex", alignItems: "center", gap: "8px" }}>
                    <ShoppingCart size={16} />
                    Add to Cart
                  </button>
               </div>
            </div>
          </div>
        )}

        {payload && activeOrder && (
          <div style={{ position: "absolute", inset: 0, zIndex: 20, background: "#f8f9fa", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <header style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--cp-appbar-safe-top) 24px 16px", background: "#fff", borderBottom: "1px solid #f0f0f0", zIndex: 1 }}>
               <button type="button" onClick={() => {
                 setTranslationPreview(null);
                 setSelectedOrderId(null);
               }} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                  <ChevronLeft size={20} strokeWidth={2.5} />
               </button>
               <strong style={{ fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222" }}>Order Details</strong>
               <div style={{ width: "40px" }} />
            </header>

            <div className="cp-scroll-guard" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
               <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Order Status</span>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#ff6b00", fontWeight: 600 }}>{activeOrder.statusLabel}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Merchant</span>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>{activeOrder.merchantLabel}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Order Date</span>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>{activeOrder.timeLabel}</span>
                  </div>
               </div>

               <h3 style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "8px 0 0 0" }}>Items</h3>
               <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {activeOrder.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setTranslationPreview(null);
                      setSelectedProduct(toProductDetail(item, { tagLabel: activeOrder.statusLabel }));
                    }}
                    style={{ background: "#fff", borderRadius: "16px", padding: "12px", display: "flex", alignItems: "flex-start", border: "none", boxShadow: "0 2px 10px rgba(0,0,0,0.02)", gap: "12px", textAlign: "left" }}
                  >
                    <div style={{ width: "60px", height: "60px", background: "#f5f5f5", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(28px*var(--app-text-scale,1))", flexShrink: 0 }}>
                      {item.previewIcon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, display: "block", lineHeight: 1.32, overflow: "visible", whiteSpace: "normal" }}><CheckPhoneBilingualText text={item.title} tone="shopping" /></strong>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                        <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>x {item.quantityLabel?.replace(/[^0-9]/g, "") || "1"}</span>
                      </div>
                    </div>
                  </button>
                ))}
               </div>

               {activeOrder.note ? (
                 <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)" }}>
                    <h4 style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", marginBottom: "8px" }}>Inner Thoughts</h4>
                    <p style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", margin: 0 }}><CheckPhoneBilingualText text={activeOrder.note} tone="shopping" /></p>
                 </div>
               ) : null}

               <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)", marginTop: "auto" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", marginBottom: "12px" }}>
                    <span>Total Items</span>
                    <span style={{ color: "#222", fontWeight: 500 }}>{activeOrder.items.length}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold", borderTop: "1px dashed #eee", paddingTop: "16px" }}>
                    <span>Amount Paid</span>
                    <span style={{ color: "#ff6b00" }}>{activeOrder.totalLabel}</span>
                  </div>
               </div>
            </div>
          </div>
        )}
      </div>
      {translationPreview && (
        <div
          className="cp-shopping-translation-overlay"
          role="presentation"
          onClick={() => setTranslationPreview(null)}
        >
          <div
            className="cp-shopping-translation-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="中文翻译"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cp-shopping-translation-head">
              <span>中文翻译</span>
              <button type="button" onClick={() => setTranslationPreview(null)}>
                Close
              </button>
            </div>
            <p className="cp-shopping-translation-original">{translationPreview.original}</p>
            <div className="cp-shopping-translation-divider" />
            <p className="cp-shopping-translation-text">{translationPreview.translated}</p>
          </div>
        </div>
      )}
      {confirmClearOpen && (
        <ConfirmDialog
          title="清空购物内容？"
          message="确认后会清空当前购物缓存。之后重新刷新时，不会再带入旧购物内容。"
          variant="danger"
          confirmLabel="确认清空"
          cancelLabel="取消"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
