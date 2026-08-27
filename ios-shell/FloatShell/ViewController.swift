import UIKit
import WebKit
import AVFoundation
import UniformTypeIdentifiers

/// Float 小手机 iOS 壳：全屏 WKWebView 直接加载线上站点。
/// 与 android-shell/MainActivity.kt 保持同构：站内导航留在壳内，外链/自定义协议交给系统，
/// 网页每次部署即时生效，壳本身只负责原生能力（文件选择、下载、麦克风/摄像头授权、外链跳转）。
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
    private var openPanelCompletion: (([URL]?) -> Void)?

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
        let bootstrap = WKUserScript(
            source: "window.IOSShell = { platform: 'ios', version: '\(Self.version)' };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bootstrap)

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

    // <input type="file">：交给系统文件 App（含「浏览」里的照片/iCloud Drive/第三方网盘）
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        openPanelCompletion?(nil)
        openPanelCompletion = completionHandler

        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = parameters.allowsMultipleSelection
        picker.delegate = self
        present(picker, animated: true)
    }

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

extension ViewController: UIDocumentPickerDelegate {

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        openPanelCompletion?(urls)
        openPanelCompletion = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        openPanelCompletion?(nil)
        openPanelCompletion = nil
    }
}
