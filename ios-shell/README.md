# Float 小手机 · iOS 壳（FloatShell for iOS）

一个极薄的 iOS App 壳：全屏 WKWebView 直接加载线上生产站点
`https://mianmianfloat.duckdns.org`。壳本身不包含任何业务逻辑、不做静态导出、
不内置任何密钥——所有功能（私聊/群聊/朋友圈/语音消息、角色卡、世界书、预设、
正则、模型设置、应用市场、游戏大厅、便签墙、生图/语音/音乐、个人云、云端备份
恢复、微信接入、现实桥、文件上传下载、PWA 能力等）都来自网页本身，网页部署
即时生效，壳不需要跟着重新提审。

## 为什么是原生 WKWebView 壳，而不是 Capacitor / 静态导出

1. **架构审计结论**：`ai-virtual-phone` 是服务端渲染的 Next.js 15 应用，依赖
   `app/api/**` 路由（含 `app/api/llm-proxy`）、VPS 上的 systemd 服务
   （3001 端口）、Nginx 反代和用户自己的 Supabase 项目。它**不能**做
   `next export` 静态导出——API 路由、cookie/session、服务端密钥隔离都要求
   有真正的 Node 服务器在跑。把它导出成静态站会直接砍掉登录门禁、
   LLM 代理、云函数触发等一整类功能，这是明确要避免的。
2. **对照 `android-shell/`**：仓库里已有的安卓壳是纯原生 Kotlin + `WebView`
   （不是 Cordova/Capacitor），只做"全屏加载远程站点 + 原生能力桥接"，网页
   更新不需要重新分发安装包。iOS 壳沿用同一思路：原生 Swift + `WKWebView`，
   结构上和安卓壳一一对应，方便同一个人后续同时维护两端。
3. **相比 Capacitor**：Capacitor 需要额外的 `npx cap sync`、CocoaPods 依赖链、
   以及 `capacitor.config` 里的服务器配置。给这个已经是"纯远程网页壳"的场景，
   原生 WKWebView 项目更薄、构建链更短、和 android-shell 的心智模型一致，也
   不需要在 Node 侧维护一套 Capacitor 专属配置。如果未来需要更多原生插件
   （比如真正的 APNs 推送、后台任务），可以在评估具体插件需求后再引入
   Capacitor 或 Cordova 插件生态；现阶段"保留全部现有网页功能"这个目标，
   原生壳已经足够。

## 与 android-shell 的对应关系

| 能力 | android-shell | ios-shell |
| --- | --- | --- |
| 加载方式 | 全屏 `WebView` 加载 `BuildConfig.SITE_URL` | 全屏 `WKWebView` 加载 `Info.plist` 里的 `FLOAT_SITE_URL` |
| 站内导航 vs 外链 | `shouldOverrideUrlLoading` 按 host 判断 | `decidePolicyFor navigationAction` 按 host 判断 |
| 文件上传（`<input type=file>`） | 系统文件选择器 Intent | iOS 15+ 的 WKWebView 内置支持，系统自动弹出选择器，壳不需要写任何代码 |
| 文件下载 | `DownloadManager` 落到「下载」目录 | `WKDownloadDelegate` 落到临时目录后弹系统分享面板，用户选择保存位置 |
| 麦克风/摄像头（语音消息、通话） | 转授系统运行时权限给 WebView | `requestMediaCapturePermissionFor` 转授系统权限给 WKWebView |
| Cookie/LocalStorage/IndexedDB | WebView 默认持久化存储 | `WKWebsiteDataStore.default()`（持久化，非隐私模式） |
| 离线推送 | 前台服务 + Supabase Realtime WebSocket 长连接（无需 GMS） | 走 Bark（第三方转发 App），见下方「已知限制」 |
| 深色模式/安全区/横竖屏 | 系统默认支持 | 系统默认支持（`UIUserInterfaceStyle=Automatic`，WKWebView 自动适配安全区） |

## 网页可选调用的原生桥

壳启动时会往网页注入两个全局对象，网页侧**按需调用，不调用完全不影响功能**
（这些对象只在本壳里存在，网页要用 `window.NativeHaptics?.impact?.()` 这种
可选链写法做特征检测，别的环境下没有这个对象）：

- `window.IOSShell = { platform: 'ios', version: '1.0.0' }`——环境识别，对应
  Android 壳的 `window.AndroidShell`。
