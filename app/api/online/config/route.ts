import { NextResponse } from "next/server";

import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";

// 联机运行时配置：浏览器直连 Supabase Realtime 需要项目 URL 和 anon key。
// anon key 是 Supabase 设计上可公开的密钥（数据表已全部启用 RLS 且只走
// service key），这里只是把它从服务端环境变量转交给前端，省去构建期注入。
export async function GET() {
  const config = getSupabaseServerConfig();
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!config || !anonKey) {
    return NextResponse.json({ ok: true, configured: false });
  }
  return NextResponse.json({
    ok: true,
    configured: true,
    supabaseUrl: config.url,
    anonKey,
  });
}
