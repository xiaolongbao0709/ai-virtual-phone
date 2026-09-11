package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 推送前台服务：不依赖 Google 服务的自建长连接。
 *
 * 原理：用 WebView 里已登录的站点 Cookie 调用站点接口拿到
 * Supabase 地址 / anon key / 当前用户 id，然后用 OkHttp WebSocket
 * 直连 Supabase Realtime，订阅个人频道 shellpush:<userId>。
 * 服务端（push-generate / 测试按钮）发离线消息时会向该频道广播一份，
 * 本服务收到即弹系统通知——App 被杀也能收（前台服务存活期间）。
 */
class PushService : Service() {

    companion object {
        private const val CH_KEEPALIVE = "shell_keepalive"
        private const val CH_MESSAGES = "shell_messages"
        private const val CH_CALLS = "shell_calls"
        private const val NOTIF_FG_ID = 1
        private var running = false

        fun start(context: Context) {
            if (running) return
            val intent = Intent(context, PushService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private var stopped = false
    private var msgSeq = 2
    private var notifId = 100
    private var shellSubRegistered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannels()
        startForeground(NOTIF_FG_ID, buildKeepAliveNotification("等待连接…"))
        thread(name = "shell-push-loop") { connectionLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        socket?.cancel()
        super.onDestroy()
    }

    // ── 连接循环：拿配置 → 连 WS → 断线退避重连 ──
    private fun connectionLoop() {
        var backoffSec = 5L
        while (!stopped) {
            val config = fetchConfig()
            if (config == null) {
                updateKeepAlive("未登录或站点不可达，稍后重试")
                sleepSec(60); continue
            }
            updateKeepAlive("已连接，等待角色消息")
            val closedNormally = runSocket(config)
            if (stopped) break
            updateKeepAlive("连接断开，重连中…")
            sleepSec(if (closedNormally) 3 else backoffSec)
            backoffSec = (backoffSec * 2).coerceAtMost(120)
            if (closedNormally) backoffSec = 5
        }
    }

    private data class PushConfig(val supabaseUrl: String, val anonKey: String, val userId: String)

    /** 借 WebView 的登录 Cookie 调站点接口获取连接参数。 */
    private fun fetchConfig(): PushConfig? = runCatching {
        val cookie = CookieManager.getInstance().getCookie(MainActivity.SITE_URL) ?: return null

        fun getJson(path: String): JSONObject? {
            val request = Request.Builder()
                .url("${MainActivity.SITE_URL}$path")
                .header("Cookie", cookie)
                .header("Accept", "application/json")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                return JSONObject(response.body?.string() ?: return null)
            }
        }

        val me = getJson("/api/auth/me") ?: return null
        val userId = me.optJSONObject("account")?.optString("id").orEmpty()
        if (userId.isEmpty()) return null
        val online = getJson("/api/online/config") ?: return null
        if (!online.optBoolean("configured")) return null
        val url = online.optString("supabaseUrl")
        val key = online.optString("anonKey")
        if (url.isEmpty() || key.isEmpty()) return null
        registerShellSubscription(cookie, userId)
        PushConfig(url.trimEnd('/'), key, userId)
    }.getOrNull()

    /**
     * 在站点注册一条合成推送订阅（endpoint = shell:<userId>）。
     * 作用是让离线消息排期的"账号已订阅"门控放行，并让服务端知道
     * 要往 shellpush 频道广播；服务端不会对它做 Web Push 投递。
     */
    private fun registerShellSubscription(cookie: String, userId: String) {
        if (shellSubRegistered) return
        runCatching {
            val body = JSONObject()
                .put("endpoint", "shell:$userId")
                .put(
                    "keys",
                    JSONObject().put("p256dh", "shell").put("auth", "shell"),
                )
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${MainActivity.SITE_URL}/api/push/subscribe")
                .header("Cookie", cookie)
                .post(body)
                .build()
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) shellSubRegistered = true
            }
        }
    }

