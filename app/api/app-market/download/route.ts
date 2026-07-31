import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

// 应用包下载：登录 → 校验条目 → 限频留痕 → 换发短时签名 URL。
// 包直链不再对非作者下发（存储桶应设为私有，见 docs/custom-app-market-supabase.sql），
// 匿名批量爬取从此需要账号、受限速、全程留痕，可配合封号处置。

const CUSTOM_APP_PACKAGE_BUCKET = "custom-app-market-packages";
const DOWNLOADS_PER_HOUR = 30;
const SIGN_TTL_SECONDS = 120;

type PackageRow = {
  id: string;
  package_path: string;
  package_url: string;
  review_status: string;
  author_id: string;
};

export async function POST(request: Request) {
  try {
    const config = getSupabaseServerConfig();
    if (!config) return NextResponse.json({ ok: false, error: "服务端未配置 Supabase。" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号再下载应用包。" }, { status: 401 });
    if (account.status === "disabled") return NextResponse.json({ ok: false, error: "当前账号已被停用。" }, { status: 403 });

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "缺少应用 id。" }, { status: 400 });

    const found = await supabaseRestFetch<PackageRow[]>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&deleted_at=is.null&select=id,package_path,package_url,review_status,author_id&limit=1`,
    );
    if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
    const app = found.data[0];
    if (!app) return NextResponse.json({ ok: false, error: "应用不存在或已下架。" }, { status: 404 });
    if (app.review_status !== "approved" && app.author_id !== account.id) {
      return NextResponse.json({ ok: false, error: "应用尚未通过审核。" }, { status: 403 });
    }

    // 限频 + 留痕：防批量爬取；作者取自己的包不占额度不记账。
    // 下载日志表缺失（存量库未跑新版 SQL）时放行不拦，仅失去限频能力。
    if (app.author_id !== account.id) {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await supabaseRestFetch<Array<{ id: string }>>(
        `custom_app_package_downloads?account_id=eq.${encodeSupabaseFilter(account.id)}`
        + `&created_at=gt.${encodeURIComponent(cutoff)}&select=id&limit=${DOWNLOADS_PER_HOUR + 1}`,
      );
      if (recent.ok && recent.data.length >= DOWNLOADS_PER_HOUR) {
        return NextResponse.json(
          { ok: false, error: `下载太频繁（每小时上限 ${DOWNLOADS_PER_HOUR} 个包），请稍后再试。` },
          { status: 429 },
        );
      }
      await supabaseRestFetch("custom_app_package_downloads", {
        method: "POST",
        body: JSON.stringify([{
          id: `dl_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`,
          app_row_id: app.id,
          account_id: account.id,
        }]),
      }).catch(() => undefined);
    }

    // 极早期的行可能没存 package_path，从公开直链里兜底推导
    let path = String(app.package_path ?? "").trim();
    if (!path) {
      const match = String(app.package_url ?? "").match(/\/object\/public\/[^/]+\/(.+)$/);
      path = match ? decodeURIComponent(match[1]) : "";
    }
    if (!path) return NextResponse.json({ ok: false, error: "应用包路径缺失，请联系作者重新发布。" }, { status: 500 });

    const sign = await fetch(`${config.url}/storage/v1/object/sign/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGN_TTL_SECONDS }),
    });
    const signData = await sign.json().catch(() => ({})) as { signedURL?: string };
    if (!sign.ok || !signData.signedURL) {
      // 签名失败（如对象缺失/存储异常）：桶还是公开状态的老部署回落直链，保证不断档
      if (app.package_url) return NextResponse.json({ ok: true, url: app.package_url, fallback: true });
      return NextResponse.json({ ok: false, error: "生成下载链接失败，请稍后再试。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, url: `${config.url}/storage/v1${signData.signedURL}`, expiresIn: SIGN_TTL_SECONDS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
