import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let viewController = ViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = viewController
        window.makeKeyAndVisible()
        self.window = window

        // 冷启动：App 没在跑，用户直接点开了一个 Universal Link（比如 Bark 推送里的链接）
        if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }),
           let url = activity.webpageURL {
            viewController.openIfSameSite(url)
        }
    }

    // 热启动/后台恢复：App 已经在跑，系统把 Universal Link 直接送过来
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL,
              let viewController = window?.rootViewController as? ViewController else { return }
        viewController.openIfSameSite(url)
    }
}
