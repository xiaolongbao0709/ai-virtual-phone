package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 来电通知上的接听/拒接按钮（heads-up 场景，屏幕亮着没走全屏页）。
 * 接听 → 收场并拉起 MainActivity 深链；拒接 → 只收场。
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_ANSWER = "app.floatphone.shell.CALL_ANSWER"
        const val ACTION_DECLINE = "app.floatphone.shell.CALL_DECLINE"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_CALL_TS = "call_ts"
    }

    override fun onReceive(context: Context, intent: Intent) {
        CallAlert.stop(context)
        if (intent.action != ACTION_ANSWER) return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val callTs = intent.getLongExtra(EXTRA_CALL_TS, 0L).takeIf { it > 0 } ?: System.currentTimeMillis()
        val target = "${MainActivity.SITE_URL}/#incoming-call=${android.net.Uri.encode(sessionId)}&rt=$callTs&answered=1"
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(MainActivity.EXTRA_OPEN_URL, target)
                },
            )
        }
    }
}
