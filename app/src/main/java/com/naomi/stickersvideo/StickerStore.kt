package com.naomi.stickersvideo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class StickerItem(val file: String, val emojis: String)

data class StickerPack(
    val id: String,
    val name: String,
    val publisher: String,
    val version: Int,
    val stickers: List<StickerItem>
)

/**
 * Guarda los paquetes en el almacenamiento interno de la app:
 *   files/packs/<id>/pack.json, tray.png y s_XXXX.webp
 */
object StickerStore {
    const val TRAY_FILE = "tray.png"
    const val MIN_STICKERS = 3
    const val MAX_STICKERS = 30
    const val MAX_ANIMATED_BYTES = 500 * 1024
    private const val MAX_TRAY_BYTES = 50 * 1024

    private val lock = Any()
    private val ID_RE = Regex("[A-Za-z0-9_.\\-]{1,64}")
    private val FILE_RE = Regex("[A-Za-z0-9_\\-][A-Za-z0-9_.\\-]{0,79}")

    fun rootDir(ctx: Context): File = File(ctx.filesDir, "packs").apply { mkdirs() }

    fun isValidId(id: String?): Boolean = id != null && ID_RE.matches(id) && id != "." && id != ".."
    fun isValidFile(name: String?): Boolean = name != null && FILE_RE.matches(name) && !name.contains("..")

    fun packDir(ctx: Context, id: String): File {
        require(isValidId(id)) { "Paquete inválido" }
        return File(rootDir(ctx), id)
    }

    fun list(ctx: Context): List<StickerPack> = synchronized(lock) {
        rootDir(ctx).listFiles()
            ?.filter { it.isDirectory }
            ?.mapNotNull { readPack(it) }
            ?.sortedBy { it.id }
            ?: emptyList()
    }

    fun load(ctx: Context, id: String): StickerPack? = synchronized(lock) {
        if (!isValidId(id)) null else readPack(packDir(ctx, id))
    }

    fun create(ctx: Context, name: String?, publisher: String?): StickerPack = synchronized(lock) {
        var id = "pack_" + System.currentTimeMillis()
        while (packDir(ctx, id).exists()) id += "x"
        val pack = StickerPack(id, clean(name, "Mis stickers"), clean(publisher, "Yo"), 1, emptyList())
        writePack(ctx, pack)
        pack
    }

    fun rename(ctx: Context, id: String, name: String?, publisher: String?): StickerPack = synchronized(lock) {
        val p = readPack(packDir(ctx, id)) ?: throw IllegalStateException("El paquete no existe")
        val np = p.copy(name = clean(name, p.name), publisher = clean(publisher, p.publisher), version = p.version + 1)
        writePack(ctx, np)
        np
    }

    fun addSticker(ctx: Context, id: String, webp: ByteArray, emojis: String?, tray: ByteArray?): StickerPack =
        synchronized(lock) {
            val dir = packDir(ctx, id)
            val p = readPack(dir) ?: throw IllegalStateException("El paquete no existe")
            if (p.stickers.size >= MAX_STICKERS) throw IllegalStateException("Este paquete ya tiene $MAX_STICKERS stickers")
            if (webp.size > MAX_ANIMATED_BYTES) throw IllegalStateException("El sticker pesa más de 500 KB")
            if (!isWebp(webp)) throw IllegalStateException("El archivo no es un WebP válido")

            var name = "s_" + System.currentTimeMillis() + ".webp"
            while (File(dir, name).exists()) name = "s_" + System.currentTimeMillis() + "_" + (0..999).random() + ".webp"
            File(dir, name).writeBytes(webp)

            val trayFile = File(dir, TRAY_FILE)
            if (!trayFile.exists() && tray != null && tray.isNotEmpty() && tray.size <= MAX_TRAY_BYTES) {
                trayFile.writeBytes(tray)
            }
            val np = p.copy(version = p.version + 1, stickers = p.stickers + StickerItem(name, cleanEmojis(emojis)))
            writePack(ctx, np)
            np
        }

    fun deleteSticker(ctx: Context, id: String, file: String): StickerPack = synchronized(lock) {
        val dir = packDir(ctx, id)
        val p = readPack(dir) ?: throw IllegalStateException("El paquete no existe")
        require(isValidFile(file)) { "Archivo inválido" }
        File(dir, file).delete()
        val np = p.copy(version = p.version + 1, stickers = p.stickers.filter { it.file != file })
        writePack(ctx, np)
        np
    }

    fun deletePack(ctx: Context, id: String): Boolean = synchronized(lock) {
        packDir(ctx, id).deleteRecursively()
    }

    fun toJson(p: StickerPack): JSONObject {
        val arr = JSONArray()
        p.stickers.forEach { arr.put(JSONObject().put("file", it.file).put("emojis", it.emojis)) }
        return JSONObject()
            .put("id", p.id)
            .put("name", p.name)
            .put("publisher", p.publisher)
            .put("version", p.version)
            .put("stickers", arr)
    }

    // ----------------------------------------------------------------

    private fun readPack(dir: File): StickerPack? {
        val f = File(dir, "pack.json")
        if (!f.exists()) return null
        return try {
            val o = JSONObject(f.readText())
            val arr = o.optJSONArray("stickers") ?: JSONArray()
            val items = (0 until arr.length()).mapNotNull { i ->
                val s = arr.optJSONObject(i) ?: return@mapNotNull null
                val file = s.optString("file")
                if (isValidFile(file) && File(dir, file).exists()) StickerItem(file, s.optString("emojis", "😀")) else null
            }
            StickerPack(
                o.getString("id"),
                o.optString("name", "Mis stickers"),
                o.optString("publisher", "Yo"),
                o.optInt("version", 1),
                items
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun writePack(ctx: Context, p: StickerPack) {
        val dir = packDir(ctx, p.id)
        dir.mkdirs()
        val tmp = File(dir, "pack.json.tmp")
        tmp.writeText(toJson(p).toString())
        val target = File(dir, "pack.json")
        if (!tmp.renameTo(target)) {
            target.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun clean(s: String?, def: String): String {
        val t = (s ?: "").trim().take(100)
        return t.ifEmpty { def }
    }

    private fun cleanEmojis(s: String?): String {
        val list = (s ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }.take(3)
        return if (list.isEmpty()) "😀" else list.joinToString(",")
    }

    private fun isWebp(b: ByteArray): Boolean =
        b.size > 16 &&
            b[0] == 'R'.code.toByte() && b[1] == 'I'.code.toByte() && b[2] == 'F'.code.toByte() && b[3] == 'F'.code.toByte() &&
            b[8] == 'W'.code.toByte() && b[9] == 'E'.code.toByte() && b[10] == 'B'.code.toByte() && b[11] == 'P'.code.toByte()
}
