import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ACCOUNT_GATE_COOKIE, ACCOUNT_SESSION_COOKIE } from "./lib/account-cookie-constants";
import { verifyAccountGateCookieValue } from "./lib/account-gate-cookie";
import { isSelfHostedModeEnabled } from "./lib/self-hosting";

const PUBLIC_ROUTE_PREFIXES = [
  "/verify",
  "/api/auth/",
  "/api/verify/",
  // iPhone Shortcuts does not share the PWA's login cookies. These handlers
  // validate either the bridge token or a short-lived per-command ticket.
  "/shortcut-run/",
  "/api/push/bridge-wake/",
  "/api/push/shortcut-commands/result/",
  "/api/push/shortcut-commands/media/",
  // 个人云的离线生成把「代发触发邮件」外包给站点，同样没有登录 cookie，
  // 凭 bridge_token 认账号（见该路由内的说明）。
  "/api/push/shortcut-commands/deliver-email/",
];

const STATIC_ROUTE_PREFIXES = [
  "/_next/",
  "/birds/",
  "/diary/",
  "/fonts/",
  "/game-builtins/",
  "/game-covers/",
  "/hdri/",
  "/images/",
  "/models/",
  "/widgets/",
  "/xiaohongshu/",
];

const STATIC_FILE_RE = /\.(?:avif|bin|css|gif|glb|gltf|hdr|ico|jpeg|jpg|js|json|map|mjs|mp3|ogg|otf|png|svg|ttf|txt|wasm|wav|webmanifest|webp|woff|woff2)$/i;

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function isStaticRoute(pathname: string): boolean {
  return STATIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || STATIC_FILE_RE.test(pathname);
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function rewriteToHome(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.rewrite(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isSelfHostedModeEnabled()) {
    return NextResponse.next();
  }

  if (isStaticRoute(pathname) || isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value ?? "";
  const gateCookie = request.cookies.get(ACCOUNT_GATE_COOKIE)?.value ?? "";
  const hasValidGate = await verifyAccountGateCookieValue(gateCookie, sessionToken);

  if (hasValidGate) return NextResponse.next();

  if (isApiRoute(pathname)) {
    return NextResponse.json(
      { ok: false, error: "请先登录账号。" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Existing logged-in browsers may only have the original account session
  // cookie until /api/auth/me refreshes the signed gate cookie.
  if (sessionToken || pathname === "/") return NextResponse.next();

  return rewriteToHome(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:avif|bin|css|gif|glb|gltf|hdr|ico|jpeg|jpg|js|json|map|mjs|mp3|ogg|otf|png|svg|ttf|txt|wasm|wav|webmanifest|webp|woff|woff2)$).*)",
  ],
};
