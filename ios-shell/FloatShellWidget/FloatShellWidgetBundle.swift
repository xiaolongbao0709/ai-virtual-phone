import WidgetKit
import SwiftUI

/// Widget Extension 的入口。这个 Target 的部署目标单独设成 iOS 16.1+
/// （见 project.pbxproj 里 FloatShellWidgetExtension 的 IPHONEOS_DEPLOYMENT_TARGET），
/// 所以这个文件本身不需要任何 @available 包裹——能跑到这个进程里，
/// 系统就已经保证是 iOS 16.1+ 了。
@main
struct FloatShellWidgetBundle: WidgetBundle {
    var body: some Widget {
        FloatCompanionLiveActivity()
    }
}
