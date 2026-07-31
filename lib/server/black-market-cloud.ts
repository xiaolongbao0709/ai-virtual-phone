import type { AppAccount } from "./account-auth";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";
import type {
  BlackMarketRenderRule,
  BlackMarketTheaterRarity,
  BlackMarketTheaterTemplate,
  BlackMarketTransaction,
  BlackMarketTransactionType,
  BlackMarketWalletState,
} from "@/lib/black-market-types";

type WalletRecord = {
  user_id?: unknown;
  display_name?: unknown;
  balance?: unknown;
  last_checkin_date?: unknown;
  updated_at?: unknown;
};

type TransactionRecord = {
  id?: unknown;
  type?: unknown;
  amount?: unknown;
  title?: unknown;
  detail?: unknown;
  theater_id?: unknown;
  theater_title?: unknown;
  counterparty_id?: unknown;
  counterparty_name?: unknown;
  balance_after?: unknown;
  created_at?: unknown;
};

type PurchasedTheaterRecord = {
  theater_id?: unknown;
  template_snapshot?: unknown;
  created_at?: unknown;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampCredits(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount));
}

function normalizeTransactionType(value: unknown): BlackMarketTransactionType {
  return value === "daily_checkin"
    || value === "purchase"
    || value === "creator_income"
    || value === "manual_adjust"
    ? value
    : "initial_grant";
}

function normalizeTransaction(record: TransactionRecord): BlackMarketTransaction | null {
  const id = cleanText(record.id, 160);
  if (!id) return null;
  return {
    id,
    type: normalizeTransactionType(record.type),
    amount: Math.round(Number(record.amount) || 0),
    title: cleanText(record.title, 80) || "黑市流水",
    detail: cleanText(record.detail, 240),
    theaterId: cleanText(record.theater_id, 160) || undefined,
    theaterTitle: cleanText(record.theater_title, 80) || undefined,
    counterpartyId: cleanText(record.counterparty_id, 160) || undefined,
    counterpartyName: cleanText(record.counterparty_name, 80) || undefined,
    balanceAfter: clampCredits(record.balance_after),
    createdAt: cleanText(record.created_at, 80) || new Date().toISOString(),
  };
}

function normalizeRarity(value: unknown): BlackMarketTheaterRarity {
  return value === "rare" || value === "legend" || value === "encrypted" ? value : "common";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeRenderRule(value: unknown): BlackMarketRenderRule | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 80);
  const pattern = cleanText(record.pattern, 1000);
  if (!id || !pattern) return null;
  return {
    id,
    name: cleanText(record.name, 80) || "渲染规则",
    pattern,
    flags: cleanText(record.flags, 12) || "g",
    className: cleanText(record.className, 120) || "bm-render-rule",
    template: cleanText(record.template, 2000) || "<span>$&</span>",
  };
}

function normalizeRenderRules(value: unknown): BlackMarketRenderRule[] {
  if (Array.isArray(value)) return value.map(normalizeRenderRule).filter((item): item is BlackMarketRenderRule => Boolean(item));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeRenderRules(parsed);
  } catch {
    return [];
  }
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeTags(parsed);
  } catch {
    return value.split(/[,\s，、]+/).map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  }
}

function normalizePurchasedTheater(record: PurchasedTheaterRecord): BlackMarketTheaterTemplate | null {
  const snapshot = record.template_snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  const id = cleanText(value.id ?? record.theater_id, 160);
  const title = cleanText(value.title, 80);
  const openingHtml = cleanText(value.opening_html ?? value.openingHtml, 60000);
  const aiInstruction = cleanText(value.ai_instruction ?? value.aiInstruction, 30000);
  if (!id || !title || !openingHtml || !aiInstruction) return null;
  return {
    id,
    title,
    codeName: cleanText(value.code_name ?? value.codeName, 80) || id.toUpperCase(),
    fileNumber: cleanText(value.file_number ?? value.fileNumber, 80),
    subtitle: cleanText(value.subtitle, 160),
    synopsis: cleanText(value.synopsis, 600),
    storyText: cleanText(value.story_text ?? value.storyText, 2000),
    tags: normalizeTags(value.tags),
    rarity: normalizeRarity(value.rarity),
    glyph: cleanText(value.glyph, 8) || "◆",
    price: clampCredits(value.price),
    authorId: cleanText(value.author_id ?? value.authorId, 160) || "anonymous",
    authorName: cleanText(value.author_name ?? value.authorName, 80) || "匿名卖家",
    source: "community",
    version: Math.max(1, clampCredits(value.version) || 1),
    durationTurns: Math.min(30, Math.max(1, clampCredits(value.duration_turns ?? value.durationTurns) || 8)),
    allowExternalControl: normalizeBoolean(value.allow_external_control ?? value.allowExternalControl),
    openingHtml,
    aiInstruction,
    outputContract: cleanText(value.output_contract ?? value.outputContract, 12000),
    renderRules: normalizeRenderRules(value.render_rules ?? value.renderRules).slice(0, 20),
    renderCss: cleanText(value.render_css ?? value.renderCss, 20000),
    memorySummaryPrompt: cleanText(value.memory_summary_prompt ?? value.memorySummaryPrompt, 12000),
    purchaseCount: clampCredits(value.purchase_count ?? value.purchaseCount),
    rating: Math.min(5, Math.max(0, Number(value.rating) || 0)),
    createdAt: cleanText(value.created_at ?? value.createdAt, 80) || cleanText(record.created_at, 80) || new Date().toISOString(),
    updatedAt: cleanText(value.updated_at ?? value.updatedAt, 80) || cleanText(record.created_at, 80) || new Date().toISOString(),
  };
}