- `window.NativeHaptics`——触发系统触感反馈（发消息、收到回复、解锁角色卡这类
  时刻用震动增加"原生感"）：
  - `NativeHaptics.impact('light' | 'medium' | 'heavy' | 'rigid' | 'soft')`
  - `NativeHaptics.notify('success' | 'warning' | 'error')`
  - `NativeHaptics.selection()`

这两个对象只是**壳提供的能力**，网页代码目前还没有在任何地方调用
`NativeHaptics`——要在具体交互（发送消息、收到回复等）上触发震动，需要另外
改网页代码接上这个调用，属于后续的网页侧改动，不在这次壳工程改动范围内。

## 目录结构

```
ios-shell/
├── FloatShell.xcodeproj/
│   ├── project.pbxproj
│   └── xcshareddata/xcschemes/FloatShell.xcscheme   # 已包含共享 Scheme，签名方无需手动创建
├── FloatShell/
│   ├── AppDelegate.swift
│   ├── SceneDelegate.swift
│   ├── ViewController.swift        # 核心壳逻辑，见文件内注释
│   ├── Info.plist
│   ├── Assets.xcassets/AppIcon.appiconset/   # 只有 Contents.json，真实图标 PNG 需要签名方/你自行放入
│   └── Base.lproj/LaunchScreen.storyboard
├── Config.xcconfig                 # 唯一需要改的构建配置：Bundle ID / Team ID / 部署目标
├── ExportOptions.example.plist     # xcodebuild -exportArchive 用的导出配置模板
└── README.md                       # 本文件
```

## 需要填写的占位项

全部集中在 [`Config.xcconfig`](./Config.xcconfig)，不需要改 `project.pbxproj`：

| 键 | 说明 | 当前值 |
| --- | --- | --- |
| `DEVELOPMENT_TEAM` | 签名方自己的 Apple Developer Team ID | **空，必填** |
| `PRODUCT_BUNDLE_IDENTIFIER` | Bundle ID | `com.mianmian.floatphone`（如与已注册的 App ID 冲突请自行更换，不要擅自用别人的 ID 去注册证书） |
| `IPHONEOS_DEPLOYMENT_TARGET` | 最低支持 iOS 版本 | `15.0`（用到了 `WKDownload` / `requestMediaCapturePermission` 等 iOS 15+ API） |
| `FLOAT_SITE_URL` | App 启动加载的地址 | `https://mianmianfloat.duckdns.org`（公开域名，非密钥，可以放心提交到仓库；**不要**改成 localhost 或裸 IP） |
| `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` | 版本号 | `1.0.0` / `1` |

`Assets.xcassets/AppIcon.appiconset/` 里的全部图标已经生成好了，直接复用了网页
PWA 现成的 `public/icon-512.png`（气球+云朵那张），从 20×20 到 1024×1024 全部
尺寸都有，不需要再另外准备图片。唯一要注意的是 1024×1024 那张是从 512×512
放大来的，不是原生高清图——Ad Hoc/企业签内测分发完全没问题，如果之后要正式
上架 App Store，建议换一张原生 1024×1024 的图源以获得最佳清晰度。

## 需要开启的权限 / Capabilities

`Info.plist` 已经声明了以下内容，签名方一般不需要改：

- `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`：语音消息、
  语音/视频通话（网页的 `getUserMedia`）会触发系统权限弹窗，文案可按需改写。
- `NSPhotoLibraryAddUsageDescription`：WKWebView 内长按图片"存储图像"到相册。
- `UIUserInterfaceStyle = Automatic`：跟随系统深色模式。
- `UISupportedInterfaceOrientations`（iPhone）/ `~ipad`：支持横竖屏。
- `ITSAppUsesNonExemptEncryption = false`：只用标准 HTTPS/TLS，跳过出口合规
  问卷（如果之后加了自定义加密逻辑要相应改成 true 并如实申报）。

**不需要**额外勾选 Push Notifications、Background Modes、App Groups、iCloud
这些 Capability（真推送走的是 Bark，不需要苹果自己的 APNs 证书/权限，见下文）。

工程里预留了一个 Capability：**Associated Domains**（用来实现"点击 Bark
推送里的链接，直接跳进这个 App，而不是打开 Safari"，即 Universal Links），
但**默认是关闭的**——`FloatShell.entitlements` 里这段被注释掉了。

