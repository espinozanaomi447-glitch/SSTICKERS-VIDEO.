/*
 * Ensamblador de WebP animado.
 * Toma cuadros WebP sueltos (los que genera canvas.toBlob('image/webp'))
 * y los une en un solo archivo WebP animado (RIFF/VP8X/ANIM/ANMF).
 */
(function (root) {
  'use strict';

  function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  /** Lee un WebP simple y devuelve los trozos de imagen (ALPH + VP8/VP8L). */
  function parseFrame(bytes) {
    if (bytes.length < 20 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') {
      throw new Error('Cuadro WebP inválido');
    }
    const chunks = [];
    let hasAlpha = false;
    let off = 12;
    while (off + 8 <= bytes.length) {
      const id = fourcc(bytes, off);
      const size = u32(bytes, off + 4);
      const data = bytes.subarray(off + 8, off + 8 + size);
      if (id === 'ALPH') { hasAlpha = true; chunks.push({ id, data }); }
      else if (id === 'VP8 ') { chunks.push({ id, data }); }
      else if (id === 'VP8L') {
        // bit 28 de la cabecera VP8L = alpha_is_used
        if (data.length >= 5 && (data[4] & 0x10)) hasAlpha = true;
        chunks.push({ id, data });
      }
      off += 8 + size + (size & 1);
    }
    if (!chunks.some(c => c.id === 'VP8 ' || c.id === 'VP8L')) throw new Error('El cuadro no tiene imagen');
    return { chunks, hasAlpha };
  }

  function writeChunk(out, pos, id, data) {
    for (let i = 0; i < 4; i++) out[pos + i] = id.charCodeAt(i);
    const n = data.length;
    out[pos + 4] = n & 255; out[pos + 5] = (n >> 8) & 255; out[pos + 6] = (n >> 16) & 255; out[pos + 7] = (n >>> 24) & 255;
    out.set(data, pos + 8);
    pos += 8 + n;
    if (n & 1) out[pos++] = 0;
    return pos;
  }
  function chunkLen(n) { return 8 + n + (n & 1); }
  function put24(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; }

  /**
   * frames: [{chunks, hasAlpha}] (de parseFrame)
   * durations: número (ms por cuadro) o arreglo
   */
  function buildAnimated(frames, width, height, durations, loopCount) {
    if (!frames.length) throw new Error('Sin cuadros');
    const anyAlpha = frames.some(f => f.hasAlpha);

    // Cuerpos ANMF
    const anmf = frames.map((f, i) => {
      const inner = f.chunks.reduce((s, c) => s + chunkLen(c.data.length), 0);
      const body = new Uint8Array(16 + inner);
      put24(body, 0, 0);            // X / 2
      put24(body, 3, 0);            // Y / 2
      put24(body, 6, width - 1);
      put24(body, 9, height - 1);
      const d = Array.isArray(durations) ? durations[i] : durations;
      put24(body, 12, Math.max(1, Math.round(d)));
      body[15] = 0x02;              // no mezclar con el cuadro anterior, sin desechar
      let p = 16;
      for (const c of f.chunks) p = writeChunk(body, p, c.id, c.data);
      return body;
    });

    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0); // animación (+ alfa)
    put24(vp8x, 4, width - 1);
    put24(vp8x, 7, height - 1);

    const anim = new Uint8Array(6);    // fondo transparente, repetir siempre
    const loops = loopCount || 0;
    anim[4] = loops & 255; anim[5] = (loops >> 8) & 255;

    let total = 4 + chunkLen(10) + chunkLen(6);
    for (const a of anmf) total += chunkLen(a.length);

    const out = new Uint8Array(8 + total);
    out.set([82, 73, 70, 70], 0); // RIFF
    out[4] = total & 255; out[5] = (total >> 8) & 255; out[6] = (total >> 16) & 255; out[7] = (total >>> 24) & 255;
    out.set([87, 69, 66, 80], 8); // WEBP
    let pos = 12;
    pos = writeChunk(out, pos, 'VP8X', vp8x);
    pos = writeChunk(out, pos, 'ANIM', anim);
    for (const a of anmf) pos = writeChunk(out, pos, 'ANMF', a);
    return out;
  }

  /** Tamaño aproximado que tendrá un cuadro dentro del archivo animado. */
  function frameCost(f) {
    return 8 + 16 + f.chunks.reduce((s, c) => s + chunkLen(c.data.length), 0);
  }

  const api = { parseFrame, buildAnimated, frameCost, HEADER_BYTES: 12 + chunkLen(10) + chunkLen(6) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WebPMux = api;
})(typeof window !== 'undefined' ? window : globalThis);
