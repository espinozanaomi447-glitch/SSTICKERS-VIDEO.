# Stickers de Video 🎬➡️💬

App Android para convertir pedacitos de video en **stickers animados de WhatsApp**.

## Qué hace

1. **Elegir video** de la galería.
2. **Recortar en tiempo**: dos tiradores amarillos para el inicio y el final (máx. 10 s). Puedes arrastrar la franja amarilla completa para moverla, y usar los botones − / + para ajustar de a 0.1 s.
3. **Encuadrar**: arrastra el video con el dedo, pellizca para acercar o usa la barra de zoom.
4. **Estilo**: forma (cuadro, redondo, círculo), fondo, borde, texto con color, fluidez y velocidad (×0.5 a ×2).
5. **Crear sticker**: genera un WebP animado de 512×512 y menos de 500 KB. Si queda pesado, la app baja la calidad o los cuadros por segundo sola.
6. **Guardar en un paquete**, elegir 1 a 3 emojis, y cuando el paquete tenga **3 stickers o más**, tocar **"Agregar a WhatsApp"**.
7. También puedes **descargar** el sticker (.webp) a `Descargas/StickersVideo`.
8. **🔊 Como video**: guarda el mismo pedazo recortado (con encuadre, texto y borde) como video MP4 **con su sonido**, en la galería (`Películas/StickersVideo`), y lo envía por WhatsApp. El botón 🔇/🔊 del editor deja escuchar el audio mientras recortas.

> Los stickers de WhatsApp todavía no aceptan sonido: WhatsApp está probando "stickers con sonido" en beta, pero solo dentro de su propio creador.

## Compilar el APK con GitHub Actions

1. Crea un repositorio nuevo en GitHub (por ejemplo `STICKERS-VIDEO`).
2. Sube **todo el contenido** de esta carpeta (incluida la carpeta oculta `.github`).
3. Entra a la pestaña **Actions** → "Compilar APK". Se ejecuta solo con cada subida (o con *Run workflow*).
4. Cuando termine (✅), abre la ejecución y descarga **StickersDeVideo-apk** al final de la página.
5. Descomprime el zip e instala el `.apk` en el teléfono (permite "instalar apps desconocidas" si lo pide).

> La carpeta `keystore/` tiene una llave de prueba fija: así cada APK nuevo se instala **encima** del anterior y no pierdes tus stickers.

## Notas

- Requiere Android 8.0 o más nuevo.
- Si al crear el sticker dice que el teléfono no puede crear WebP, actualiza **Android System WebView** y **Chrome** desde la Play Store.
- Si agregas más stickers a un paquete que ya está en WhatsApp, vuelve a tocar "Agregar a WhatsApp" para actualizarlo.
- WhatsApp exige: 3 a 30 stickers por paquete, 512×512 px, máximo 500 KB y 10 s por sticker animado. La app ya lo cumple.

## Estructura

```
app/src/main/assets/      → interfaz (HTML, CSS, JS) y el ensamblador de WebP animado
app/src/main/java/...     → MainActivity (WebView), StickerStore (paquetes), StickerContentProvider (lo que lee WhatsApp)
.github/workflows/        → compilación automática del APK
```
