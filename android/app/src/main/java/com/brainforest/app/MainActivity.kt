package com.brainforest.app

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Locale

/**
 * Brainforest — Android shell for the offline web bundle (assets/web/).
 *
 * The web app is UNMODIFIED. It talks to the native shell exactly as it does on
 * iOS: through window.webkit.messageHandlers.{bfStore,bfTTS,bfIAP}. A document-
 * start shim maps those postMessage() calls onto a single @JavascriptInterface,
 * and the persisted store is injected as window.__BF_STORE before any script
 * runs — mirroring the WKUserScript injection in BrainforestApp.swift.
 *
 * The bundle is served over same-origin https via WebViewAssetLoader (the Android
 * equivalent of the iOS bf:// scheme), so engine.js's relative fetch() paths
 * (content/bank_g1.json, content/facts.json) and its /api/ interception both work.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var narrator: Narrator
    private val main = Handler(Looper.getMainLooper())

    private val storeFile: File
        get() = File(filesDir, "brainforest_store.json")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full-bleed, hidden status bar — match iOS statusBarHidden + full-screen.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let { c ->
            c.hide(WindowInsetsCompat.Type.systemBars())
            c.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        webView = WebView(this)
        setContentView(webView)

        narrator = Narrator(this, webView, main)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false // voice narration autoplay
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        // Bridge object exposed to JS. The document-start shim below funnels the
        // three iOS message handlers into post(name, jsonPayload).
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")

        // Build the document-start injection: persisted store first (so engine.js
        // picks it up as window.__BF_STORE), then the messageHandlers shim.
        val injection = buildInjection()

        // Prefer a true document-start script (WKUserScript-equivalent). Fall back
        // to onPageStarted injection if the WebView build lacks the feature.
        var documentStartOk = false
        if (androidx.webkit.WebViewFeature.isFeatureSupported(
                androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
                    webView, injection, setOf("https://appassets.androidplatform.net"))
                documentStartOk = true
            } catch (t: Throwable) {
                Log.w("Brainforest", "addDocumentStartJavaScript failed", t)
            }
        }
        if (!documentStartOk) {
            webView.webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    view.evaluateJavascript(injection, null)
                }
            }
        }

        if (savedInstanceState == null) {
            webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun buildInjection(): String {
        val storeJson = try {
            if (storeFile.exists()) storeFile.readText().takeIf { it.isNotBlank() } else null
        } catch (t: Throwable) { null }

        val storeLine = if (storeJson != null) "window.__BF_STORE = $storeJson;\n" else ""

        // Map window.webkit.messageHandlers.<name>.postMessage(msg) → AndroidBridge.
        // Strings pass through; objects are JSON-stringified (the @JavascriptInterface
        // boundary only carries strings).
        val shim = """
            (function () {
              if (window.__bfAndroidShim) return;
              window.__bfAndroidShim = true;
              function handler(name) {
                return { postMessage: function (msg) {
                  try {
                    AndroidBridge.post(name, (typeof msg === 'string') ? msg : JSON.stringify(msg));
                  } catch (e) {}
                }};
              }
              window.webkit = window.webkit || {};
              window.webkit.messageHandlers = window.webkit.messageHandlers || {};
              window.webkit.messageHandlers.bfStore = handler('bfStore');
              window.webkit.messageHandlers.bfTTS   = handler('bfTTS');
              window.webkit.messageHandlers.bfIAP   = handler('bfIAP');
            })();
        """.trimIndent()

        return storeLine + shim
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        narrator.release()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            WindowInsetsControllerCompat(window, window.decorView)
                .hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    // ---------------------------------------------------------------------
    // JS bridge. @JavascriptInterface methods run on a WebView worker thread;
    // everything that touches the UI, MediaPlayer or WebView is posted to main.
    // ---------------------------------------------------------------------
    private inner class Bridge {
        @JavascriptInterface
        fun post(name: String, payload: String) {
            when (name) {
                "bfStore" -> saveStore(payload)
                "bfTTS" -> main.post { handleTTS(payload) }
                "bfIAP" -> main.post { handleIAP(payload) }
            }
        }
    }

    private fun saveStore(json: String) {
        // iOS writes atomically to Documents/brainforest_store.json.
        try {
            val tmp = File(filesDir, "brainforest_store.json.tmp")
            tmp.writeText(json)
            tmp.renameTo(storeFile)
        } catch (t: Throwable) {
            Log.w("Brainforest", "store save failed", t)
        }
    }

    private fun handleTTS(payload: String) {
        val o = try { JSONObject(payload) } catch (t: Throwable) { return }
        when (o.optString("cmd")) {
            "speak" -> narrator.speak(
                o.optInt("id", 0),
                o.optString("text", ""),
                o.optBoolean("interrupt", false)
            )
            "stop" -> narrator.stopAll(notify = true)
        }
    }

    // bfIAP: Google Play Billing is not wired up in this build. Report a truthful
    // not-purchased / $1.99 state, and make buy() surface a "coming soon" dialog.
    // TODO(billing): integrate com.android.billingclient for the one-time unlock
    // "com.brainforest.app.forever" (StoreKit non-consumable equivalent).
    private fun handleIAP(payload: String) {
        val o = try { JSONObject(payload) } catch (t: Throwable) { return }
        when (o.optString("cmd")) {
            "status" -> replyIAP(JSONObject().apply {
                put("cmd", "status"); put("owned", false); put("price", "\$1.99")
            })
            "restore" -> replyIAP(JSONObject().apply {
                put("cmd", "restore"); put("ok", true); put("owned", false)
            })
            "buy" -> {
                AlertDialog.Builder(this)
                    .setTitle("Purchases coming soon")
                    .setMessage("In-app purchases aren't available in this build yet. Nothing was charged.")
                    .setPositiveButton("OK") { d, _ -> d.dismiss() }
                    .setOnDismissListener {
                        replyIAP(JSONObject().apply {
                            put("cmd", "buy"); put("ok", false); put("error", "cancelled")
                        })
                    }
                    .show()
            }
        }
    }

    private fun replyIAP(result: JSONObject) {
        val js = "window.__bfIAP && window.__bfIAP.result($result)"
        main.post { webView.evaluateJavascript(js, null) }
    }
}

/**
 * Serial narrator: prerecorded .m4a clips (keyed by MD5 of the spoken line via
 * voice/manifest.json) first, Android TextToSpeech as the fallback for lines not
 * in the pack. Mirrors the iOS Narrator: one queue for both sources so lines
 * never overlap, audio focus ducks other apps, and each finished line notifies
 * window.__bfTTS.done(id).
 */
