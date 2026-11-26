package com.naomi.stickersvideo

import android.content.ContentProvider
import android.content.ContentValues
import android.content.UriMatcher
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Proveedor que WhatsApp consulta para leer los paquetes de stickers.
 * Sigue el formato oficial del ejemplo de WhatsApp (WhatsApp/stickers en GitHub).
 */
class StickerContentProvider : ContentProvider() {

    companion object {
        const val AUTHORITY = "com.naomi.stickersvideo.stickercontentprovider"

        private const val METADATA = "metadata"
        private const val STICKERS = "stickers"
        private const val STICKERS_ASSET = "stickers_asset"

        private const val CODE_ALL_PACKS = 1
        private const val CODE_ONE_PACK = 2
        private const val CODE_STICKERS = 3
        private const val CODE_ASSET = 4

        private val PACK_COLUMNS = arrayOf(
            "sticker_pack_identifier",
            "sticker_pack_name",
            "sticker_pack_publisher",
            "sticker_pack_icon",
            "android_play_store_link",
            "ios_app_download_link",
            "sticker_pack_publisher_email",
            "sticker_pack_publisher_website",
            "sticker_pack_privacy_policy_website",
            "sticker_pack_license_agreement_website",
            "image_data_version",
            "whatsapp_will_not_cache_stickers",
            "animated_sticker_pack"
        )

        private val STICKER_COLUMNS = arrayOf(
            "sticker_file_name",
            "sticker_emoji",
            "sticker_accessibility_text"
        )
    }

    private val matcher = UriMatcher(UriMatcher.NO_MATCH).apply {
        addURI(AUTHORITY, METADATA, CODE_ALL_PACKS)
        addURI(AUTHORITY, "$METADATA/*", CODE_ONE_PACK)
        addURI(AUTHORITY, "$STICKERS/*", CODE_STICKERS)
        addURI(AUTHORITY, "$STICKERS_ASSET/*/*", CODE_ASSET)
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<String>?,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?
    ): Cursor? {
        val ctx = context ?: return null
        val cursor: MatrixCursor = when (matcher.match(uri)) {
            CODE_ALL_PACKS -> packCursor(StickerStore.list(ctx).filter { it.stickers.size >= StickerStore.MIN_STICKERS })
            CODE_ONE_PACK -> {
                val id = uri.lastPathSegment ?: ""
                packCursor(listOfNotNull(StickerStore.load(ctx, id)))
            }
            CODE_STICKERS -> {
                val id = uri.lastPathSegment ?: ""
                val c = MatrixCursor(STICKER_COLUMNS)
                StickerStore.load(ctx, id)?.stickers?.forEach { s ->
                    c.addRow(arrayOf<Any?>(s.file, s.emojis, ""))
                }
                c
            }
            else -> throw IllegalArgumentException("URI desconocida: $uri")
        }
        cursor.setNotificationUri(ctx.contentResolver, uri)
        return cursor
    }

    private fun packCursor(packs: List<StickerPack>): MatrixCursor {
        val c = MatrixCursor(PACK_COLUMNS)
        packs.forEach { p ->
            c.addRow(
                arrayOf<Any?>(
                    p.id,
                    p.name,
                    p.publisher,
                    StickerStore.TRAY_FILE,
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    p.version.toString(),
                    0,
                    1 // todos los stickers de esta app son animados
                )
            )
        }
        return c
    }

    override fun getType(uri: Uri): String? = when (matcher.match(uri)) {
        CODE_ALL_PACKS -> "vnd.android.cursor.dir/vnd.$AUTHORITY.$METADATA"
        CODE_ONE_PACK -> "vnd.android.cursor.item/vnd.$AUTHORITY.$METADATA"
        CODE_STICKERS -> "vnd.android.cursor.dir/vnd.$AUTHORITY.$STICKERS"
        CODE_ASSET -> if ((uri.lastPathSegment ?: "").endsWith(".png")) "image/png" else "image/webp"
        else -> throw IllegalArgumentException("URI desconocida: $uri")
    }

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor? {
        val ctx = context ?: throw FileNotFoundException("Sin contexto")
        if (matcher.match(uri) != CODE_ASSET) throw FileNotFoundException("URI no válida: $uri")
        val segs = uri.pathSegments
        if (segs.size != 3) throw FileNotFoundException("URI no válida: $uri")
        val id = segs[1]
        val name = segs[2]
        if (!StickerStore.isValidId(id) || !StickerStore.isValidFile(name)) {
            throw FileNotFoundException("Nombre no válido")
        }
        val file = File(StickerStore.packDir(ctx, id), name)
        if (!file.exists()) throw FileNotFoundException("No existe: $name")
        val pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        return AssetFileDescriptor(pfd, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException("No permitido")

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int =
        throw UnsupportedOperationException("No permitido")

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<String>?
    ): Int = throw UnsupportedOperationException("No permitido")
}
