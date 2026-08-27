/**
 * 灵动岛"角色陪伴"能力的网页侧封装，对接 ios-shell 注入的 window.NativeLiveActivity
 * （见 ios-shell/FloatShell/ViewController.swift）。
 *
 * 这个桥只在 iOS 壳里存在，普通浏览器/PWA/Android 壳里 window.NativeLiveActivity
 * 是 undefined——所有导出函数都做了可选链式的存在性检测，环境里没有这个桥时
 * 安静地返回"不支持/无操作"，不抛错、不影响其他功能，跟 IOSShell README 里
 * NativeHaptics/NativeDevice 的调用原则一致。
 */

type LiveActivitySupportInfo = { supported: boolean; reason?: string };

type NativeLiveActivityBridge = {
  isSupported: () => Promise<LiveActivitySupportInfo>;
  isEnabled: () => Promise<boolean>;
  setEnabled: (value: boolean) => Promise<void>;
  start: (characterName: string, avatarBase64: string | null | undefined, statusText: string) => Promise<void>;
  update: (statusText: string) => Promise<void>;
  end: () => Promise<void>;
};

function bridge(): NativeLiveActivityBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { NativeLiveActivity?: NativeLiveActivityBridge }).NativeLiveActivity ?? null;
}

/** 当前环境是不是装了这个桥（即：是不是在 ios-shell 里跑）。 */
export function hasNativeLiveActivityBridge(): boolean {
  return bridge() !== null;
}

/** 设备/系统层面支不支持（iOS 16.1+ 且用户没在系统设置里关掉 Live Activities）。 */
export async function isLiveActivitySupported(): Promise<LiveActivitySupportInfo> {
  const b = bridge();
  if (!b) return { supported: false, reason: "no_bridge" };
  try {
    return await b.isSupported();
  } catch {
    return { supported: false, reason: "error" };
  }
}

/** 用户是否愿意开启这个功能（壳里持久化存储，默认 true）。 */
export async function getLiveActivityEnabled(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return await b.isEnabled();
  } catch {
    return false;
  }
}

/**
 * 开关。打开后即使还没调用 start() 传入具体角色，壳自己也会用默认身份兜底
 * 显示一个灵动岛陪伴（见原生侧 startDefaultCompanionIfNeeded）；关闭会立即
 * 收起当前正在跑的 Live Activity。
 */
export async function setLiveActivityEnabled(value: boolean): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.setEnabled(value);
  } catch {
    // 壳不存在或调用失败时静默忽略。
  }
}

/** 开始/切换一个角色陪伴 Live Activity。avatarBase64 建议先压缩到很小尺寸。 */
export async function startLiveActivity(characterName: string, avatarBase64: string | null | undefined, statusText: string): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.start(characterName, avatarBase64, statusText);
  } catch {
    // 静默忽略。
  }
}

/** 更新当前状态文字（比如角色作息变化时）。 */
export async function updateLiveActivity(statusText: string): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.update(statusText);
  } catch {
    // 静默忽略。
  }
}

/** 手动收起。 */
export async function endLiveActivity(): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.end();
  } catch {
    // 静默忽略。
  }
}
