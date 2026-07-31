import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

// 联机房间：建房/加入/关房/踢人。消息本体不经过这里（浏览器直连
// Supabase Realtime broadcast），本路由只管房间元数据与准入控制。

type RoomRow = {
  id: string;
  code: string;
  channel: string;
  namespace: string;
  host_user_id: string;
  host_name: string;
  title: string;
  max_players: number;
  meta: Record<string, unknown>;
  banned_user_ids: string[];
  status: "open" | "closed";
  created_at: string;
};

const ROOM_COLUMNS = "id,code,channel,namespace,host_user_id,host_name,title,max_players,meta,banned_user_ids,status,created_at";
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 去掉易混淆的 0O1IL

function makeRoomCode(): string {
  const bytes = randomBytes(4);
  let code = "";
  for (let i = 0; i < 4; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function normalizeNamespace(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^(custom_app|game):[\w.-]{1,120}$/.test(raw)) return "";
  return raw;
}

function publicRoom(row: RoomRow, viewerId: string) {
  return {
    id: row.id,
    code: row.code,
    channel: row.channel,
    namespace: row.namespace,
    hostUserId: row.host_user_id,
    hostName: row.host_name,
    title: row.title,
    maxPlayers: row.max_players,
    meta: row.meta ?? {},
    isHost: row.host_user_id === viewerId,
    createdAt: row.created_at,
  };
}

async function closeStaleRooms(): Promise<void> {
  const cutoff = new Date(Date.now() - ROOM_TTL_MS).toISOString();
  await supabaseRestFetch(
    `online_rooms?status=eq.open&created_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "PATCH", body: JSON.stringify({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }) },
  ).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  try {
    if (isSelfHostedModeEnabled()) {
      return NextResponse.json({ ok: false, error: "联机房间需要账号系统（联机模式），单机模式暂不支持。" }, { status: 400 });
    }
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "服务端未配置 Supabase。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "请先登录账号再使用联机功能。" }, { status: 401 });
    }
    if (account.status === "disabled") {
      return NextResponse.json({ ok: false, error: "当前账号已被停用。" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    const namespace = normalizeNamespace(body.namespace);
    if (!namespace) {
      return NextResponse.json({ ok: false, error: "namespace 无效。" }, { status: 400 });
    }

    if (action === "create") {
      await closeStaleRooms();
      // 同命名空间下同一用户只保留一个开放房间：旧房自动关闭
      await supabaseRestFetch(
        `online_rooms?namespace=eq.${encodeSupabaseFilter(namespace)}&host_user_id=eq.${encodeSupabaseFilter(account.id)}&status=eq.open`,
        { method: "PATCH", body: JSON.stringify({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }) },
      ).catch(() => undefined);

      const maxPlayersRaw = Number(body.maxPlayers ?? 8);
      const maxPlayers = Number.isFinite(maxPlayersRaw) ? Math.max(2, Math.min(32, Math.round(maxPlayersRaw))) : 8;
      const title = String(body.title ?? "").slice(0, 80);
      const meta = body.meta && typeof body.meta === "object" && !Array.isArray(body.meta) ? body.meta as Record<string, unknown> : {};
      if (JSON.stringify(meta).length > 4000) {
        return NextResponse.json({ ok: false, error: "meta 过大（上限 4000 字符）。" }, { status: 400 });
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row: RoomRow = {
          id: `room_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`,
          code: makeRoomCode(),
          channel: `olroom_${randomBytes(16).toString("hex")}`,
          namespace,
          host_user_id: account.id,
          host_name: account.displayName || account.username,
          title,
          max_players: maxPlayers,
          meta,
          banned_user_ids: [],
          status: "open",
          created_at: new Date().toISOString(),
        };
        const insert = await supabaseRestFetch<RoomRow[]>("online_rooms", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([row]),
        });
        if (insert.ok) {
          return NextResponse.json({ ok: true, room: publicRoom(insert.data[0] ?? row, account.id) });
        }
        // 房号撞车（部分唯一索引冲突）才重试，其他错误直接抛
        if (!/duplicate|unique/i.test(insert.error)) {
          return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
        }
      }
      return NextResponse.json({ ok: false, error: "房号分配失败，请重试。" }, { status: 500 });
    }

    if (action === "join") {
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) {
        return NextResponse.json({ ok: false, error: "房号格式不对（4 位字母数字）。" }, { status: 400 });
      }
      const found = await supabaseRestFetch<RoomRow[]>(
        `online_rooms?namespace=eq.${encodeSupabaseFilter(namespace)}&code=eq.${encodeSupabaseFilter(code)}&status=eq.open&select=${ROOM_COLUMNS}&limit=1`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      const room = found.data[0];
      if (!room) return NextResponse.json({ ok: false, error: "房间不存在或已关闭。" }, { status: 404 });
      if ((room.banned_user_ids ?? []).includes(account.id)) {
        return NextResponse.json({ ok: false, error: "你已被房主移出该房间。" }, { status: 403 });
      }
      return NextResponse.json({ ok: true, room: publicRoom(room, account.id) });
    }

    if (action === "close" || action === "kick") {
      const roomId = String(body.roomId ?? "").trim();
      if (!roomId) return NextResponse.json({ ok: false, error: "缺少 roomId。" }, { status: 400 });
      const found = await supabaseRestFetch<RoomRow[]>(
        `online_rooms?id=eq.${encodeSupabaseFilter(roomId)}&namespace=eq.${encodeSupabaseFilter(namespace)}&select=${ROOM_COLUMNS}&limit=1`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      const room = found.data[0];
      if (!room) return NextResponse.json({ ok: false, error: "房间不存在。" }, { status: 404 });
      if (room.host_user_id !== account.id) {
        return NextResponse.json({ ok: false, error: "只有房主可以执行该操作。" }, { status: 403 });
      }

      if (action === "close") {
        await supabaseRestFetch(`online_rooms?id=eq.${encodeSupabaseFilter(roomId)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        });
        return NextResponse.json({ ok: true });
      }

      const targetId = String(body.userId ?? "").trim();
      if (!targetId || targetId === account.id) {
        return NextResponse.json({ ok: false, error: "userId 无效。" }, { status: 400 });
      }
      const banned = Array.from(new Set([...(room.banned_user_ids ?? []), targetId])).slice(0, 200);
      await supabaseRestFetch(`online_rooms?id=eq.${encodeSupabaseFilter(roomId)}`, {
        method: "PATCH",
        body: JSON.stringify({ banned_user_ids: banned, updated_at: new Date().toISOString() }),
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "未知 action。" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err) },
      { status: 500 },
    );
  }
}
