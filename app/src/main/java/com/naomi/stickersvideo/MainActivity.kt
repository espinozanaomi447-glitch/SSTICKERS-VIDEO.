package com.naomi.stickersvideo

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var transformer: Transformer? = null
    @Volatile private var lastVideo: File? = null

    private val pickVideo = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback
        fileCallback = null
        cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
    }

    private val addPack = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_CANCELED) {
            val err = res.data?.getStringExtra("validation_error")
            if (err != null) notifyWhatsApp("error", err) else notifyWhatsApp("cancel", "")
        } else {
            notifyWhatsApp("ok", "")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web = WebView(this)
        setContentView(web)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/stickers/", WebViewAssetLoader.InternalStoragePathHandler(this, StickerStore.rootDir(this)))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }
        web.setBackgroundColor(0xFFFFF7EC.toInt())

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "video/*"
                }
                return try {
                    pickVideo.launch(Intent.createChooser(intent, "Elige un video"))
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    filePathCallback?.onReceiveValue(null)
                    false
                }
            }
        }

        web.addJavascriptInterface(Bridge(), "Android")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.appBack && window.appBack()) ? 'y' : 'n'") { r ->
                    if (r != "\"y\"") finish()
                }
            }
        })

        if (savedInstanceState == null) {
            web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private fun notifyWhatsApp(code: String, msg: String) {
        web.post {
            web.evaluateJavascript(
                "window.onWhatsAppResult && window.onWhatsAppResult(${JSONObject.quote(code)}, ${JSONObject.quote(msg)})",
                null
            )
        }
    }

    private fun isInstalled(pkg: String): Boolean = try {
        packageManager.getPackageInfo(pkg, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun launchAddToWhatsApp(id: String, name: String) {
        val consumer = isInstalled("com.whatsapp")
        val business = isInstalled("com.whatsapp.w4b")
        if (!consumer && !business) {
            notifyWhatsApp("notinstalled", "No encontré WhatsApp en este teléfono.")
            return
        }
        val intent = Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK").apply {
            putExtra("sticker_pack_id", id)
            putExtra("sticker_pack_authority", StickerContentProvider.AUTHORITY)
            putExtra("sticker_pack_name", name)
            if (consumer && !business) setPackage("com.whatsapp")
            if (business && !consumer) setPackage("com.whatsapp.w4b")
        }
        try {
            addPack.launch(intent)
        } catch (e: ActivityNotFoundException) {
            notifyWhatsApp("error", "Tu versión de WhatsApp no permite agregar paquetes. Actualízala desde la Play Store.")
        }
    }

    // ------------------------------------------------------------------
    // Video con sonido
    // ------------------------------------------------------------------

    private fun notifyVideo(result: String) {
        web.post {
            web.evaluateJavascript("window.onVideoSaved && window.onVideoSaved($result)", null)
        }
    }

    /** Convierte lo grabado a un MP4 normal (H.264 + AAC) que WhatsApp y la galería entienden. */
    @OptIn(UnstableApi::class)
    private fun exportVideo(input: File, out: File) {
        val listener = object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                transformer = null
                Thread { finishVideo(input, out) }.start()
            }

            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                transformer = null
                Thread {
                    // Si ya era MP4, se usa tal cual
                    if (input.extension == "mp4") {
                        try {
                            input.copyTo(out, overwrite = true)
                            finishVideo(input, out)
                        } catch (e: Exception) {
                            notifyVideo(fail(e))
                        }
                    } else {
                        notifyVideo(fail(Exception("No se pudo convertir el video (${exportException.errorCodeName}).")))
                    }
                }.start()
            }
        }
        try {
            val t = Transformer.Builder(this)
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .addListener(listener)
                .build()
            transformer = t
            t.start(MediaItem.fromUri(Uri.fromFile(input)), out.absolutePath)
        } catch (e: Exception) {
            transformer = null
            notifyVideo(fail(e))
        }
    }

    /** Guarda una copia en la galería y deja el archivo listo para compartir. */
    private fun finishVideo(input: File, out: File) {
        input.delete()
        lastVideo = out
        val msg = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, out.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/StickersVideo")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                val uri = contentResolver.insert(collection, values)
                    ?: throw IllegalStateException("No se pudo crear el archivo")
                contentResolver.openOutputStream(uri)?.use { os -> out.inputStream().use { it.copyTo(os) } }
                    ?: throw IllegalStateException("No se pudo escribir el archivo")
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
                "Está en tu galería, en Películas/StickersVideo."
            } else {
                val dir = File(getExternalFilesDir(Environment.DIRECTORY_MOVIES), "StickersVideo").apply { mkdirs() }
                out.copyTo(File(dir, out.name), overwrite = true)
                "Guardado en ${dir.absolutePath}"
            }
        } catch (e: Exception) {
            "Está listo para enviar, pero no se pudo copiar a la galería."
        }
        notifyVideo(ok { put("msg", msg) })
    }

    private fun shareLastVideo() {
        val f = lastVideo
        if (f == null || !f.exists()) {
            web.evaluateJavascript("window.onWhatsAppResult && window.onWhatsAppResult('error', 'Primero crea el video.')", null)
            return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "video/mp4"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val consumer = isInstalled("com.whatsapp")
        val business = isInstalled("com.whatsapp.w4b")
        val direct = when {
            consumer && !business -> Intent(send).setPackage("com.whatsapp")
            business && !consumer -> Intent(send).setPackage("com.whatsapp.w4b")
            else -> null
        }
        try {
            startActivity(direct ?: Intent.createChooser(send, "Enviar video"))
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent.createChooser(send, "Enviar video"))
        }
    }

    private fun ok(extra: JSONObject.() -> Unit = {}): String = JSONObject().put("ok", true).apply(extra).toString()
    private fun fail(e: Throwable): String = JSONObject().put("ok", false).put("error", e.message ?: "Error").toString()

    /** Funciones que la interfaz (JavaScript) puede llamar como window.Android.xxx() */
    inner class Bridge {
        private val ctx get() = this@MainActivity

        @JavascriptInterface
        fun listPacks(): String {
            val arr = JSONArray()
            StickerStore.list(ctx).forEach { arr.put(StickerStore.toJson(it)) }
            return arr.toString()
        }

        @JavascriptInterface
        fun createPack(name: String?, publisher: String?): String =
            StickerStore.toJson(StickerStore.create(ctx, name, publisher)).toString()

        @JavascriptInterface
        fun renamePack(id: String?, name: String?, publisher: String?): String = try {
            val p = StickerStore.rename(ctx, id ?: "", name, publisher)
            ok { put("pack", StickerStore.toJson(p)) }
        } catch (e: Exception) {
            fail(e)
        }

        @JavascriptInterface
        fun saveSticker(id: String?, webpB64: String?, emojis: String?, trayB64: String?): String = try {
            val webp = Base64.decode(webpB64 ?: "", Base64.DEFAULT)
            val tray = if (trayB64.isNullOrEmpty()) null else Base64.decode(trayB64, Base64.DEFAULT)
            val p = StickerStore.addSticker(ctx, id ?: "", webp, emojis, tray)
            ok { put("pack", StickerStore.toJson(p)) }
        } catch (e: Exception) {
            fail(e)
        }

        @JavascriptInterface
        fun deleteSticker(id: String?, file: String?): String = try {
            val p = StickerStore.deleteSticker(ctx, id ?: "", file ?: "")
            ok { put("pack", StickerStore.toJson(p)) }
        } catch (e: Exception) {
            fail(e)
        }

        @JavascriptInterface
        fun deletePack(id: String?): String = try {
            StickerStore.deletePack(ctx, id ?: "")
            ok()
        } catch (e: Exception) {
            fail(e)
        }

        @JavascriptInterface
        fun isWhatsAppInstalled(): Boolean = isInstalled("com.whatsapp") || isInstalled("com.whatsapp.w4b")

        @JavascriptInterface
        fun addToWhatsApp(id: String?, name: String?) {
            runOnUiThread { launchAddToWhatsApp(id ?: "", name ?: "Stickers") }
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun saveVideo(b64: String?, mime: String?): String = try {
            val bytes = Base64.decode(b64 ?: "", Base64.DEFAULT)
            if (bytes.isEmpty()) throw IllegalStateException("El video está vacío")
            val dir = File(cacheDir, "videos").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }   // borrar videos anteriores
            val ext = if ((mime ?: "").contains("mp4")) "mp4" else "webm"
            val input = File(dir, "grabado.$ext").apply { writeBytes(bytes) }
            val out = File(dir, "StickerVideo_${System.currentTimeMillis()}.mp4")
            lastVideo = null
            runOnUiThread { exportVideo(input, out) }
            ok { put("pending", true) }
        } catch (e: Exception) {
            fail(e)
        }

        @JavascriptInterface
        fun shareVideo() {
            runOnUiThread { shareLastVideo() }
        }

        @JavascriptInterface
        fun saveToDownloads(b64: String?, fileName: String?): String = try {
            val bytes = Base64.decode(b64 ?: "", Base64.DEFAULT)
            val safe = (fileName ?: "sticker.webp").replace(Regex("[^A-Za-z0-9_.\\-]"), "_")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safe)
                    put(MediaStore.MediaColumns.MIME_TYPE, "image/webp")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/StickersVideo")
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("No se pudo crear el archivo")
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("No se pudo escribir el archivo")
                ok { put("msg", "Guardado en Descargas/StickersVideo") }
            } else {
                val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "StickersVideo").apply { mkdirs() }
                File(dir, safe).writeBytes(bytes)
                ok { put("msg", "Guardado en ${dir.absolutePath}") }
            }
        } catch (e: Exception) {
            fail(e)
        }
    }
}