function normalizeWallet(record: WalletRecord, account: AppAccount, transactions: BlackMarketTransaction[]): BlackMarketWalletState {
  return {
    userId: cleanText(record.user_id, 160) || account.id,
    displayName: cleanText(record.display_name, 80) || account.displayName,
    balance: clampCredits(record.balance),
    lastCheckinDate: cleanText(record.last_checkin_date, 80) || undefined,
    transactions,
    updatedAt: cleanText(record.updated_at, 80) || new Date().toISOString(),
  };
}

function rpcRecord<T>(data: unknown): T {
  if (Array.isArray(data)) return data[0] as T;
  return data as T;
}

export function mapBlackMarketCloudError(error: string): string {
  if (/black_market_wallets|black_market_purchases|black_market_wallet_transactions|black_market_purchase_theater|black_market_checkin|schema cache|does not exist|PGRST/i.test(error)) {
    return `黑市钱包表尚未创建或函数未更新：请先在 Supabase SQL Editor 执行 docs/black-market-supabase.sql。（原始错误：${error.slice(0, 300)}）`;
  }
  if (/already_checked_in/i.test(error)) return "今天已经签到过了。";
  if (/theater_not_found/i.test(error)) return "夜间档案不存在或已下架。";
  if (/cannot_purchase_own_theater/i.test(error)) return "不能购买自己发布的夜间档案。";
  if (/already_purchased|duplicate key/i.test(error)) return "已经收入暗柜。";
  if (/insufficient_shadow_credits/i.test(error)) return "暗影信用点不足。";
  return error;
}

export async function loadBlackMarketCloudWallet(account: AppAccount): Promise<BlackMarketWalletState> {
  const ensure = await supabaseRestFetch<WalletRecord | WalletRecord[]>("rpc/black_market_ensure_wallet", {
    method: "POST",
    body: JSON.stringify({ p_user_id: account.id, p_display_name: account.displayName }),
  });
  if (!ensure.ok) throw new Error(mapBlackMarketCloudError(ensure.error));

  const transactionsResult = await supabaseRestFetch<TransactionRecord[]>(
    `black_market_wallet_transactions?user_id=eq.${encodeSupabaseFilter(account.id)}&select=id,type,amount,title,detail,theater_id,theater_title,counterparty_id,counterparty_name,balance_after,created_at&order=created_at.desc&limit=200`,
  );
  if (!transactionsResult.ok) throw new Error(mapBlackMarketCloudError(transactionsResult.error));

  const transactions = transactionsResult.data
    .map(normalizeTransaction)
    .filter((item): item is BlackMarketTransaction => Boolean(item));
  return normalizeWallet(rpcRecord<WalletRecord>(ensure.data), account, transactions);
}

export async function checkInBlackMarketCloud(account: AppAccount): Promise<BlackMarketWalletState> {
  const result = await supabaseRestFetch<{ wallet?: WalletRecord }>("rpc/black_market_checkin", {
    method: "POST",
    body: JSON.stringify({ p_user_id: account.id, p_display_name: account.displayName }),
  });
  if (!result.ok) throw new Error(mapBlackMarketCloudError(result.error));
  return loadBlackMarketCloudWallet(account);
}

export async function purchaseBlackMarketTheaterCloud(account: AppAccount, theaterId: string): Promise<{
  wallet: BlackMarketWalletState;
  theater: unknown;
}> {
  const result = await supabaseRestFetch<{ theater?: unknown }>("rpc/black_market_purchase_theater", {
    method: "POST",
    body: JSON.stringify({
      p_buyer_id: account.id,
      p_buyer_name: account.displayName,
      p_theater_id: theaterId,
    }),
  });
  if (!result.ok) throw new Error(mapBlackMarketCloudError(result.error));
  const wallet = await loadBlackMarketCloudWallet(account);
  return { wallet, theater: result.data?.theater ?? null };
}

export async function loadPurchasedBlackMarketTheatersCloud(account: AppAccount): Promise<BlackMarketTheaterTemplate[]> {
  const result = await supabaseRestFetch<PurchasedTheaterRecord[]>(
    `black_market_purchases?buyer_id=eq.${encodeSupabaseFilter(account.id)}&select=theater_id,template_snapshot,created_at&order=created_at.desc&limit=200`,
  );
  if (!result.ok) throw new Error(mapBlackMarketCloudError(result.error));
  return result.data
    .map(normalizePurchasedTheater)
    .filter((item): item is BlackMarketTheaterTemplate => Boolean(item));
}
