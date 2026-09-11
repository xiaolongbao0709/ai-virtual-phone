// 个人云快捷指令通知的同源起跳点：声明式 Web Push 的 navigate 需要一个
// 本站地址才能被系统原生导航；本路由校验后 302 到用户自己 Supabase 网关的
// run 入口（网关再 302 到 shortcuts://）。纯转发，不读写任何数据。

const PERSONAL_RUN_URL_PATTERN =
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/ai-phone-push\?action=run&command=cmd_[a-z0-9-]{20,80}&ticket=[a-f0-9]{32}$/i;

export async function GET(request: Request) {
  const to = new URL(request.url).searchParams.get("to") || "";
  if (!PERSONAL_RUN_URL_PATTERN.test(to)) {
    return new Response("链接无效或已过期。", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: to,
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
