package app.floatphone.shell

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 锁屏全屏来电页（full-screen intent 的落地页）：
 * 纯代码构建 UI（省掉布局资源），角色名 + "语音来电…" + 拒接/接听。
 * 接听 → 收掉振动通知，拉起 MainActivity 带 #incoming-call 深链进通话；
 * 拒接/返回 → 只收场，正文消息照常躺在聊天里。
 */
class IncomingCallActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_CHARACTER_NAME = "character_name"
        const val EXTRA_CALL_TS = "call_ts"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }

        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val characterName = intent.getStringExtra(EXTRA_CHARACTER_NAME).orEmpty().ifEmpty { "对方" }
        val callTs = intent.getLongExtra(EXTRA_CALL_TS, 0L)

        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#161A22"))
            setPadding(dp(32), dp(96), dp(32), dp(56))
        }

        root.addView(TextView(this).apply {
            text = characterName
            textSize = 34f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = "语音来电…"
            textSize = 15f
            setTextColor(Color.parseColor("#9AA3B2"))
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        })

        // 撑开中部，把按钮压到底部
        root.addView(TextView(this), LinearLayout.LayoutParams(0, 0, 1f).apply {
            width = LinearLayout.LayoutParams.MATCH_PARENT
        })

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        fun roundButton(label: String, color: Int, onClick: () -> Unit): Button =
            Button(this).apply {
                text = label
                textSize = 15f
                setTextColor(Color.WHITE)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                }
                layoutParams = LinearLayout.LayoutParams(dp(78), dp(78)).apply {
                    marginStart = dp(34)
                    marginEnd = dp(34)
                }
                setOnClickListener { onClick() }
            }
        buttons.addView(roundButton("拒接", Color.parseColor("#E5484D")) { finishCall() })
        buttons.addView(roundButton("接听", Color.parseColor("#30A46C")) { answer(sessionId, callTs) })
        root.addView(buttons)

        setContentView(root)
    }

    private fun answer(sessionId: String, callTs: Long) {
        CallAlert.stop(this)
        val ts = if (callTs > 0) callTs else System.currentTimeMillis()
        val target = "${MainActivity.SITE_URL}/#incoming-call=${android.net.Uri.encode(sessionId)}&rt=$ts&answered=1"
        val launch = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(MainActivity.EXTRA_OPEN_URL, target)
        }
        // 锁屏接听：请求解锁后再进主界面（用户取消解锁则停在锁屏，通话不开始）
        if (Build.VERSION.SDK_INT >= 26) {
            val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            if (keyguard.isKeyguardLocked) {
                keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() {
                        runCatching { startActivity(launch) }
                        finish()
                    }

                    override fun onDismissCancelled() {
                        finish()
                    }
                })
                return
            }
        }
        runCatching { startActivity(launch) }
        finish()
    }

    private fun finishCall() {
        CallAlert.stop(this)
        finish()
    }
}