**为什么默认关闭**：这项能力要求签名用的证书/描述文件本身支持它，很多基础档位
的重签名服务（包括不少"全能签"类工具）不支持，签出来的包一装就闪退或者
卡白屏（现象详见下方"已知限制"和一次真实踩坑记录）。默认关闭是为了保证
"打开 App 能看到网站"这个最基本的需求先能稳定跑通。

**想开启这个功能**，需要：

1. 确认你用的签名服务/证书支持 Associated Domains 这项能力（问一下商家）；
2. 打开 `FloatShell.entitlements`，取消注释里面的 `com.apple.developer.associated-domains` 那几行；
3. 打开 `public/.well-known/apple-app-site-association`（仓库根目录的
   `public/` 里，不是 `ios-shell/` 里面），把占位符
   `TEAMID.com.mianmian.floatphone` 换成 `<你的真实 Team ID>.com.mianmian.floatphone`；
4. 把改动过的网站重新部署到生产环境（这一步我不会替你做，需要你自己确认后执行）；
5. 重新走一遍 GitHub 云端编译 + 重签名。

在开启之前，Bark 推送里的链接依然可以正常点开，只是会跳到 **Safari**，
而不是这个 App——不影响基本可用性，只是体验上少了"直接跳回 App"这一层。

## 数据存储与云备份行为说明（务必告知最终用户）

- **WKWebView 的 Cookie / localStorage / IndexedDB 使用系统默认持久化
  `WKWebsiteDataStore`**，数据会跨 App 启动保留，登录态、API 设置、
  聊天记录、角色数据都能正常落地——这一点和 android-shell 里 `WebView`
  的持久化存储行为一致。
- **但 iOS 的 App 沙箱和 Safari 是天然隔离的**：iPhone 上的 Safari 浏览器
  打开同一个网址时，看到的是完全独立的一份本地数据（IndexedDB、
  localStorage、Cookie 互不相通）。这**不是 bug**，是 iOS/WebKit 的沙箱
  设计——同一台 iPhone 上"Safari 里的小手机"和"这个壳里的小手机"是两份
  互相看不见对方本地数据的实例，就像 android-shell 文档里写的"壳内数据和
  手机浏览器不互通"完全一样。
- 因此，从 Safari 迁移到本壳（或反过来）**必须**走项目已有的手动路径：
  - 网页 设置 → 数据管理 → **导出备份** / **导入备份**（本地文件迁移）；
  - 或者两边都用**云端备份**过渡：先在旧环境点"立即备份"，再在新环境点
    "云端恢复"。
- 本次交付**没有修改**任何云备份/云端恢复/导出导入云端配置的前端或云函数
  代码，行为和网页版完全一致：
  - 云端恢复必须用户在界面上主动点击才会触发，壳不会自动拉取覆盖；
  - 没有引入任何定时任务/自动全量同步逻辑，壳只是浏览器外壳，不会自己
    发起任何网络请求；
  - "导出已有云端配置" / "导入已有云端配置" 两个入口保持不变，手机上用
    这个壳打开网页、导入电脑端导出的云端配置文件，即可连上同一个用户自己
    的 Supabase 项目——配置文件本身可能含 Supabase 私密密钥，**不要**通过
    群聊/公开网盘传输，也不要把它提交进这个仓库。

## 安全说明

- 本工程（源码 + `project.pbxproj` + `Config.xcconfig` + `Info.plist`）**不包含
  也不应该包含**任何 Supabase `service_role`/Access Token、模型 API key、
  VPS SSH 私钥或已导出的云端配置文件。
- `FLOAT_SITE_URL` 是公开域名，不是密钥。
- 第三方签名方只需要这个 Xcode 工程本身，不需要（也不应该向他索要）任何
  上述真实密钥；App 内的所有密钥都由最终用户在 Float 网页的设置界面里自己
  填写、保存在自己的浏览器/WKWebView 本地存储和自己的 Supabase 项目里。

## 没有 Mac？用 GitHub 云端编译（推荐，免费）

仓库根目录的 `.github/workflows/ios-shell.yml` 会借 **GitHub 提供的云端苹果
电脑**（`macos-14` 运行器）自动跑 Xcode，编译出一个**真机可用、但未签名**的
`FloatShell.app` / `FloatShell-unsigned.ipa`，跟 `android-shell.yml` 借云端
电脑编译安卓包是同一个思路。开源仓库用这类云端苹果电脑是**免费**的。

用法：

1. 把 `ios-shell/` 和这个 workflow 文件推到 GitHub 上任意分支（分支名要叫
   `ios-shell`，或者手动触发，见下一步）；
