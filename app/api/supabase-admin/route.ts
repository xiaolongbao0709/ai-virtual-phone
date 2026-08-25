import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

// Supabase 管理 API 代理：api.supabase.com 不对第三方站点返回 CORS 放行头，
// 浏览器直连会被拦，与微信/推送的一键部署走服务端转发是同一原因。
// Access Token 与取回的 service_role key 均只在本次请求中透传，不存储、不记录。

export const runtime = "nodejs";

const MANAGEMENT_API = "https://api.supabase.com/v1";

type AdminPayload = {
  action?: string;
  token?: string;
  projectRef?: string;
  organizationSlug?: string;
  regionCode?: string;
  sql?: string;
};

function cleanToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProjectRef(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]{16,24}$/.test(raw) ? raw : "";
}

function cleanOrganizationSlug(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9_-]{1,79}$/.test(raw) ? raw : "";
}

function cleanRegionCode(value: unknown): "americas" | "emea" | "apac" {
  return value === "americas" || value === "emea" || value === "apac" ? value : "apac";
}

async function upstreamMessage(response: Response): Promise<string> {
  try {
    const data = await response.json() as { message?: unknown; error?: unknown };
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "";
    return message || `Supabase 管理接口返回 HTTP ${response.status}`;
  } catch {
    return `Supabase 管理接口返回 HTTP ${response.status}`;
  }
}

async function managementFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

async function handleOrganizations(token: string): Promise<NextResponse> {
  const response = await managementFetch(token, "/organizations");
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const data = await response.json() as Array<{ id?: unknown; slug?: unknown; name?: unknown }>;
  const organizations = (Array.isArray(data) ? data : [])
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      slug: typeof item.slug === "string" ? item.slug : "",
      name: typeof item.name === "string" ? item.name : "",
    }))
    .filter((item) => item.slug);
  return NextResponse.json({ ok: true, organizations });
}

async function handleCreateProject(
  token: string,
  organizationSlug: string,
  regionCode: "americas" | "emea" | "apac",
): Promise<NextResponse> {
  // 只为创建请求生成一次，既不返回浏览器也不持久化。应用后续通过项目密钥工作，
  // 用户若需要直连数据库，可在自己的 Supabase Dashboard 中重设数据库密码。
  const dbPass = `${randomBytes(36).toString("base64url")}Aa1!`;
  const response = await managementFetch(token, "/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "AI Phone Personal Cloud",
      organization_slug: organizationSlug,
      db_pass: dbPass,
      region_selection: { type: "smartGroup", code: regionCode },
    }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const data = await response.json() as { id?: unknown; ref?: unknown; status?: unknown };
  const projectRef = typeof data.ref === "string" ? data.ref : typeof data.id === "string" ? data.id : "";
  if (!cleanProjectRef(projectRef)) {
    return NextResponse.json({ ok: false, error: "Supabase 已创建项目，但没有返回有效的项目标识。" }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    projectRef,
    status: typeof data.status === "string" ? data.status : "",
  });
}

async function handleProjectStatus(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}`);
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const data = await response.json() as { status?: unknown };
  return NextResponse.json({ ok: true, status: typeof data.status === "string" ? data.status : "" });
}

async function handleAssertDedicatedProject(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/database/query`, {
    method: "POST",
    body: JSON.stringify({
      query: `select case
        when to_regclass('public.ai_phone_cloud_meta') is not null then 'personal-cloud-safe-v2'
        when not exists (
          select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and c.relname <> all (array[
              'push_server_config', 'push_subscriptions', 'push_jobs', 'push_outbox',
              'push_shortcut_commands', 'push_bridge_config', 'push_bridge_snapshots',
              'push_screen_sessions', 'push_screen_threads'
            ])
        ) then 'personal-cloud-safe-v2'
        else 'shared-project-blocked'
      end as deployment_guard`,
      read_only: true,
    }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const rows = await response.json().catch(() => null) as Array<{ deployment_guard?: unknown }> | null;
  const guard = Array.isArray(rows) && typeof rows[0]?.deployment_guard === "string"
    ? rows[0].deployment_guard
    : "";
  if (guard === "shared-project-blocked") {
    return NextResponse.json(
      { ok: false, error: "检测到该项目包含其他业务表，已中止个人云部署。请使用新建的独立 Supabase 项目。" },
      { status: 409 },
    );
  }
  if (guard !== "personal-cloud-safe-v2") {
    return NextResponse.json({ ok: false, error: "无法确认目标项目为独立个人云，已中止部署。" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

async function handleApiKeys(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/api-keys?reveal=true`);
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const data = await response.json() as Array<{ name?: unknown; api_key?: unknown; type?: unknown }>;
  const rows = Array.isArray(data) ? data : [];
  const pick = (predicate: (row: { name?: unknown; type?: unknown }) => boolean): string => {
    const row = rows.find((item) => predicate(item) && typeof item.api_key === "string" && item.api_key.trim());
    return row && typeof row.api_key === "string" ? row.api_key.trim() : "";
  };
  // 旧版项目返回 name=service_role 的 JWT key；新版密钥体系是 type=secret 的 sb_secret_ key。
  const serviceRoleKey = pick((row) => row.name === "service_role") || pick((row) => row.type === "secret");
  if (!serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "该项目没有可用的 service_role/secret key，请改用手动填写。" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, serviceRoleKey });
}

async function handleRunSql(token: string, projectRef: string, sql: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql, read_only: false }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: AdminPayload;
  try {
    payload = await request.json() as AdminPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const token = cleanToken(payload.token);
  if (!token) return NextResponse.json({ ok: false, error: "缺少 Access Token。" }, { status: 400 });

  try {
    if (payload.action === "organizations") return await handleOrganizations(token);
    if (payload.action === "create_project") {
      const organizationSlug = cleanOrganizationSlug(payload.organizationSlug);
      if (!organizationSlug) return NextResponse.json({ ok: false, error: "组织标识不合法。" }, { status: 400 });
      return await handleCreateProject(token, organizationSlug, cleanRegionCode(payload.regionCode));
    }

    const projectRef = cleanProjectRef(payload.projectRef);
    if (!projectRef) return NextResponse.json({ ok: false, error: "项目标识不合法。" }, { status: 400 });

    if (payload.action === "project_status") return await handleProjectStatus(token, projectRef);
    if (payload.action === "assert_dedicated_project") return await handleAssertDedicatedProject(token, projectRef);
    if (payload.action === "api_keys") return await handleApiKeys(token, projectRef);
    if (payload.action === "run_sql") {
      const sql = typeof payload.sql === "string" ? payload.sql : "";
      if (!sql.trim()) return NextResponse.json({ ok: false, error: "缺少要执行的 SQL。" }, { status: 400 });
      if (sql.length > 100_000) return NextResponse.json({ ok: false, error: "SQL 过长。" }, { status: 400 });
      return await handleRunSql(token, projectRef, sql);
    }
    return NextResponse.json({ ok: false, error: "未知操作。" }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: "暂时无法连接 Supabase 管理接口。" }, { status: 502 });
  }
}