    /** 跑一条 WebSocket 直到断开；返回是否属于正常关闭。 */
    private fun runSocket(config: PushConfig): Boolean {
        val wsUrl = config.supabaseUrl.replaceFirst("http", "ws") +
            "/realtime/v1/websocket?apikey=${config.anonKey}&vsn=1.0.0"
        val topic = "realtime:shellpush:${config.userId}"
        val lock = Object()
        var normal = false
        var done = false

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val join = JSONObject()
                    .put("topic", topic)
                    .put("event", "phx_join")
                    .put("ref", "1")
                    .put(
                        "payload",
                        JSONObject().put(
                            "config",
                            JSONObject()
                                .put("broadcast", JSONObject().put("self", false))
                                .put("presence", JSONObject().put("key", "")),
                        ),
                    )
                webSocket.send(join.toString())
                // Phoenix 心跳（OkHttp pingInterval 是 TCP 层，这里是协议层）
                thread(name = "shell-push-heartbeat") {
                    while (!done && !stopped) {
                        sleepSec(25)
                        if (done || stopped) break
                        runCatching {
                            webSocket.send(
                                JSONObject()
                                    .put("topic", "phoenix")
                                    .put("event", "heartbeat")
                                    .put("payload", JSONObject())
                                    .put("ref", (msgSeq++).toString())
                                    .toString(),
                            )
                        }
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val msg = JSONObject(text)
                    if (msg.optString("event") != "broadcast") return
                    val payload = msg.optJSONObject("payload") ?: return
                    if (payload.optString("event") != "notify") return
                    val body = payload.optJSONObject("payload") ?: return
                    val title = body.optString("title").ifEmpty { "小手机" }
                    val text2 = body.optString("body").ifEmpty { "有新消息" }
                    // 来电：全屏来电通知（任何一步失败回落普通通知，主路不受影响）
                    if (body.optString("kind") == "call") {
                        val shown = runCatching {
                            showIncomingCallNotification(
                                body.optString("characterName").ifEmpty { title },
                                body.optString("sessionId"),
                                body.optLong("callTs", System.currentTimeMillis()),
                            )
                        }.isSuccess
                        if (shown) return
                    }
                    showMessageNotification(title, text2)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                normal = true
                synchronized(lock) { done = true; lock.notifyAll() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                synchronized(lock) { done = true; lock.notifyAll() }
            }
        }

        socket = client.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            listener,
        )
        synchronized(lock) {
            while (!done && !stopped) runCatching { lock.wait(30_000) }
        }
        socket?.cancel()
        socket = null
        return normal
    }

    // ── 通知 ──
    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CH_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "维持角色消息接收通道（可在此关闭常驻通知的显示）"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色发来的离线消息"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_CALLS, "角色来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色打来的语音电话（只振动，不响铃）"
                setSound(null, null)
                enableVibration(false) // 振动由 CallAlert 循环控制，渠道自带的一次性振动关掉
            },
        )
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildKeepAliveNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    private fun updateKeepAlive(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_FG_ID, buildKeepAliveNotification(text))
    }

    /**
     * 全屏来电通知：锁屏/熄屏直接弹 IncomingCallActivity，亮屏时是带
     * 接听/拒接按钮的 heads-up。振动循环 + 55s 超时未接由 CallAlert 管。
     */
    private fun showIncomingCallNotification(characterName: String, sessionId: String, callTs: Long) {
        val fullScreen = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(IncomingCallActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(IncomingCallActivity.EXTRA_CHARACTER_NAME, characterName)
            putExtra(IncomingCallActivity.EXTRA_CALL_TS, callTs)
        }
        val fullScreenPending = PendingIntent.getActivity(
            this, 60, fullScreen,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun buildAction(actionName: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            this, code,
            Intent(this, CallActionReceiver::class.java).apply {
                action = actionName
                putExtra(CallActionReceiver.EXTRA_SESSION_ID, sessionId)
                putExtra(CallActionReceiver.EXTRA_CALL_TS, callTs)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("语音来电…")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(fullScreenPending)
            .addAction(0, "拒接", buildAction(CallActionReceiver.ACTION_DECLINE, 61))
            .addAction(0, "接听", buildAction(CallActionReceiver.ACTION_ANSWER, 62))
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_CALL_ID, notification)
        CallAlert.start(this, sessionId, characterName) {
            // 超时未接：收场 + 换一条"未接来电"普通通知（正文消息本来就会进聊天）
            CallAlert.stop(this)
            runCatching { showMissedCallNotification(characterName) }
        }
    }

    private fun showMissedCallNotification(characterName: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("未接来电")
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_MISSED_ID, notification)
    }

    private fun showMessageNotification(title: String, body: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(notifId++, notification)
        if (notifId > 400) notifId = 100
    }

    private fun sleepSec(sec: Long) {
        runCatching { Thread.sleep(sec * 1000) }
    }
}
