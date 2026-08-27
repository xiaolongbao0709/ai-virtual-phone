import ActivityKit
import WidgetKit
import SwiftUI

/// 灵动岛"角色陪伴"的展示层：
/// - 收起态（灵动岛 compact / minimal）：只有一个有呼吸感的小光点，不追求
///   信息量，只营造"角色在、有生命感"的氛围。
/// - 长按展开态（灵动岛 expanded）：显示角色头像 + 当前"在干嘛"的一句状态
///   文字，文字由网页侧算好后通过 window.NativeLiveActivity.update() 传过来。
///
/// 这里完全没有网络请求、没有自己的定时器——所有内容更新只能来自主 App
/// 手动调用 update()（见 FloatShell/ViewController.swift 里的
/// NativeLiveActivity 桥），iOS 系统本身规定一次 Live Activity 最多存活 8
/// 小时、到点自动收掉，这是苹果的硬限制，本工程没有、也没办法绕开。
struct FloatCompanionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FloatCompanionAttributes.self) { context in
            LockScreenBanner(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AvatarView(base64: context.attributes.avatarBase64)
                        .frame(width: 32, height: 32)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    BreathingDot()
                        .frame(width: 10, height: 10)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.characterName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(context.state.statusText)
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                }
            } compactLeading: {
                AvatarView(base64: context.attributes.avatarBase64)
                    .frame(width: 20, height: 20)
            } compactTrailing: {
                BreathingDot()
                    .frame(width: 8, height: 8)
            } minimal: {
                BreathingDot()
                    .frame(width: 8, height: 8)
            }
        }
    }
}

/// 收起状态的呼吸光点：柔和的粉蓝渐变圆点，持续放大缩小 + 明暗变化。
///
/// 已知不确定点：Live Activity 的 UI 由系统渲染服务定期"快照"驱动，Widget
/// Extension 进程并不会一直常驻后台跑动画；`repeatForever` 这种做法在真机
/// 灵动岛/锁屏上普遍被开发者验证可行，但系统可能在灵动岛不是当前焦点时降低
/// 动画帧率或暂停。没有 Mac/真机条件在本次任务里实际验证观感，这是本次交付
/// 里"设计上有把握、但没有真机验证"的一点，建议拿到签名包后在真机上确认
/// 呼吸动画是否流畅，不流畅的话可以换成 SwiftUI 原生支持"系统驱动动画"的
/// `ProgressView`/`Text(timerInterval:)` 系列组件。
private struct BreathingDot: View {
    @State private var animate = false

    var body: some View {
        Circle()
            .fill(
                LinearGradient(
                    colors: [
                        Color(red: 1.0, green: 0.75, blue: 0.85),
                        Color(red: 0.75, green: 0.85, blue: 1.0),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .scaleEffect(animate ? 1.0 : 0.7)
            .opacity(animate ? 1.0 : 0.55)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                    animate = true
                }
            }
    }
}

/// 头像：网页传了角色头像就显示角色头像；没传（默认陪伴、或角色本身没设置
/// 头像）就显示壳自带的像素小兔子占位形象（Assets.xcassets 里的
/// DefaultCompanionAvatar，透明背景，去掉了生成时带的粉色底），并叠加一对
/// 会眨眼的像素眼睛——真实头像不叠眼睛，眨眼是兔子占位形象专属的细节。
private struct AvatarView: View {
    let base64: String?

    var body: some View {
        Group {
            if let base64, let data = Data(base64Encoded: base64), let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .clipShape(Circle())
            } else {
                DefaultBunnyAvatar()
            }
        }
    }
}

private struct DefaultBunnyAvatar: View {
    var body: some View {
        Image("DefaultCompanionAvatar")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .overlay(BlinkingEyesOverlay())
    }
}

/// 兔子脸上的两只眼睛：位置按兔子素材图的相对比例摆放（左眼水平 39%、右眼
/// 56%，垂直 57%，眼睛本身宽高各占 7%），跟 y 轴缩放做"眨眼"——图片素材
/// 本身是没有眼睛的空白脸，眼睛完全是代码画的两个小方块，这样才能单独
/// 动它们而不用做多帧图片切换（多帧切图在 Live Activity 里不可靠，见
/// BreathingDot 的注释）。眨眼节奏用跟呼吸光点一样的
/// `repeatForever(autoreverses:)` 连续动画，不是"偶尔眨一下、大部分时间
/// 睁眼"的自然节奏——那种需要一个持续跑的计时器来触发，Live Activity 的
/// Widget Extension 进程不保证一直存活，计时器不可靠，所以退而求其次用
/// 连续匀速的眨眼动画，这是跟连续呼吸动画同一套原理的取舍。
private struct BlinkingEyesOverlay: View {
    @State private var eyeScale: CGFloat = 1.0

    var body: some View {
        GeometryReader { geo in
            let eyeSize = geo.size.width * 0.07
            ZStack {
                eye(size: eyeSize)
                    .position(x: geo.size.width * 0.39, y: geo.size.height * 0.57)
                eye(size: eyeSize)
                    .position(x: geo.size.width * 0.56, y: geo.size.height * 0.57)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                eyeScale = 0.12
            }
        }
    }

    private func eye(size: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color(red: 0.16, green: 0.14, blue: 0.13))
            .frame(width: size, height: size)
            .scaleEffect(y: eyeScale)
    }
}

private struct LockScreenBanner: View {
    let context: ActivityViewContext<FloatCompanionAttributes>

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(base64: context.attributes.avatarBase64)
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(context.attributes.characterName)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(context.state.statusText)
                    .font(.body)
                    .fontWeight(.medium)
                    .lineLimit(2)
            }
            Spacer()
            BreathingDot()
                .frame(width: 12, height: 12)
        }
        .padding()
        .activityBackgroundTint(Color.black.opacity(0.6))
        .activitySystemActionForegroundColor(Color.white)
    }
}