class Narrator(
    private val context: Context,
    private val webView: WebView,
    private val main: Handler
) {
    private val manifest: Map<String, String> = loadManifest()
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val queue = ArrayDeque<Pair<Int, String>>()
    private var currentId: Int? = null
    private var player: MediaPlayer? = null
    private var stopping = false

    private var ttsReady = false
    private lateinit var tts: TextToSpeech

    init {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts.language = Locale.US
                ttsReady = true
            }
        }
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { main.post { finishCurrent() } }
            @Deprecated("deprecated") override fun onError(utteranceId: String?) { main.post { finishCurrent() } }
            override fun onError(utteranceId: String?, errorCode: Int) { main.post { finishCurrent() } }
        })
    }

    private val focusAttrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private var focusRequest: android.media.AudioFocusRequest? = null

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = android.media.AudioFocusRequest.Builder(
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(focusAttrs)
                    .build()
            }
            focusRequest?.let { audioManager.requestAudioFocus(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(null,
                AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        }
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION") audioManager.abandonAudioFocus(null)
        }
    }

    fun speak(id: Int, text: String, interrupt: Boolean) {
        if (interrupt) stopAll(notify = true)
        queue.addLast(id to text)
        pump()
    }

    private fun pump() {
        if (currentId != null || queue.isEmpty()) return
        val (id, text) = queue.removeFirst()
        currentId = id
        requestFocus()

        val file = recordedFile(text)
        if (file != null && playRecorded(file)) return

        // Fallback: synthesizer. Emoji are decoration for the SCREEN, never for the
        // ear — TextToSpeech reads them aloud by name, so "🥁 Drumroll yes!" comes out
        // as "drum, drumroll yes". Recorded clips are already emoji-free; this guards
        // every line that isn't in the pack.
        val spoken = speakable(text)
        if (spoken.isEmpty()) { finishCurrent(); return }
        if (ttsReady) {
            val res = tts.speak(spoken, TextToSpeech.QUEUE_FLUSH, null, id.toString())
            if (res != TextToSpeech.SUCCESS) finishCurrent()
        } else {
            finishCurrent()
        }
    }

    private fun playRecorded(assetName: String): Boolean {
        return try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(focusAttrs)
            context.assets.openFd("web/voice/$assetName").use { afd ->
                mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            }
            mp.setOnCompletionListener { main.post { finishCurrent() } }
            mp.setOnErrorListener { _, _, _ -> main.post { finishCurrent() }; true }
            mp.prepare()
            player = mp
            mp.start()
            true
        } catch (t: Throwable) {
            Log.w("Brainforest", "recorded playback failed: $assetName", t)
            false
        }
    }

    private fun finishCurrent() {
        if (stopping) return
        val id = currentId
        currentId = null
        player?.let { try { it.release() } catch (_: Throwable) {} }
        player = null
        if (id != null) done(id)
        if (queue.isEmpty()) abandonFocus()
        pump()
    }

    fun stopAll(notify: Boolean) {
        stopping = true
        val pending = queue.map { it.first }
        queue.clear()
        try { if (ttsReady) tts.stop() } catch (_: Throwable) {}
        player?.let { try { it.stop() } catch (_: Throwable) {}; try { it.release() } catch (_: Throwable) {} }
        player = null
        val cur = currentId
        currentId = null
        stopping = false
        abandonFocus()
        if (notify) {
            cur?.let { done(it) }
            pending.forEach { done(it) }
        }
    }

    private fun done(id: Int) {
        val js = "window.__bfTTS && window.__bfTTS.done($id)"
        webView.evaluateJavascript(js, null)
    }

    fun release() {
        try { tts.shutdown() } catch (_: Throwable) {}
        player?.let { try { it.release() } catch (_: Throwable) {} }
        abandonFocus()
    }

    // MD5(normalize(text)) → filename, matching iOS Narrator.recordedURL.
    /** Drop emoji (and their variation selectors / ZWJ glue) so the synthesizer
     *  never speaks one by name. Mirrors Swift Narrator.speakable(). */
    private fun speakable(text: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val n = Character.charCount(cp)
            val keep = when {
                cp == 0xFE0F || cp == 0xFE0E || cp == 0x200D -> false
                cp in 0x1F000..0x1FAFF -> false
                cp in 0x2600..0x27BF -> false
                cp in 0x2B00..0x2BFF -> false
                cp in 0x1F1E6..0x1F1FF -> false
                else -> true
            }
            if (keep) sb.appendCodePoint(cp)
            i += n
        }
        return sb.toString().trim().replace(Regex("\\s+"), " ")
    }

    private fun recordedFile(text: String): String? {
        val norm = text.trim().replace(Regex("\\s+"), " ").lowercase(Locale.ROOT)
        val md5 = MessageDigest.getInstance("MD5")
            .digest(norm.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return manifest[md5]
    }

    private fun loadManifest(): Map<String, String> {
        return try {
            val raw = context.assets.open("web/voice/manifest.json")
                .bufferedReader(Charsets.UTF_8).use { it.readText() }
            val obj = JSONObject(raw)
            val map = HashMap<String, String>(obj.length())
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                map[k] = obj.getString(k)
            }
            map
        } catch (t: Throwable) {
            Log.w("Brainforest", "voice manifest load failed", t)
            emptyMap()
        }
    }
}
