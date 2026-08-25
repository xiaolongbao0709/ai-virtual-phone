package app.floatphone.shell

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 来电提示的共享状态：振动循环 + 超时未接。
 * 全程不出声（App 的约定是只振动），振动尊重系统响铃模式由系统 Vibrator 自行处理。
 * 任何一方（接听/拒接/超时/新来电顶替）调用 stop 即全部收场。
 */
object CallAlert {
    const val NOTIF_CALL_ID = 60
    const val NOTIF_MISSED_ID = 61
    const val TIMEOUT_MS = 55_000L

    private var vibrator: Vibrator? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    /** 当前振铃中的会话（IncomingCallActivity 读取；空表示没有活动来电） */
    @Volatile var activeSessionId: String = ""
    @Volatile var activeCharacterName: String = ""

    private fun systemVibrator(context: Context): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    /** 开始来电：循环振动 + 挂超时。已有来电时先收掉旧的。 */
    fun start(context: Context, sessionId: String, characterName: String, onTimeout: () -> Unit) {
        stop(context, cancelNotification = false)
        activeSessionId = sessionId
        activeCharacterName = characterName
        val pattern = longArrayOf(0, 500, 250, 500, 1400)
        vibrator = systemVibrator(context)?.also { v ->
            runCatching {
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 1))
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(pattern, 1)
                }
            }
        }
        val runnable = Runnable {
            timeoutRunnable = null
            runCatching { onTimeout() }
        }
        timeoutRunnable = runnable
        handler.postDelayed(runnable, TIMEOUT_MS)
    }

    /** 收场：停振动、撤超时，可选把来电通知一并撤下。 */
    fun stop(context: Context, cancelNotification: Boolean = true) {
        activeSessionId = ""
        activeCharacterName = ""
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        runCatching { vibrator?.cancel() }
        vibrator = null
        if (cancelNotification) {
            runCatching {
                context.getSystemService(NotificationManager::class.java).cancel(NOTIF_CALL_ID)
            }
        }
    }
}