2. 仓库页面 → **Actions** → **Build iOS Shell (unsigned)** → **Run workflow**
   手动触发一次（或者直接推送改动到 `ios-shell` 分支，会自动触发）；
3. 跑完后在该次运行的 **Artifacts** 里下载 `FloatShell-unsigned-ipa`
   （或 `FloatShell-unsigned-app`，看你的重签名工具认哪种格式）。

这一步产出的是**完全没有签名**的文件——里面没有任何证书、身份、密钥，纯粹只是
"代码编译成了 App"这一步。拿到这个文件之后，用你已经买好的签名服务（P12
证书 + 描述文件那一套）在自己电脑上重新签名，就能得到能装到 iPhone 上的
最终版本，全程不需要摸到 Mac。

## 构建未签名工程（本地/CI 均可，不需要 Apple 账号）

> 这一节是**模拟器编译烟雾测试**（验证工程本身没写错），产物不能装到真机上。
> 想要能装到真机、能拿去重签名的文件，用上一节的 GitHub 云端编译。

在 macOS 上（Xcode 15+，命令行工具已安装）：

```bash
cd ios-shell
xcodebuild \
  -project FloatShell.xcodeproj \
  -scheme FloatShell \
  -sdk iphonesimulator \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  build
```

这一步只验证工程能编译通过（模拟器架构，不签名），可以在没有 Apple
Developer 账号、没有证书的机器上跑，适合作为 CI 的编译烟雾测试。

## 生成 Archive / 导出 IPA（必须在真正的 macOS + Xcode 环境执行）

> 以下命令**从未在本次任务中被执行过**——当前环境不是 macOS/Xcode，
> 我没有、也不能在这里生成真实的 `.ipa`。下面是第三方签名方在自己的 Mac
> 上应该执行的完整步骤。

1. 打开 `Config.xcconfig`，填好 `DEVELOPMENT_TEAM`（Apple Developer Team ID），
   确认 `PRODUCT_BUNDLE_IDENTIFIER` 未冲突。
2. 用 Xcode 打开 `FloatShell.xcodeproj`：
   - Signing & Capabilities 里确认 Team 已选中、"Automatically manage
     signing" 已勾选（或按自己的企业签/Ad Hoc 流程手动选证书和描述文件）；
   - 通用设置里补上 App 图标（见上文占位项说明）。
3. 命令行生成 Archive：

   ```bash
   cd ios-shell
   xcodebuild \
     -project FloatShell.xcodeproj \
     -scheme FloatShell \
     -configuration Release \
     -archivePath build/FloatShell.xcarchive \
     archive
   ```

4. 复制 `ExportOptions.example.plist` 为 `ExportOptions.plist`，按签名方式
   （`ad-hoc` / `enterprise` / `app-store-connect` / `development`）和自己的
   `teamID` 改好，然后导出 IPA：

   ```bash
   xcodebuild \
     -exportArchive \
     -archivePath build/FloatShell.xcarchive \
     -exportOptionsPlist ExportOptions.plist \
     -exportPath build/export
   ```

   成功后 `build/export/FloatShell.ipa` 就是可分发的签名包。

也可以完全不用命令行，在 Xcode 里 Product → Archive，再在 Organizer 窗口
点 Distribute App，走图形界面完成同样的流程。

## 真机测试清单

- [ ] 首次启动能加载 `https://mianmianfloat.duckdns.org`，无证书错误
- [ ] 关闭/重新打开 App，登录态、API 设置仍在（验证持久化存储）
- [ ] 私聊发送语音消息：麦克风权限弹窗正常，录音/播放正常
- [ ] 语音/视频通话（如启用）：摄像头权限弹窗正常
- [ ] 设置 → 数据管理 → 导出备份：能触发下载并弹出分享面板
- [ ] 设置 → 数据管理 → 导入备份：能通过 Files 选择之前导出的文件
- [ ] 设置 → 云服务部署 → 导出已有云端配置 / 导入已有云端配置：文件选择器正常工作
- [ ] 数据管理 → 云端恢复：点击后有二次确认/提示，完成后提示重启 Float
- [ ] 点击站内跳到第三方域名的链接（如现实桥说明文档外链）：用 Safari 打开，而不是卡在壳里
- [ ] 触发 `shortcuts://`（现实桥导入快捷指令）等自定义协议：能正常拉起系统 App
- [ ] 横竖屏切换、iPad 分屏（如需要支持 iPad）显示正常
- [ ] 深色模式跟随系统切换
- [ ] 生图/图片查看、音频播放、视频播放正常
- [ ] 长按图片能"存储图像"到系统相册
- [ ] 设置里贴自己的 Bark 网址后，杀掉后台，触发一条离线消息，能收到 Bark 通知
- [ ] 点开 Bark 通知：配好 Universal Links 前应跳 Safari，配好之后应直接跳回本 App

