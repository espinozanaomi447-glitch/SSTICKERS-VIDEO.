/* Stickers de Video — interfaz y creación del sticker */
(() => {
  'use strict';

  const SIZE = 512;             // WhatsApp: 512 x 512
  const TRAY = 96;              // ícono del paquete: 96 x 96
  const TARGET_BYTES = 500000;  // WhatsApp acepta hasta 500 KB (512000 bytes)
  const MAX_OUT = 10;           // WhatsApp: máximo 10 s de animación
  const MIN_LEN = 0.5;
  const DEFAULT_LEN = 3;
  const MAX_PER_PACK = 30;
  const MIN_PER_PACK = 3;
  const EMOJIS = ['😂', '🤣', '😍', '🥰', '😘', '😎', '🤔', '😭', '😱', '😡', '👍', '🙏', '👏', '🎉', '❤️', '🔥'];

  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const preview = $('#preview');
  const pctx = preview.getContext('2d');

  const ed = {
    url: null, name: '', dur: 0, start: 0, end: 0,
    zoom: 1, ox: 0, oy: 0,
    shape: 'square', bg: 'transparent', border: 'none',
    text: '', textPos: 'bottom', textColor: '#ffffff',
    fps: 12, speed: 1,
  };
  let screen = 'home';
  let result = null;      // { bytes, tray, url, frames, fps, ms }
  let busy = false;
  let scrubbing = false;
  let raf = 0;
  let userPaused = false;
  let pickedEmojis = [EMOJIS[0]];

  // =====================================================================
  // Almacenamiento (Android real o simulado en el navegador)
  // =====================================================================
  const Store = (() => {
    const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    if (window.Android) {
      const A = window.Android;
      return {
        native: true,
        list: () => parse(A.listPacks()) || [],
        create: (n, p) => parse(A.createPack(n, p)),
        rename: (id, n, p) => parse(A.renamePack(id, n, p)) || { ok: false, error: 'Error' },
        save: (id, b64, emo, tray) => parse(A.saveSticker(id, b64, emo, tray)) || { ok: false, error: 'Error desconocido' },
        delSticker: (id, f) => parse(A.deleteSticker(id, f)) || { ok: false },
        delPack: (id) => parse(A.deletePack(id)) || { ok: false },
        url: (p, file) => `/stickers/${encodeURIComponent(p.id)}/${encodeURIComponent(file)}?v=${p.version}`,
        hasWA: () => { try { return A.isWhatsAppInstalled(); } catch (e) { return true; } },
        addToWA: (p) => A.addToWhatsApp(p.id, p.name),
        download: (b64, name) => parse(A.saveToDownloads(b64, name)) || { ok: false, error: 'Error' },
        keepAwake: (on) => { try { A.keepScreenOn(on); } catch (e) { /* nada */ } },
      };
    }
    // Simulación para probar en un navegador de computadora
    const packs = [];
    const files = {};
    const toUrl = (b64, type) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([u], { type }));
    };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    return {
      native: false,
      list: () => clone(packs),
      create: (n, p) => {
        const pk = { id: 'pack_' + Date.now(), name: n || 'Mis stickers', publisher: p || 'Yo', version: 1, stickers: [] };
        packs.push(pk); return clone(pk);
      },
      rename: (id, n, p) => { const pk = packs.find((x) => x.id === id); pk.name = n || pk.name; pk.publisher = p || pk.publisher; pk.version++; return { ok: true, pack: clone(pk) }; },
      save: (id, b64, emo, tray) => {
        const pk = packs.find((x) => x.id === id);
        if (!pk) return { ok: false, error: 'El paquete no existe' };
        if (pk.stickers.length >= MAX_PER_PACK) return { ok: false, error: 'Paquete lleno' };
        const file = 's_' + Date.now() + '.webp';
        files[id + '/' + file] = toUrl(b64, 'image/webp');
        if (!files[id + '/tray.png'] && tray) files[id + '/tray.png'] = toUrl(tray, 'image/png');
        pk.stickers.push({ file, emojis: emo }); pk.version++;
        window.__lastSaved = b64;
        return { ok: true, pack: clone(pk) };
      },
      delSticker: (id, f) => { const pk = packs.find((x) => x.id === id); pk.stickers = pk.stickers.filter((s) => s.file !== f); pk.version++; return { ok: true }; },
      delPack: (id) => { const i = packs.findIndex((x) => x.id === id); if (i >= 0) packs.splice(i, 1); return { ok: true }; },
      url: (p, file) => files[p.id + '/' + file] || '',
      hasWA: () => true,
      addToWA: () => setTimeout(() => window.onWhatsAppResult('error', 'Esto solo funciona dentro de la app de Android.'), 300),
      download: (b64, name) => {
        const a = document.createElement('a'); a.href = toUrl(b64, 'image/webp'); a.download = name; a.click();
        return { ok: true, msg: 'Descargado' };
      },
      keepAwake: () => {},
    };
  })();

  // =====================================================================
  // Utilidades de interfaz
  // =====================================================================
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
    screen = name;
  }

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function setBusy(on, text) {
    busy = on;
    $('#busy').classList.toggle('hidden', !on);
    if (text) $('#busyText').textContent = text;
    setProgress(0);
    Store.keepAwake(on);
  }
  function setProgress(p) { $('#busyBar').style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Hoja inferior genérica: { title, text, html, inputs:[{id,placeholder,value}], actions:[{label,kind,fn}] } */
  function sheet(o) {
    const card = $('#sheetCard');
    let h = '';
    if (o.html) h += o.html;
    if (o.title) h += `<h3>${esc(o.title)}</h3>`;
    if (o.text) h += `<p>${esc(o.text)}</p>`;
    if (o.inputs) {
      h += '<div class="stack">' + o.inputs.map((i) =>
        `<input type="text" id="${i.id}" maxlength="60" placeholder="${esc(i.placeholder)}" value="${esc(i.value || '')}">`).join('') + '</div>';
    }
    h += '<div class="actions">' + (o.actions || []).map((a, k) =>
      `<button data-k="${k}" class="${a.kind || ''}">${esc(a.label)}</button>`).join('') +
      `<button data-k="x">${esc(o.cancel || 'Cancelar')}</button></div>`;
    card.innerHTML = h;
    $('#sheet').classList.remove('hidden');
    card.querySelectorAll('button[data-k]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k;
        const vals = {};
        (o.inputs || []).forEach((i) => { vals[i.id] = $('#' + i.id).value.trim(); });
        closeSheet();
        if (k !== 'x') o.actions[+k].fn(vals);
      };
    });
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetCard').innerHTML = ''; }
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

  const sheetOpen = () => !$('#sheet').classList.contains('hidden');

  // Botón "atrás" de Android
  window.appBack = () => {
    if (sheetOpen()) { closeSheet(); return true; }
    if (busy) return true;
    if (screen === 'result') { backToEditor(); return true; }
    if (screen === 'editor') { leaveEditor(); return true; }
    return false;
  };

  window.onWhatsAppResult = (code, msg) => {
    if (code === 'ok') toast('¡Paquete agregado a WhatsApp! 🎉', 3500);
    else if (code === 'cancel') toast('No se agregó el paquete');
    else if (code === 'notinstalled') sheet({ title: 'WhatsApp no está instalado', text: msg || 'Instala WhatsApp para agregar tus stickers.', actions: [], cancel: 'Entendido' });
    else sheet({ title: 'WhatsApp no aceptó el paquete', text: msg || 'Intenta de nuevo.', actions: [], cancel: 'Entendido' });
  };

  // =====================================================================
  // Inicio: paquetes
  // =====================================================================
  const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';

  function renderHome(flashId) {
    const packs = Store.list();
    const box = $('#packs');
    $('#emptyPacks').classList.toggle('hidden', packs.length > 0);
    $('#btnResume').classList.toggle('hidden', !ed.url);
    box.innerHTML = packs.slice().reverse().map((p) => {
      const n = p.stickers.length;
      const tray = n ? `<img class="tray" src="${Store.url(p, 'tray.png')}" alt="">` : '<div class="tray none">📦</div>';
      const thumbs = p.stickers.map((s) =>
        `<button class="th" data-pack="${esc(p.id)}" data-file="${esc(s.file)}"><img loading="lazy" src="${Store.url(p, s.file)}" alt=""></button>`).join('');
      const add = n < MAX_PER_PACK ? `<button class="th add" data-addto="${esc(p.id)}">＋</button>` : '';
      const ready = n >= MIN_PER_PACK;
      const faltan = MIN_PER_PACK - n;
      const waBtn = ready
        ? `<button class="wa" data-wa="${esc(p.id)}">${WA_ICON} Agregar a WhatsApp</button>`
        : `<button class="wa" disabled>Faltan ${faltan} sticker${faltan === 1 ? '' : 's'} para WhatsApp</button>`;
      return `<div class="pack ${p.id === flashId ? 'flash' : ''}" id="p_${esc(p.id)}">
        <div class="pack-head">${tray}
          <div class="meta"><b>${esc(p.name)}</b><small>${esc(p.publisher)} · ${n}/${MAX_PER_PACK} stickers</small></div>
          <button class="more" data-more="${esc(p.id)}" aria-label="Opciones">⋯</button>
        </div>
        <div class="grid">${thumbs}${add}</div>
        ${waBtn}
      </div>`;
    }).join('');

    const byId = (id) => packs.find((p) => p.id === id);
    box.querySelectorAll('[data-wa]').forEach((b) => { b.onclick = () => addToWhatsApp(byId(b.dataset.wa)); });
    box.querySelectorAll('[data-more]').forEach((b) => { b.onclick = () => packMenu(byId(b.dataset.more)); });
    box.querySelectorAll('[data-addto]').forEach((b) => {
      b.onclick = () => { try { localStorage.setItem('lastPack', b.dataset.addto); } catch (e) { /* */ } pickVideo(); };
    });
    box.querySelectorAll('.th[data-file]').forEach((b) => {
      b.onclick = () => stickerMenu(byId(b.dataset.pack), b.dataset.file);
    });
    if (flashId) {
      const el = document.getElementById('p_' + flashId);
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }

  function addToWhatsApp(p) {
    if (!p) return;
    if (p.stickers.length < MIN_PER_PACK) { toast(`Necesitas al menos ${MIN_PER_PACK} stickers`); return; }
    if (!Store.hasWA()) { window.onWhatsAppResult('notinstalled', ''); return; }
    Store.addToWA(p);
  }

  function packMenu(p) {
    sheet({
      title: p.name,
      text: `${p.stickers.length} de ${MAX_PER_PACK} stickers`,
      actions: [
        { label: '✏️ Cambiar nombre', fn: () => renamePack(p) },
        {
          label: '🗑 Eliminar paquete', kind: 'danger', fn: () => sheet({
            title: '¿Eliminar este paquete?',
            text: `Se borrarán sus ${p.stickers.length} stickers de esta app. Si ya lo agregaste a WhatsApp, quítalo también desde WhatsApp.`,
            actions: [{ label: 'Sí, eliminar', kind: 'danger', fn: () => { Store.delPack(p.id); renderHome(); toast('Paquete eliminado'); } }],
          }),
        },
      ],
    });
  }

  function renamePack(p) {
    sheet({
      title: 'Nombre del paquete',
      inputs: [
        { id: 'inName', placeholder: 'Nombre del paquete', value: p.name },
        { id: 'inPub', placeholder: 'Autor', value: p.publisher },
      ],
      actions: [{
        label: 'Guardar', kind: 'primary', fn: (v) => {
          const r = Store.rename(p.id, v.inName, v.inPub);
          if (r && r.ok === false) toast(r.error || 'No se pudo cambiar');
          renderHome(p.id);
        },
      }],
    });
  }

  function newPackDialog(after) {
    sheet({
      title: 'Nuevo paquete',
      inputs: [
        { id: 'inName', placeholder: 'Nombre del paquete', value: '' },
        { id: 'inPub', placeholder: 'Autor (tu nombre)', value: getPublisher() },
      ],
      actions: [{
        label: 'Crear paquete', kind: 'primary', fn: (v) => {
          setPublisher(v.inPub);
          const p = Store.create(v.inName || 'Mis stickers', v.inPub || 'Yo');
          renderHome(p && p.id);
          if (after) after(p);
        },
      }],
    });
  }

  function stickerMenu(p, file) {
    sheet({
      html: `<img class="sticker-big" src="${Store.url(p, file)}" alt="">`,
      actions: [{
        label: '🗑 Quitar del paquete', kind: 'danger', fn: () => {
          const r = Store.delSticker(p.id, file);
          if (r && r.ok === false) toast(r.error || 'No se pudo quitar');
          else toast('Sticker quitado');
          renderHome(p.id);
        },
      }],
    });
  }

  function getPublisher() { try { return localStorage.getItem('publisher') || ''; } catch (e) { return ''; } }
  function setPublisher(v) { try { if (v) localStorage.setItem('publisher', v); } catch (e) { /* */ } }

  // =====================================================================
  // Abrir video
  // =====================================================================
  const fileInput = $('#fileInput');
  function pickVideo() { fileInput.value = ''; fileInput.click(); }
  $('#btnNew').onclick = pickVideo;
  $('#btnNewPack').onclick = () => newPackDialog();
  $('#btnResume').onclick = () => { if (ed.url) enterEditor(); };
  fileInput.onchange = () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) openVideo(f);
  };

  function once(el, ok, bad, ms) {
    return new Promise((res, rej) => {
      let to = 0;
      const clean = () => { el.removeEventListener(ok, onOk); if (bad) el.removeEventListener(bad, onBad); clearTimeout(to); };
      const onOk = () => { clean(); res(); };
      const onBad = () => { clean(); rej(new Error('No se pudo abrir este video. Prueba con otro (MP4 funciona mejor).')); };
      el.addEventListener(ok, onOk);
      if (bad) el.addEventListener(bad, onBad);
      if (ms) to = setTimeout(() => { clean(); rej(new Error('El video tardó demasiado en cargar.')); }, ms);
    });
  }

  function seek(t) {
    return new Promise((res) => {
      const target = Math.max(0, Math.min(t, Math.max(0, ed.dur - 0.02)));
      let to = 0;
      const done = () => { video.removeEventListener('seeked', done); clearTimeout(to); res(); };
      video.addEventListener('seeked', done);
      to = setTimeout(done, 2500);
      video.currentTime = target;
    });
  }

  async function openVideo(file) {
    setBusy(true, 'Abriendo video…');
    try {
      stopPreview();
      if (ed.url) URL.revokeObjectURL(ed.url);
      ed.url = URL.createObjectURL(file);
      ed.name = (file.name || 'sticker').replace(/\.[^.]+$/, '');
      video.src = ed.url;
      video.load();
      await once(video, 'loadeddata', 'error', 20000);
      if (!video.videoWidth) throw new Error('Ese archivo no tiene imagen de video.');
      let d = video.duration;
      if (!isFinite(d) || d <= 0) {
        // algunos videos no dicen su duración hasta llegar al final
        video.currentTime = 1e7;
        await once(video, 'seeked', null, 8000).catch(() => {});
        d = video.duration;
        if (!isFinite(d) || d <= 0) d = video.currentTime || 5;
      }
      ed.dur = d;
      ed.start = 0;
      ed.end = Math.min(d, DEFAULT_LEN);
      ed.zoom = 1; ed.ox = 0; ed.oy = 0;
      ed.text = ''; $('#text').value = '';
      $('#zoom').value = 1;
      enterEditor(true);
      await buildStrip();
      setBusy(false);
      startPreview();
    } catch (err) {
      setBusy(false);
      leaveEditor(true);
      sheet({ title: 'No se pudo abrir el video', text: err.message || String(err), actions: [], cancel: 'Entendido' });
    }
  }

  function enterEditor(skipStart) {
    show('editor');
    const max = ed.dur.toFixed(2);
    for (const r of [$('#rStart'), $('#rEnd')]) { r.max = max; r.step = ed.dur > 60 ? 0.05 : 0.01; }
    syncTimeline();
    if (!skipStart) startPreview();
  }

  function leaveEditor(silent) {
    stopPreview();
    show('home');
    renderHome();
    if (!silent && ed.url) { /* el video queda disponible con "Seguir con el último video" */ }
  }

  // =====================================================================
  // Dibujo del cuadro (vista previa y exportación usan la misma función)
  // =====================================================================
  function roundRectPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function shapePath(c, s, inset) {
    c.beginPath();
    if (ed.shape === 'circle') c.arc(s / 2, s / 2, s / 2 - inset, 0, Math.PI * 2);
    else if (ed.shape === 'rounded') roundRectPath(c, inset, inset, s - 2 * inset, s - 2 * inset, Math.max(0, s * 0.2 - inset));
    else c.rect(inset, inset, s - 2 * inset, s - 2 * inset);
  }

  function drawFrame(c, src, s) {
    const k = s / SIZE;
    c.save();
    c.clearRect(0, 0, s, s);
    const borderW = ed.border !== 'none' ? 18 * k : 0;
    shapePath(c, s, borderW ? borderW * 0.5 : 0);
    c.clip();
    if (ed.bg !== 'transparent') { c.fillStyle = ed.bg; c.fillRect(0, 0, s, s); }
    const vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
    if (vw && vh) {
      const sc = Math.max(s / vw, s / vh) * ed.zoom;
      const w = vw * sc, h = vh * sc;
      const x = (s - w) / 2 + ed.ox * s, y = (s - h) / 2 + ed.oy * s;
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, x, y, w, h);
    }
    c.restore();
    if (borderW) {
      c.save();
      shapePath(c, s, borderW / 2);
      c.lineWidth = borderW;
      c.strokeStyle = ed.border;
      c.stroke();
      c.restore();
    }
    drawText(c, s);
  }

  function drawText(c, s) {
    const txt = ed.text.trim();
    if (!txt) return;
    const k = s / SIZE;
    let fs = 76 * k;
    const font = (n) => `900 ${n}px system-ui, "Roboto", sans-serif`;
    c.save();
    c.font = font(fs);
    const maxW = s * 0.9;
    const w = c.measureText(txt).width;
    if (w > maxW) { fs = Math.max(22 * k, fs * maxW / w); c.font = font(fs); }
    c.textAlign = 'center';
    c.textBaseline = ed.textPos === 'top' ? 'top' : 'bottom';
    const y = ed.textPos === 'top' ? s * 0.05 : s * 0.95;
    c.lineJoin = 'round';
    c.miterLimit = 2;
    c.lineWidth = Math.max(4 * k, fs * 0.2);
    c.strokeStyle = ed.textColor === '#ffffff' || ed.textColor === '#ffd23f' ? '#111' : '#fff';
    c.strokeText(txt, s / 2, y, maxW);
    c.fillStyle = ed.textColor;
    c.fillText(txt, s / 2, y, maxW);
    c.restore();
  }

  // =====================================================================
  // Vista previa en bucle
  // =====================================================================
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!video.videoWidth) return;
    if (!scrubbing && !video.paused) {
      if (video.currentTime >= ed.end - 0.01 || video.currentTime < ed.start - 0.15 || video.ended) {
        video.currentTime = ed.start;
      }
    }
    drawFrame(pctx, video, SIZE);
    const ph = $('#playhead');
    ph.style.left = (video.currentTime / ed.dur * 100) + '%';
  }

  function startPreview() {
    if (!ed.url) return;
    video.playbackRate = ed.speed;
    if (video.currentTime < ed.start || video.currentTime > ed.end) video.currentTime = ed.start;
    if (!userPaused) video.play().catch(() => {});
    updatePlayBtn();
    if (!raf) loop();
  }
  function stopPreview() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    video.pause();
  }
  function resumeAfterScrub() {
    scrubbing = false;
    video.currentTime = ed.start;
    if (!userPaused) video.play().catch(() => {});
  }
  function togglePlay() {
    userPaused = !video.paused ? true : false;
    if (userPaused) video.pause(); else { video.playbackRate = ed.speed; video.play().catch(() => {}); }
    updatePlayBtn();
  }
  function updatePlayBtn() { $('#edPlay').textContent = userPaused ? '▶' : '❚❚'; }
  $('#edPlay').onclick = togglePlay;
  $('#edBack').onclick = () => leaveEditor();

  // =====================================================================
  // Línea de tiempo
  // =====================================================================
  const rStart = $('#rStart'), rEnd = $('#rEnd');
  const fmt = (t) => t.toFixed(1);
  const maxSel = () => MAX_OUT * ed.speed;   // a ×2 caben 20 s de video en 10 s de sticker

  function syncTimeline() {
    const d = ed.dur || 1;
    rStart.value = ed.start; rEnd.value = ed.end;
    const a = ed.start / d * 100, b = ed.end / d * 100;
    $('#sel').style.left = a + '%'; $('#sel').style.width = (b - a) + '%';
    $('#shadeL').style.width = a + '%'; $('#shadeR').style.width = (100 - b) + '%';
    $('#tStart').textContent = fmt(ed.start);
    $('#tEnd').textContent = fmt(ed.end);
    const outLen = (ed.end - ed.start) / ed.speed;
    const pill = $('#tLen');
    pill.textContent = fmt(outLen) + ' s';
    pill.classList.toggle('warn', outLen > 6);
    // que el tirador de inicio quede arriba cuando ambos están al final
    rStart.style.zIndex = ed.start > d * 0.9 ? 3 : 1;
    rEnd.style.zIndex = 2;
  }

  function setRange(which, v) {
    const m = maxSel();
    const minLen = Math.min(MIN_LEN, ed.dur);
    if (which === 's') {
      v = Math.max(0, Math.min(v, ed.dur - minLen));
      ed.start = v;
      if (ed.end < v + minLen) ed.end = v + minLen;
      if (ed.end - ed.start > m) ed.end = ed.start + m;
    } else {
      v = Math.min(ed.dur, Math.max(v, minLen));
      ed.end = v;
      if (ed.start > v - minLen) ed.start = v - minLen;
      if (ed.end - ed.start > m) ed.start = ed.end - m;
    }
    ed.start = Math.max(0, ed.start); ed.end = Math.min(ed.dur, ed.end);
    syncTimeline();
  }

  rStart.addEventListener('input', () => { scrubbing = true; video.pause(); setRange('s', +rStart.value); video.currentTime = ed.start; });
  rEnd.addEventListener('input', () => { scrubbing = true; video.pause(); setRange('e', +rEnd.value); video.currentTime = Math.max(0, ed.end - 0.05); });
  rStart.addEventListener('change', resumeAfterScrub);
  rEnd.addEventListener('change', resumeAfterScrub);

  // arrastrar la selección completa
  const sel = $('#sel');
  sel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sel.setPointerCapture(e.pointerId);
    const rect = $('#timeline').getBoundingClientRect();
    const s0 = ed.start, len = ed.end - ed.start, x0 = e.clientX;
    scrubbing = true; video.pause();
    const move = (ev) => {
      const dt = (ev.clientX - x0) / rect.width * ed.dur;
      ed.start = Math.max(0, Math.min(s0 + dt, ed.dur - len));
      ed.end = ed.start + len;
      syncTimeline();
      video.currentTime = ed.start;
    };
    const up = () => {
      sel.removeEventListener('pointermove', move);
      sel.removeEventListener('pointerup', up);
      sel.removeEventListener('pointercancel', up);
      resumeAfterScrub();
    };
    sel.addEventListener('pointermove', move);
    sel.addEventListener('pointerup', up);
    sel.addEventListener('pointercancel', up);
  });

  document.querySelectorAll('.nudge button').forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.n, step = 0.1;
      if (n === 's-') setRange('s', ed.start - step);
      if (n === 's+') setRange('s', ed.start + step);
      if (n === 'e-') setRange('e', ed.end - step);
      if (n === 'e+') setRange('e', ed.end + step);
      video.currentTime = n[0] === 's' ? ed.start : Math.max(0, ed.end - 0.05);
    };
  });

  async function buildStrip() {
    const strip = $('#strip');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(strip.clientWidth * dpr));
    const H = Math.max(1, Math.round(strip.clientHeight * dpr));
    strip.width = W; strip.height = H;
    const c = strip.getContext('2d');
    c.fillStyle = '#2b241d'; c.fillRect(0, 0, W, H);
    const n = Math.max(4, Math.min(10, Math.round(W / (H * 0.8))));
    const sw = W / n;
    const vw = video.videoWidth, vh = video.videoHeight;
    for (let i = 0; i < n; i++) {
      await seek((i + 0.5) / n * ed.dur);
      const slotA = sw / H, srcA = vw / vh;
      let sx = 0, sy = 0, sWd = vw, sHt = vh;
      if (srcA > slotA) { sWd = vh * slotA; sx = (vw - sWd) / 2; } else { sHt = vw / slotA; sy = (vh - sHt) / 2; }
      c.drawImage(video, sx, sy, sWd, sHt, i * sw, 0, sw + 1, H);
      setProgress((i + 1) / n);
    }
    await seek(ed.start);
  }

  // =====================================================================
  // Mover / acercar con el dedo
  // =====================================================================
  const pts = new Map();
  let g = null;
  function gestureStart() {
    const arr = [...pts.values()];
    g = { zoom: ed.zoom, ox: ed.ox, oy: ed.oy, arr: arr.map((p) => ({ ...p })), moved: false, t: Date.now() };
    if (arr.length === 2) {
      g.dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
      g.mid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
    }
  }
  preview.addEventListener('pointerdown', (e) => {
    preview.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gestureStart();
  });
  preview.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = preview.getBoundingClientRect();
    const arr = [...pts.values()];
    if (arr.length === 1 && g.arr.length === 1) {
      const dx = arr[0].x - g.arr[0].x, dy = arr[0].y - g.arr[0].y;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
      ed.ox = g.ox + dx / rect.width;
      ed.oy = g.oy + dy / rect.height;
    } else if (arr.length === 2 && g.dist) {
      g.moved = true;
      const dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      const mid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
      ed.zoom = Math.max(0.4, Math.min(3, g.zoom * dist / g.dist));
      const r = ed.zoom / g.zoom;
      ed.ox = g.ox * r + (mid.x - g.mid.x) / rect.width;
      ed.oy = g.oy * r + (mid.y - g.mid.y) / rect.height;
      $('#zoom').value = ed.zoom;
    }
  });
  const endPt = (e) => {
    if (!pts.has(e.pointerId)) return;
    const wasTap = g && !g.moved && pts.size === 1 && Date.now() - g.t < 300;
    pts.delete(e.pointerId);
    if (wasTap) togglePlay();
    if (pts.size) gestureStart(); else g = null;
  };
  preview.addEventListener('pointerup', endPt);
  preview.addEventListener('pointercancel', endPt);

  $('#zoom').addEventListener('input', (e) => {
    const nz = +e.target.value, r = nz / ed.zoom;
    ed.ox *= r; ed.oy *= r; ed.zoom = nz;
  });
  $('#btnCenter').onclick = () => { ed.zoom = 1; ed.ox = 0; ed.oy = 0; $('#zoom').value = 1; };

  // botones segmentados
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        const key = seg.dataset.key;
        const v = b.dataset.v;
        ed[key] = (key === 'fps' || key === 'speed') ? +v : v;
        if (key === 'speed') {
          video.playbackRate = ed.speed;
          if (ed.end - ed.start > maxSel()) ed.end = ed.start + maxSel();
          syncTimeline();
        }
      };
    });
  });
  $('#text').addEventListener('input', (e) => { ed.text = e.target.value; });

  // =====================================================================
  // Crear el sticker (WebP animado)
  // =====================================================================
  function encodeCanvas(canvas, q) {
    return new Promise((res, rej) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return rej(new Error('No se pudo codificar el cuadro'));
        if (blob.type !== 'image/webp') return rej(new Error('Este teléfono no puede crear imágenes WebP. Actualiza "Android System WebView" desde la Play Store.'));
        res(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/webp', q);
    });
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function makeSticker() {
    if (!ed.url || busy) return;
    stopPreview();
    setBusy(true, 'Tomando cuadros del video…');
    const bitmaps = [];
    try {
      const outLen = Math.min((ed.end - ed.start) / ed.speed, MAX_OUT);
      const n = Math.max(2, Math.min(150, Math.round(outLen * ed.fps)));
      const frameMs = Math.max(20, Math.min(Math.floor(MAX_OUT * 1000 / n), Math.round(outLen * 1000 / n)));
      const work = document.createElement('canvas');
      work.width = work.height = SIZE;
      const wctx = work.getContext('2d');

      for (let i = 0; i < n; i++) {
        await seek(ed.start + (i * frameMs / 1000) * ed.speed);
        drawFrame(wctx, video, SIZE);
        bitmaps.push(await createImageBitmap(work));
        setProgress(0.45 * (i + 1) / n);
      }

      // ícono del paquete
      const tc = document.createElement('canvas');
      tc.width = tc.height = TRAY;
      tc.getContext('2d').drawImage(bitmaps[Math.floor(n / 2)], 0, 0, TRAY, TRAY);
      const trayUrl = tc.toDataURL('image/png');

      $('#busyText').textContent = 'Creando sticker animado…';
      let q = 0.8, stride = 1, out = null, usedFps = ed.fps;
      for (let attempt = 0; attempt < 12 && !out; attempt++) {
        const idx = [];
        for (let i = 0; i < n; i += stride) idx.push(i);
        const ms = Math.min(frameMs * stride, Math.floor(MAX_OUT * 1000 / idx.length));
        const frames = [];
        let bytes = WebPMux.HEADER_BYTES, aborted = false;
        for (let j = 0; j < idx.length; j++) {
          wctx.clearRect(0, 0, SIZE, SIZE);
          wctx.drawImage(bitmaps[idx[j]], 0, 0);
          const f = WebPMux.parseFrame(await encodeCanvas(work, q));
          frames.push(f);
          bytes += WebPMux.frameCost(f);
          setProgress(0.45 + 0.55 * Math.min(1, (attempt * 0.25) + 0.25 * (j + 1) / idx.length));
          // si ya se ve que no va a caber, cortar y probar con menos calidad
          const est = bytes / (j + 1) * idx.length;
          if (j >= Math.min(5, idx.length - 1) && est > TARGET_BYTES * 1.12) {
            aborted = true;
            adjust(TARGET_BYTES / est);
            break;
          }
          if (j % 3 === 0) await tick();
        }
        if (aborted) continue;
        const file = WebPMux.buildAnimated(frames, SIZE, SIZE, ms, 0);
        if (file.length <= TARGET_BYTES) {
          out = { bytes: file, frames: idx.length, ms, q };
          usedFps = Math.round(1000 / ms * 10) / 10;
        } else {
          adjust(TARGET_BYTES / file.length);
        }
      }
      function adjust(ratio) {
        if (q > 0.2 && ratio > 0.4) {
          q = Math.max(0.12, q - Math.max(0.07, (1 - ratio) * q * 0.9));
        } else if (stride < 4) {
          stride++;
          q = Math.min(0.75, q + 0.25);
        } else {
          q = Math.max(0.05, q - 0.05);
        }
      }
      if (!out) throw new Error('El sticker quedó muy pesado. Acorta la duración o elige "Fluidez: Baja".');

      if (result && result.url) URL.revokeObjectURL(result.url);
      result = {
        bytes: out.bytes,
        tray: trayUrl.split(',')[1],
        url: URL.createObjectURL(new Blob([out.bytes], { type: 'image/webp' })),
        frames: out.frames, fps: usedFps, ms: out.ms * out.frames, q: out.q,
      };
      setProgress(1);
      setBusy(false);
      showResult();
    } catch (err) {
      setBusy(false);
      startPreview();
      sheet({ title: 'No se pudo crear el sticker', text: err.message || String(err), actions: [], cancel: 'Entendido' });
    } finally {
      bitmaps.forEach((b) => b.close && b.close());
    }
  }
  $('#btnMake').onclick = makeSticker;

  // =====================================================================
  // Resultado
  // =====================================================================
  function showResult() {
    show('result');
    $('#resImg').src = result.url;
    const kb = Math.round(result.bytes.length / 1024);
    $('#resInfo').innerHTML = `<b>${kb} KB</b> de 500 · ${(result.ms / 1000).toFixed(1)} s · ${result.frames} cuadros` +
      (result.q < 0.45 ? '<br>Bajé la calidad para que WhatsApp lo acepte.' : '');
    renderEmojis();
    renderPackSelect();
  }

  function renderEmojis() {
    const box = $('#emojiPick');
    box.innerHTML = EMOJIS.map((e) => `<button class="${pickedEmojis.includes(e) ? 'on' : ''}">${e}</button>`).join('');
    box.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const e = b.textContent;
        if (pickedEmojis.includes(e)) {
          if (pickedEmojis.length > 1) pickedEmojis = pickedEmojis.filter((x) => x !== e);
        } else {
          pickedEmojis.push(e);
          if (pickedEmojis.length > 3) pickedEmojis.shift();
        }
        renderEmojis();
      };
    });
  }

  function renderPackSelect() {
    const packs = Store.list().filter((p) => p.stickers.length < MAX_PER_PACK);
    let last = '';
    try { last = localStorage.getItem('lastPack') || ''; } catch (e) { /* */ }
    const s = $('#packSel');
    s.innerHTML = packs.slice().reverse().map((p) =>
      `<option value="${esc(p.id)}" ${p.id === last ? 'selected' : ''}>${esc(p.name)} (${p.stickers.length}/${MAX_PER_PACK})</option>`).join('') +
      `<option value="__new" ${packs.length ? '' : 'selected'}>＋ Nuevo paquete…</option>`;
    if (!packs.some((p) => p.id === last) && packs.length) s.selectedIndex = 0;
    $('#newPackPub').value = getPublisher();
    s.onchange = () => $('#newPackFields').classList.toggle('hidden', s.value !== '__new');
    s.onchange();
  }

  function toB64(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  $('#btnSave').onclick = () => {
    if (!result) return;
    let packId = $('#packSel').value;
    if (packId === '__new') {
      const name = $('#newPackName').value.trim() || 'Mis stickers';
      const pub = $('#newPackPub').value.trim() || 'Yo';
      setPublisher(pub);
      const p = Store.create(name, pub);
      if (!p) { toast('No se pudo crear el paquete'); return; }
      packId = p.id;
      $('#newPackName').value = '';
    }
    const r = Store.save(packId, toB64(result.bytes), pickedEmojis.join(','), result.tray);
    if (!r || !r.ok) {
      sheet({ title: 'No se pudo guardar', text: (r && r.error) || 'Error desconocido', actions: [], cancel: 'Entendido' });
      return;
    }
    try { localStorage.setItem('lastPack', packId); } catch (e) { /* */ }
    const n = r.pack ? r.pack.stickers.length : 0;
    show('home');
    renderHome(packId);
    if (n === MIN_PER_PACK) toast('¡Listo! Ya puedes agregar el paquete a WhatsApp 🎉', 3500);
    else if (n < MIN_PER_PACK) toast(`Sticker guardado ✅ Te faltan ${MIN_PER_PACK - n} para WhatsApp`, 3200);
    else toast('Sticker guardado ✅ Vuelve a "Agregar a WhatsApp" para actualizarlo', 3500);
  };

  $('#btnDownload').onclick = () => {
    if (!result) return;
    const name = (ed.name || 'sticker').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 30) + '_' + Date.now() + '.webp';
    const r = Store.download(toB64(result.bytes), name);
    toast(r && r.ok ? (r.msg || 'Guardado') : ((r && r.error) || 'No se pudo guardar'));
  };

  function backToEditor() { show('editor'); startPreview(); }
  $('#resBack').onclick = backToEditor;

  // =====================================================================
  renderHome();
  window.__app = { ed, makeSticker, get result() { return result; }, Store };
})();
