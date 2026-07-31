# 联机广场

联机能力的官方示例 APP，也是创作者的活教材——源码即教程。

- **聊天室**：实时房间层（`AiPhone.room.*`）示例。创建房间拿 4 位房号，朋友输入房号加入，消息经 Supabase Realtime 即时互通；房主可踢人，退出自动解散。每人还可以**带一位自己的角色进房**——点「让TA发言」，角色会基于最近聊天记录以自己的人设说话（「带角色上桌」模式：角色由主人的设备本地生成，人设与 API key 不出门，token 由主人消耗）。
- **漂流瓶**：云端共享层（`AiPhone.cloud.*`）示例。`put` 扔瓶子、`takeRandom` 独占捞取、`list(mine)` + `delete` 管理自己的瓶子。

## 使用前提

- 站点已按 `docs/online-play-supabase.sql` 完成联机初始化（建表 + 配置 `SUPABASE_ANON_KEY`）。
- 用户已登录联机账号（单机模式不支持联机）。

## 权限

- `online.play`：多人联机（实时房间 + 云端共享）。
- `ui.toast`：操作提示。

房间事件（`room.message` / `room.players` / `room.state` / `room.closed`）在 manifest `extensions.events` 中声明。