## 已知限制

1. **离线推送走 Bark，不是苹果原生 APNs**。Android 壳用"前台服务 +
   Supabase Realtime WebSocket 长连接"绕开 FCM；iOS 系统不允许普通 App
   常驻后台维持自建长连接，这条路径在 iOS 上不成立，网页自己的 Web Push
   在 WKWebView 里也不可用（iOS 只对"添加到主屏幕的 Safari 网页 App"开放
   Web Push）。所以 iOS 这边选了 Bark（第三方开源转发 App，官方已上架
   App Store，有自己现成的、正版的苹果推送权限）作为推送通道：网页设置里
   贴一个 Bark 专属网址，服务器发消息时顺带 POST 给这个网址，Bark 自己转发
   成系统通知——不需要你自己申请 APNs 证书/Push Notifications capability。
   代价是：通知是"Bark"这个 App 弹出来的，不是"Float"，且需要额外装一个
   Bark App。点击通知里的链接默认会用 Safari 打开；要"直接跳回 Float App"
   需要额外配置 Universal Links（见上文"需要开启的权限 / Capabilities"一节），
   这一步要等你拿到真实 Team ID 并重新部署网站后才能生效。
   现实桥的"通知点击运行"和"屏幕速聊"这两个功能**不依赖**这条推送链路，
   它们是通过 iOS 系统通知/辅助触控 + 快捷指令实现的，在 Safari 和本壳里
   都能正常使用，不受影响。
2. **未做 App Store 上架相关的合规资料**（隐私清单 `PrivacyInfo.xcprivacy`、
   截图、App Store 描述等）——如果目标是 Ad Hoc/企业签内测分发，可以忽略；
   如果要上架 App Store，需要额外准备这些材料，且需要评估"内嵌 WebView 加载
   远程网站"是否符合当前 App Store 审核指南（历史上苹果对"套壳网页"的 App
   审核较严格，需要有明显原生功能增量）。
3. **没有签名过任何 `.ipa`**——GitHub 云端编译（见上文）能产出未签名的
   `.app`/`.ipa`，但"签名"这一步涉及你自己的证书身份，只能由你自己或
   第三方签名方在拿到证书/描述文件之后完成，不是本项目能替你做的事。

## 本次改动涉及的文件

全部为**新增**文件，没有修改仓库里任何已有的网页代码或 `android-shell/`：

```
ios-shell/README.md                                                   新增
ios-shell/Config.xcconfig                                              新增
ios-shell/ExportOptions.example.plist                                  新增
ios-shell/FloatShell.xcodeproj/project.pbxproj                         新增
ios-shell/FloatShell.xcodeproj/xcshareddata/xcschemes/FloatShell.xcscheme  新增
ios-shell/FloatShell/AppDelegate.swift                                 新增
ios-shell/FloatShell/SceneDelegate.swift                               新增
ios-shell/FloatShell/ViewController.swift                              新增
ios-shell/FloatShell/Info.plist                                        新增
ios-shell/FloatShell/FloatShell.entitlements                           新增
ios-shell/FloatShell/Assets.xcassets/Contents.json                     新增
ios-shell/FloatShell/Assets.xcassets/AppIcon.appiconset/Contents.json  新增
ios-shell/FloatShell/Assets.xcassets/AppIcon.appiconset/*.png（18 张，从 public/icon-512.png 生成）  新增
ios-shell/FloatShell/Base.lproj/LaunchScreen.storyboard                新增
public/.well-known/apple-app-site-association                         新增（占位 Team ID，配合 Universal Links）
```

> 网页那边为了支持 Bark 推送和"点开跳转回具体聊天"，还改了 `supabase/functions/push-generate/index.ts`、
> `lib/server/push-service.ts`、`app/api/push/bridge-config/route.ts`、
> `components/chat/user-profile-panel.tsx`、`components/desktop-shell.tsx`、
> `docs/push-supabase.sql` / `docs/personal-push-supabase.sql` 等文件——这部分不属于
> iOS 壳工程本身，具体清单以对话里给你的最终汇总为准。
