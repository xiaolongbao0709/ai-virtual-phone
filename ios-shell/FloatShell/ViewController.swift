import UIKit
import WebKit
import AVFoundation
import CoreLocation
import Network
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Float 小手机 iOS 壳：全屏 WKWebView 直接加载线上站点。
/// 与 android-shell/MainActivity.kt 保持同构：站内导航留在壳内，外链/自定义协议交给系统，
/// 网页每次部署即时生效，壳本身只负责原生能力（下载、麦克风/摄像头授权、外链跳转；
/// 文件选择由 iOS 系统自动处理，不需要壳插手）。
final class ViewController: UIViewController {

    static let version = "1.0.0"

    /// 生产站点地址：默认从 Info.plist 的 FLOAT_SITE_URL 读取（由 Config.xcconfig 注入），
    /// 读取失败时兜底到项目约定的域名。不要把它换成 localhost 或裸 IP。
    private static let siteURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "FLOAT_SITE_URL") as? String,
           !raw.isEmpty, !raw.contains("$("), let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://mianmianfloat.duckdns.org")!
    }()

    private var webView: WKWebView!

    // ── "查岗"能力：电量 / 网络 / 位置 / Float 自身使用时长 ──
    private lazy var locationManager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        return manager
    }()
    private var pendingLocationReply: ((Any?, String?) -> Void)?
    private let networkMonitor = NWPathMonitor()
    private var currentNetworkPath: NWPath?
    private var sessionStartTime: Date?

    private static let usageSecondsKey = "float.usageSecondsToday"
    private static let usageDateKey = "float.usageDateStamp"
    private static let dayStampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        return formatter
    }()

    // ── 灵动岛"角色陪伴"：window.NativeLiveActivity.* 桥用到的状态 ──
    // 类型擦成 Any?（而不是直接声明成 iOS 16.1+ 专属的 Activity<FloatCompanionAttributes>?），
    // 避免在部署目标 iOS 15.0 的类里放一个高版本专属类型的 stored property；
    // 用的时候在 @available(iOS 16.1, *) 方法里再 as? 向下转型，更稳妥。
    private var currentLiveActivity: Any?
    // ⚠️ 临时调试专用：摇一摇测试灵动岛时记录摇了几次，验证完毕后跟"摇一摇触发
    // 灵动岛测试"那个 extension 一起删掉。
    private var shakeTestStep = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let config = WKWebViewConfiguration()
        // 必须用持久化 store（默认值），保证 localStorage / IndexedDB / Cookie 跨启动保留，
        // 供登录态、API 设置、云备份配置正常落地。
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // 供网页侧做壳环境特征检测（对应 Android 的 window.AndroidShell），非必需但保留一致性。
        // 同时挂上 window.NativeHaptics，网页可选调用来触发系统震动反馈（发消息、
        // 收到回复、解锁角色卡等场景）；在非本壳环境里这个对象不存在，网页侧需要
        // 自行判断 `window.NativeHaptics?.impact?.()` 再调用，不调用也完全不影响功能。
        // window.NativeDevice.* 都返回 Promise（WKScriptMessageHandlerWithReply 自动把
        // native 回调包成 Promise），网页侧用 await 拿结果、用 try/catch 处理拒绝的情况
        // （比如用户在系统弹窗里拒绝了定位权限）。电量/网络这两个 iOS 不设防、不会弹
        // 权限框——要不要用、要不要给用户一个开关，由网页侧自己决定并控制调用时机。
        let bootstrap = WKUserScript(
            source: """
            window.IOSShell = { platform: 'ios', version: '\(Self.version)' };
            window.NativeHaptics = {
              impact: function(style) { try { window.webkit.messageHandlers.haptics.postMessage({ type: 'impact', style: style || 'medium' }); } catch (e) {} },
              notify: function(kind) { try { window.webkit.messageHandlers.haptics.postMessage({ type: 'notify', style: kind || 'success' }); } catch (e) {} },
              selection: function() { try { window.webkit.messageHandlers.haptics.postMessage({ type: 'selection' }); } catch (e) {} },
            };
            window.NativeDevice = {
              getBatteryInfo: function() { return window.webkit.messageHandlers.device.postMessage({ action: 'battery' }); },
              getNetworkType: function() { return window.webkit.messageHandlers.device.postMessage({ action: 'network' }); },
              getLocation: function() { return window.webkit.messageHandlers.device.postMessage({ action: 'location' }); },
              getUsageToday: function() { return window.webkit.messageHandlers.device.postMessage({ action: 'usage' }); },
            };
            window.NativeLiveActivity = {
              isSupported: function() { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'isSupported' }); },
              isEnabled: function() { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'isEnabled' }); },
              setEnabled: function(value) { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'setEnabled', value: !!value }); },
              start: function(characterName, avatarBase64, statusText) { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'start', characterName: characterName, avatar: avatarBase64, statusText: statusText }); },
              update: function(statusText) { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'update', statusText: statusText }); },
              end: function() { return window.webkit.messageHandlers.liveactivity.postMessage({ action: 'end' }); },
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bootstrap)
        config.userContentController.add(self, name: "haptics")
        config.userContentController.add(self, contentWorld: .page, name: "device")
        config.userContentController.add(self, contentWorld: .page, name: "liveactivity")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        webView.load(URLRequest(url: Self.siteURL))

        networkMonitor.pathUpdateHandler = { [weak self] path in
            self?.currentNetworkPath = path
        }
        networkMonitor.start(queue: .main)

        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification, object: nil
        )
    }

    // ⚠️ 临时调试代码：验证完灵动岛能正常出现之后应该删掉，见文件末尾
    // "摇一摇测试灵动岛" 那个 extension——这里只是让 ViewController 能收到
    // 摇一摇产生的 motionEnded 事件。
    override var canBecomeFirstResponder: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    // ── Float 自身使用时长：不是系统"屏幕使用时间"（那个第三方 App 拿不到，
    // 苹果只给特批的家长监控类 App），这里统计的是"这台设备今天在 Float 前台待了多久"，
    // 按自然日累计，跨天自动清零。 ──
    @objc private func appDidBecomeActive() {
        sessionStartTime = Date()
        ensureDefaultLiveActivityIfNeeded()
    }

    @objc private func appWillResignActive() {
        guard let start = sessionStartTime else { return }
        sessionStartTime = nil
        accumulateUsage(seconds: Date().timeIntervalSince(start))
    }

    private func accumulateUsage(seconds: TimeInterval) {
        guard seconds > 0 else { return }
        let defaults = UserDefaults.standard
        let todayStamp = Self.dayStampFormatter.string(from: Date())
        if defaults.string(forKey: Self.usageDateKey) != todayStamp {
            defaults.set(todayStamp, forKey: Self.usageDateKey)
            defaults.set(0.0, forKey: Self.usageSecondsKey)
        }
        let total = defaults.double(forKey: Self.usageSecondsKey) + seconds
        defaults.set(total, forKey: Self.usageSecondsKey)
    }

    private func usageSecondsToday() -> Int {
        let defaults = UserDefaults.standard
        let todayStamp = Self.dayStampFormatter.string(from: Date())
        let stored = defaults.string(forKey: Self.usageDateKey) == todayStamp
            ? defaults.double(forKey: Self.usageSecondsKey)
            : 0
        let liveSession = sessionStartTime.map { Date().timeIntervalSince($0) } ?? 0
        return Int(stored + liveSession)
    }

    /// Universal Link 入口（点开推送里的生产站点链接直接跳回 App）：
    /// 只认与 FLOAT_SITE_URL 同域名的链接，避免被恶意 Universal Link 劫持跳到别的地址。
    func openIfSameSite(_ url: URL) {
        guard url.host == Self.siteURL.host else { return }
        webView.load(URLRequest(url: url))
    }
}

// MARK: - 导航：站内留壳内，外链/自定义协议交给系统（对应 Android shouldOverrideUrlLoading）
extension ViewController: WKNavigationDelegate {

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // 网页侧用 <a download> 点击 blob:/data: URL 触发的"导出备份""导出云端配置"这类下载
        // （云备份导出、聊天记录导出等都走这条路）：必须走 WKDownload，不能落进下面的
        // scheme 判断——blob: 既不是 http(s) 也不是系统能识别的外部协议，误判成外链交给
        // UIApplication.open 会直接导出失败，用户点了导出按钮但什么都不会发生。
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }

        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }

        if scheme == "http" || scheme == "https" {
            if url.host == Self.siteURL.host {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
            return
        }

        // 自定义协议（shortcuts://、weixin://、mailto: 等现实桥 / 微信接入用到的跳转）交给系统处理
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    // 生产站需使用受信任证书的 HTTPS；默认 ATS 校验即可，不做任何证书豁免。

    // 服务端标记 Content-Disposition: attachment（备份导出等）的响应转成系统下载，
    // 其余（网页本身、图片/音频/视频内联播放）照常显示在 WebView 里。
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let isAttachment = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?
            .lowercased()
            .contains("attachment") ?? false

        if isAttachment || !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // 加载失败时至少弹个提示——WKWebView 跟 Safari 不一样，默认失败了界面什么反应
    // 都没有（不像 Safari 会显示"无法打开该页面"），不加这个的话任何加载失败
    // 在用户看来都是"一直白屏"，完全没法排查是哪里出的问题。
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    private func showLoadError(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        let alert = UIAlertController(
            title: "加载失败",
            message: nsError.localizedDescription,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "重试", style: .default) { [weak self] _ in
            guard let self else { return }
            self.webView.load(URLRequest(url: Self.siteURL))
        })
        present(alert, animated: true)
    }
}

// MARK: - 下载：Content-Disposition 附件走系统分享面板，落地由用户选择保存位置
extension ViewController: WKDownloadDelegate {

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: tmpURL)
        completionHandler(tmpURL)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = download.progress.fileURL else { return }
        DispatchQueue.main.async { [weak self] in
            self?.presentShareSheet(for: url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        // 下载失败时静默即可：网页侧通常有自己的错误提示，这里不重复弹窗打扰用户。
    }

    private func presentShareSheet(for url: URL) {
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        }
        present(activity, animated: true)
    }
}

// MARK: - 文件选择 / 麦克风摄像头授权 / 弹窗窗口
extension ViewController: WKUIDelegate {

    // 语音消息录音、语音/视频通话的 getUserMedia 授权：网页请求后转发给系统权限，
    // 首次调用时 iOS 会自动弹出原生麦克风/摄像头授权框（Info.plist 已声明用途说明）。
    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        guard origin.host == Self.siteURL.host else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.grant)
    }

    // <input type="file">：不需要实现任何方法——WKOpenPanelParameters/runOpenPanelWith
    // 是 WebKit 在 macOS 上给 WKUIDelegate 加的方法，iOS 上根本不存在这个 API。
    // iOS 15+ 的 WKWebView 会自己弹出系统原生的文件/照片选择器，全自动，不用壳插手。

    // target="_blank" / window.open：站内继续用同一个 WebView 打开，不额外开窗口
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

// MARK: - 震动反馈：网页侧调用 window.NativeHaptics.* 触发系统触感反馈
extension ViewController: WKScriptMessageHandler {

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "haptics", let body = message.body as? [String: Any] else { return }

        switch body["type"] as? String {
        case "impact":
            let style: UIImpactFeedbackGenerator.FeedbackStyle
            switch body["style"] as? String {
            case "light": style = .light
            case "heavy": style = .heavy
            case "rigid": style = .rigid
            case "soft": style = .soft
            default: style = .medium
            }
            UIImpactFeedbackGenerator(style: style).impactOccurred()

        case "notify":
            let type: UINotificationFeedbackGenerator.FeedbackType
            switch body["style"] as? String {
            case "warning": type = .warning
            case "error": type = .error
            default: type = .success
            }
            UINotificationFeedbackGenerator().notificationOccurred(type)

        case "selection":
            UISelectionFeedbackGenerator().selectionChanged()

        default:
            break
        }
    }
}

// MARK: - "查岗"桥：window.NativeDevice.* 请求/回复（带返回值，走 WKScriptMessageHandlerWithReply）
extension ViewController: WKScriptMessageHandlerWithReply {

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "device" else {
            if message.name == "liveactivity" {
                handleLiveActivityMessage(message.body as? [String: Any], replyHandler: replyHandler)
            } else {
                replyHandler(nil, "unknown message handler")
            }
            return
        }
        let action = (message.body as? [String: Any])?["action"] as? String

        switch action {
        case "battery":
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = UIDevice.current.batteryLevel
            guard level >= 0 else {
                replyHandler(nil, "battery info unavailable")
                return
            }
            let state = UIDevice.current.batteryState
            replyHandler([
                "level": Int((level * 100).rounded()),
                "charging": state == .charging || state == .full,
            ], nil)

        case "network":
            let path = currentNetworkPath
            let type: String
            if path == nil {
                type = "unknown"
            } else if path?.status != .satisfied {
                type = "offline"
            } else if path?.usesInterfaceType(.wifi) == true {
                type = "wifi"
            } else if path?.usesInterfaceType(.cellular) == true {
                type = "cellular"
            } else {
                type = "other"
            }
            replyHandler(["type": type], nil)

        case "location":
            requestLocation(reply: replyHandler)

        case "usage":
            replyHandler(["seconds": usageSecondsToday()], nil)

        default:
            replyHandler(nil, "unknown action")
        }
    }
}

// MARK: - 位置："查岗"里唯一需要系统权限弹窗的一项，用户随时可在系统设置里关掉
extension ViewController: CLLocationManagerDelegate {

    private func requestLocation(reply: @escaping (Any?, String?) -> Void) {
        // 同一时间只服务一个待处理请求，简单可靠；网页侧本身也不会并发调用这个接口。
        pendingLocationReply = reply
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            pendingLocationReply = nil
            reply(nil, "permission_denied")
        default:
            locationManager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if pendingLocationReply != nil { manager.requestLocation() }
        case .denied, .restricted:
            pendingLocationReply?(nil, "permission_denied")
            pendingLocationReply = nil
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, let reply = pendingLocationReply else { return }
        pendingLocationReply = nil
        CLGeocoder().reverseGeocodeLocation(location) { placemarks, _ in
            let place = placemarks?.first
            let name = [place?.locality, place?.subLocality].compactMap { $0 }.joined(separator: " ")
            reply([
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "placemark": name.isEmpty ? (NSNull() as Any) : (name as Any),
            ], nil)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        pendingLocationReply?(nil, error.localizedDescription)
        pendingLocationReply = nil
    }
}

// MARK: - 灵动岛"角色陪伴"：window.NativeLiveActivity.* 桥（ActivityKit 本地 start/update/end）
//
// 只用本地 Activity.request/update/end，不申请 pushType（那需要 ActivityKit Push
// Type 高阶权限 + APNs 服务器基础设施，本项目刻意不引入任何需要付费 Apple
// Developer 高阶权限或服务器推送证书的方案）。这意味着：
//   1. 只有 App 在前台/刚退后台不久时，网页调用 update() 才能真的更新灵动岛；
//      App 被系统或用户彻底杀掉之后就没法再更新了，这是可接受的预期限制。
//   2. iOS 系统本身规定一次 Live Activity 最多存活 8 小时，到点自动收掉，
//      这是苹果的硬限制，不是本工程能绕开的，也不需要在这里做额外处理。
// iOS 16.1 以下设备：所有方法静默返回"不支持"，不崩溃、不报错、UI 侧自然不出现。
extension ViewController {

    private static let liveActivityEnabledKey = "float.liveActivityEnabled"

    /// 用户是否愿意开启这个功能。默认是开启（true），网页侧可以在设置界面里
    /// 调用 `NativeLiveActivity.setEnabled(false)` 关掉——关掉后 start() 直接
    /// no-op，正在跑的会立即 end()。这是"灵动岛要不要用"这件事在壳层面唯一
    /// 的开关来源；要不要在网页设置界面里放一个可见的开关 UI，由网页侧决定，
    /// 本壳只负责"问了就答、关了就真的关"，跟 README 里 NativeDevice 电量/
    /// 网络那两个能力的开放原则一致。
    private var liveActivityEnabled: Bool {
        get {
            let defaults = UserDefaults.standard
            if defaults.object(forKey: Self.liveActivityEnabledKey) == nil { return true }
            return defaults.bool(forKey: Self.liveActivityEnabledKey)
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.liveActivityEnabledKey) }
    }

    func handleLiveActivityMessage(_ body: [String: Any]?, replyHandler: @escaping (Any?, String?) -> Void) {
        guard #available(iOS 16.1, *) else {
            switch body?["action"] as? String {
            case "isSupported":
                replyHandler(["supported": false, "reason": "ios_version"], nil)
            case "isEnabled":
                replyHandler(liveActivityEnabled, nil)
            case "setEnabled":
                liveActivityEnabled = (body?["value"] as? Bool) ?? true
                replyHandler(nil, nil)
            default:
                // start/update/end 在旧系统上全部静默成功地什么都不做，
                // 网页侧不需要为"这台设备是不是 iOS 16.1+"单独写分支处理。
                replyHandler(nil, nil)
            }
            return
        }
        handleLiveActivityMessageAvailable(body, replyHandler: replyHandler)
    }

    @available(iOS 16.1, *)
    private func handleLiveActivityMessageAvailable(_ body: [String: Any]?, replyHandler: @escaping (Any?, String?) -> Void) {
        switch body?["action"] as? String {
        case "isSupported":
            let info = ActivityAuthorizationInfo()
            replyHandler([
                "supported": info.areActivitiesEnabled,
                "reason": info.areActivitiesEnabled ? NSNull() : ("system_disabled" as Any),
            ], nil)

        case "isEnabled":
            replyHandler(liveActivityEnabled, nil)

        case "setEnabled":
            let value = (body?["value"] as? Bool) ?? true
            liveActivityEnabled = value
            if !value {
                endLiveActivity()
            } else {
                // 开关一打开就应该有陪伴感，不用等网页选好角色再调用 start()——
                // 没有具体角色数据时先用壳自己的默认身份兜底，之后网页真的调用
                // start() 传入角色数据会覆盖掉这个默认的（start 里已经会先
                // endLiveActivity() 再开一个新的）。
                startDefaultCompanionIfNeeded()
            }
            replyHandler(nil, nil)

        case "start":
            guard liveActivityEnabled else {
                replyHandler(nil, "disabled_by_user")
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                replyHandler(nil, "system_disabled")
                return
            }
            let characterName = (body?["characterName"] as? String) ?? "Float"
            let avatarBase64 = body?["avatar"] as? String
            let statusText = (body?["statusText"] as? String) ?? ""
            let attributes = FloatCompanionAttributes(characterName: characterName, avatarBase64: avatarBase64)
            let state = FloatCompanionAttributes.ContentState(statusText: statusText)
            do {
                // 开始前先收掉上一个（如果网页忘了 end() 就又调用了 start()），
                // 避免同时挂着两个灵动岛角色陪伴 Activity。
                // 特意用 iOS 16.1 就有的 contentState: 版本 API（而不是 iOS 16.2
                // 才加入的 content: ActivityContent<...> / staleDate 版本），
                // 跟"灵动岛专属 API 只要求 16.1+"这条硬约束保持一致。
                endLiveActivity()
                let activity = try Activity<FloatCompanionAttributes>.request(
                    attributes: attributes,
                    contentState: state,
                    pushType: nil
                )
                currentLiveActivity = activity
                replyHandler(nil, nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }

        case "update":
            guard liveActivityEnabled else {
                replyHandler(nil, "disabled_by_user")
                return
            }
            guard let activity = currentLiveActivity as? Activity<FloatCompanionAttributes> else {
                replyHandler(nil, "not_started")
                return
            }
            let statusText = (body?["statusText"] as? String) ?? ""
            Task {
                await activity.update(using: .init(statusText: statusText))
                replyHandler(nil, nil)
            }

        case "end":
            endLiveActivity()
            replyHandler(nil, nil)

        default:
            replyHandler(nil, "unknown action")
        }
    }

    @available(iOS 16.1, *)
    private func endLiveActivity() {
        guard let activity = currentLiveActivity as? Activity<FloatCompanionAttributes> else { return }
        currentLiveActivity = nil
        Task { await activity.end(dismissalPolicy: .immediate) }
    }

    // 开关开着、但网页还没调用 start() 传入具体角色时的兜底身份。
    // 头像先留空（灵动岛只显示呼吸光点，不显示头像圆圈）——具体默认头像用什么
    // 图，还没最终定下来，等定了再把 avatarBase64 换成真实图片的 base64。
    private static let defaultCompanionCharacterName = "Float"
    private static let defaultCompanionStatusText = "在呢"

    /// 供 `appDidBecomeActive` 这种非 @available 上下文调用的入口：自己做
    /// #available 判断，iOS 16.1 以下直接安静地什么都不做。
    private func ensureDefaultLiveActivityIfNeeded() {
        guard #available(iOS 16.1, *) else { return }
        startDefaultCompanionIfNeeded()
    }

    /// 开关打开、且当前没有任何 Live Activity 在跑时，用壳自己的默认身份兜底
    /// 开一个——不依赖网页有没有选中角色。网页之后调用 start() 传入真实角色
    /// 数据会覆盖掉这个默认的。
    @available(iOS 16.1, *)
    private func startDefaultCompanionIfNeeded() {
        guard liveActivityEnabled, currentLiveActivity == nil,
              ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = FloatCompanionAttributes(characterName: Self.defaultCompanionCharacterName, avatarBase64: nil)
        let state = FloatCompanionAttributes.ContentState(statusText: Self.defaultCompanionStatusText)
        currentLiveActivity = try? Activity<FloatCompanionAttributes>.request(
            attributes: attributes,
            contentState: state,
            pushType: nil
        )
    }
}

// MARK: - ⚠️ 临时调试：摇一摇触发灵动岛测试
//
// 只是为了在没有 Mac/Safari 远程调试的情况下，能在真机上肉眼验证灵动岛能不能
// 正常出现——跟网页、跟真实角色数据完全无关，用的是写死的测试文字。
// 验证完之后应该把这个 extension、上面 viewDidLoad 里的 canBecomeFirstResponder /
// viewDidAppear 这两处一起删掉。
//
// 用法：装好 App 之后，摇一摇手机——第一次摇触发 start()（出现灵动岛测试内容），
// 过几秒再摇一次会 update() 换一句文字，第三次摇 end() 收起，之后循环。
extension ViewController {

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        triggerLiveActivityShakeTest()
    }

    private func triggerLiveActivityShakeTest() {
        guard #available(iOS 16.1, *) else {
            let alert = UIAlertController(
                title: "灵动岛测试",
                message: "这台设备系统版本低于 iOS 16.1，不支持灵动岛/Live Activity。",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "好", style: .default))
            present(alert, animated: true)
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            let alert = UIAlertController(
                title: "灵动岛测试",
                message: "系统里的 Live Activities 开关是关的（设置 → Face ID 与密码 → Live Activities，或设置 → Float → Live Activities），打开之后再摇一摇试试。",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "好", style: .default))
            present(alert, animated: true)
            return
        }

        if currentLiveActivity == nil {
            let attributes = FloatCompanionAttributes(characterName: "Float 测试", avatarBase64: nil)
            let state = FloatCompanionAttributes.ContentState(statusText: "灵动岛测试中，摇一摇切换文字～")
            do {
                let activity = try Activity<FloatCompanionAttributes>.request(
                    attributes: attributes,
                    contentState: state,
                    pushType: nil
                )
                currentLiveActivity = activity
                shakeTestStep = 0
            } catch {
                let alert = UIAlertController(title: "灵动岛测试失败", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "好", style: .default))
                present(alert, animated: true)
            }
            return
        }

        guard let activity = currentLiveActivity as? Activity<FloatCompanionAttributes> else { return }

        shakeTestStep += 1
        let messages = ["在等你摇第三下～", "再摇一下就收起来啦"]
        if shakeTestStep > messages.count {
            endLiveActivity()
            return
        }
        let text = messages[shakeTestStep - 1]
        Task { await activity.update(using: .init(statusText: text)) }
    }
}
