// 自定义 APP 权限的中文文案（应用市场详情、安装确认、运行器菜单等共用）。
// 单一来源，避免多处各抄一份导致漂移。
// 注意：这里必须覆盖 CustomAppPermission 全集——没有文案的权限会在安装弹窗
// 显示英文原串，用户无法理解自己在授权什么。

export const PERMISSION_LABELS: Record<string, string> = {
  "app.data.read": "读取本 APP 私有数据",
  "app.data.write": "写入本 APP 私有数据",
  "app.assets.read": "读取本 APP 资源文件",
  "app.manifest.read": "读取本 APP 清单信息",
  "ai.generate": "调用模型生成内容",
  "ai.generateImage": "调用模型生成图片",
  "ai.chat": "自由调用对话模型",
  "ai.embed": "调用向量嵌入模型",
  "ai.classify": "调用文本分类模型",
  "network.fetch": "联网访问外部服务器（APP 可将读到的数据发送出去）",
  "voice.tts": "调用语音合成（消耗你的语音额度）",
  "voice.stt": "使用语音识别",
  "voice.clone": "克隆音色（消耗你的语音额度）",
  "voice.readProfiles": "读取语音配置列表（不含密钥）",
  "user.profile.read": "读取用户昵称与头像",
  "user.persona.read": "读取用户人设",
  "user.preferences.read": "读取用户偏好设置",
  "chat.read": "读取聊天消息",
  "chat.read.background": "后台监听聊天消息",
  "chat.write": "写入聊天记录",
  "chat.sendMessage": "以用户身份发送聊天消息",
  "chat.sendCard": "向聊天室发送 APP 卡片",
  "chat.requestReply": "请求角色在聊天室回复",
  "chat.contacts.write": "修改聊天联系人状态",
  "chat.tools": "在生成中使用聊天工具",
  "characters.read": "读取角色基础信息",
  "characters.state.read": "读取角色状态",
  "characters.state.write": "修改角色状态",
  "characters.relations.read": "读取角色关系",
  "calendar.read": "读取日历日程",
  "calendar.write": "写入日历日程",
  "world.read": "读取世界书",
  "world.write": "写入世界书",
  "world.activate": "启停世界书条目",
  "memory.readCore": "读取核心记忆",
  "memory.readLongTerm": "读取长期记忆",
  "memory.readShortTerm": "读取短期记忆",
  "memory.search": "检索记忆",
  "memory.write": "写入记忆",
  "memory.suggest": "提交记忆建议",
  "media.pick": "选择本地图片或文件",
  "media.save": "保存文件到本地",
  "geo.read": "获取你的当前位置",
  "geo.watch": "在 APP 打开期间持续获取你的位置",
  "notifications.read": "读取本 APP 通知",
  "notifications.write": "写入通知和桌面红点",
  "tasks.schedule": "创建后台定时任务",
  "ui.toast": "显示提示",
  "ui.notification": "显示通知",
  "ui.sms": "触发短信界面",
  "ui.call": "触发通话界面",
  "wallet.read": "读取钱包余额",
  "wallet.pay": "从钱包付款",
  "bridge.send": "通过现实桥向 iPhone 快捷指令回传数据",
  "bridge.read": "读取现实桥的手机状态快照",
  "online.play": "多人联机（与其他玩家实时互通，你的昵称会展示给同房间玩家）",
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

type ManifestWithNetwork = {
  network?: { allowedDomains?: string[] } | null;
} | null | undefined;

// network.fetch 是唯一能把 APP 读到的数据送出设备的通道，安装/详情页必须
// 把 manifest 声明的目标域名亮出来，让用户知道数据会流向哪里。
export function permissionLabelWithContext(permission: string, manifest?: ManifestWithNetwork): string {
  if (permission === "network.fetch") {
    const domains = (manifest?.network?.allowedDomains ?? [])
      .map(domain => String(domain ?? "").trim())
      .filter(Boolean);
    if (domains.length > 0) {
      return `联网访问：${domains.join("、")}（APP 可将读到的数据发送到这些服务器）`;
    }
  }
  return permissionLabel(permission);
}
