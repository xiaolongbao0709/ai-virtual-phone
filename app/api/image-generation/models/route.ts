import { NextRequest, NextResponse } from "next/server";
export const dynamic = 'force-dynamic'
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

type ModelListRequest = {
  apiKey?: string;
  baseUrl?: string;
};

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

function extractModels(data: unknown): string[] {
  const results: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^models\//, "").trim();
    if (normalized) results.push(normalized);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        push(row.id ?? row.name ?? row.model);
      }
    });
  } else if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const value = row[key];
      if (Array.isArray(value)) results.push(...extractModels(value));
    }
    push(row.id ?? row.name ?? row.model);
  }

  return Array.from(new Set(results));
}

async function externalFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  return dispatcher
    ? undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Response
    : fetch(url, init);
}

export async function POST(req: NextRequest) {
  try {
    const input = await req.json() as ModelListRequest;
    const apiKey = input.apiKey?.trim();
    const baseUrl = input.baseUrl?.trim();
    if (!apiKey) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });
    if (!baseUrl) return NextResponse.json({ error: "缺少 Base URL" }, { status: 400 });

    const res = await externalFetch(buildModelsUrl(baseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `模型列表 API 错误 ${res.status}: ${text.slice(0, 400)}` }, { status: 502 });
    }

    const parsed = JSON.parse(text);
    return NextResponse.json({ models: extractModels(parsed) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
