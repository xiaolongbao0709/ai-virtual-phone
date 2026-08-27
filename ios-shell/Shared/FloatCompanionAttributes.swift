import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// 灵动岛"角色陪伴"的数据形状：主 App（FloatShell）和 Widget Extension
/// （FloatShellWidget）都要把这个文件加进各自的编译列表，两边必须看到完全
/// 一致的定义——ActivityKit 靠 Codable 把这份数据从主 App 进程同步到
/// Widget Extension 进程，不需要 App Group 共享容器。
///
/// 整个类型标了 @available(iOS 16.1, *)：主 App 的部署目标是 iOS 15.0，
/// 引用这个类型的地方都必须包在 `if #available(iOS 16.1, *)` 里；
/// Widget Extension 自己的部署目标是 16.1+，编译这个文件不受影响。
@available(iOS 16.1, *)
struct FloatCompanionAttributes: ActivityAttributes {

    /// 长按灵动岛展开时显示的一句状态文字（比如"在睡觉""在等你"），由网页侧
    /// 根据角色已有的"作息"设定算出来，通过 window.NativeLiveActivity.update()
    /// 更新。iOS 只允许 App 在前台/刚退后台不久时手动调用更新，App 被彻底
    /// 杀掉之后这份文字就不会再变了，这是预期内的限制。
    public struct ContentState: Codable, Hashable {
        var statusText: String
    }

    /// 角色名字和头像在一次 Live Activity 生命周期里基本不变，放在
    /// Attributes（而不是 ContentState）里，只在 start() 时设置一次。
    var characterName: String

    /// 头像图片的 base64 编码，建议网页侧先压缩成很小的尺寸（比如 64x64）
    /// 再传进来；传 nil 时灵动岛只显示呼吸光点，不显示头像。
    var avatarBase64: String?
}
#endif
