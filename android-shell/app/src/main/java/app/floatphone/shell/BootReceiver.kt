package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机自启推送服务（部分国产 ROM 需用户在系统设置里允许自启动才会生效）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            runCatching { PushService.start(context) }
        }
    }
}
