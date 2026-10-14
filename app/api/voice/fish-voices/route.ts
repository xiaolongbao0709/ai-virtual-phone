// Fish Audio 音色列表：拉取「我的音色」（自己克隆/创建的），或按名字搜索公开音色库。
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 15;

type FishModelItem = { _id?: string; id?: string; title?: string; languages?: string[]; author?: { nickname?: string } };

export async function POST(request: Request) {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return Response.json({ ok: false, error: "请求格式错误" }, { status: 400 }); }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) return Response.json({ ok: false, error: "请先填写 API Key" }, { status: 400 });
    const keyword = typeof body.keyword === "string" ? body.keyword.trim().slice(0, 60) : "";
    const language = typeof body.language === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(body.language) ? body.language : "";

    const url = new URL("https://api.fish.audio/model");
    url.searchParams.set("page_size", keyword ? "30" : "100");
    url.searchParams.set("page_number", "1");
    if (keyword || language) {
        // 搜索公开音色库：可按名字，也可只按语种浏览热门音色
        if (keyword) url.searchParams.set("title", keyword);
        if (language) url.searchParams.set("language", language);
        url.searchParams.set("sort_by", "score");
        url.searchParams.set("page_size", "30");
    } else {
        url.searchParams.set("self", "true");
        url.searchParams.set("sort_by", "created_at");
    }

    try {
        const res = await proxyFetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = res.status === 401 || res.status === 403 ? "API Key 无效" : String((data as { message?: string }).message || `请求失败 (${res.status})`);
            return Response.json({ ok: false, error: msg }, { status: res.status });
        }
        const items: FishModelItem[] = Array.isArray((data as { items?: unknown }).items) ? (data as { items: FishModelItem[] }).items : [];
        const voices = items.flatMap(item => {
            const id = String(item._id || item.id || "").trim();
            if (!id) return [];
            const who = (keyword || language) && item.author?.nickname ? ` · ${item.author.nickname}` : "";
            return [{ id, name: `${item.title || "未命名音色"}${who}` }];
        });
        return Response.json({ ok: true, voices }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
        return Response.json({ ok: false, error: `连接 Fish Audio 失败：${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
    }
}
