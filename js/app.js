import { STR } from './i18n.js';
import { db, uid } from './db.js';
import { buildPdf } from './pdf.js';
import { FILTERS, defaultQuad, orderQuad } from './imaging.js';

const VERSION = '1.0.0';
const SRC_MAX = 3000;      // stored original, long side
const OUT_MAX = 2400;      // processed page, long side
const PREVIEW_MAX = 1400;  // decoded source while cropping / previewing

/* ================= settings & i18n ================= */
const settings = Object.assign(
  { lang: 'ar', theme: 'system', defFilter: 'magic', pageSize: 'a4', quality: 'std' },
  (() => { try { return JSON.parse(localStorage.getItem('s74') || '{}'); } catch { return {}; } })()
);
const saveSettings = () => { try { localStorage.setItem('s74', JSON.stringify(settings)); } catch {} };
const t = (k, ...a) => { const v = STR[settings.lang][k] ?? STR.ar[k] ?? k; return typeof v === 'function' ? v(...a) : v; };
function applyLocale() {
  const el = document.documentElement;
  el.lang = settings.lang; el.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';
  if (settings.theme === 'system') delete el.dataset.theme; else el.dataset.theme = settings.theme;
  document.title = t('appName');
}
applyLocale();

/* ================= small helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const locale = () => (settings.lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB');
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 864e5;
  if (diff === 0) return `${t('today')} ${time}`;
  if (diff === 1) return `${t('yesterday')} ${time}`;
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
function defaultDocName() {
  // words between the numbers keep the order right in both directions
  const d = new Date();
  const day = d.toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  return t('defaultName', `${day} ${time}`);
}
const urls = new Set();
const objURL = (blob) => { const u = URL.createObjectURL(blob); urls.add(u); return u; };
const freeURLs = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); };

/* ================= worker ================= */
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let wid = 0; const pending = new Map();
worker.onmessage = (e) => { const { id, result, error } = e.data; const p = pending.get(id); if (!p) return; pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(result); };
const work = (op, payload, transfer = []) => new Promise((resolve, reject) => { const id = ++wid; pending.set(id, { resolve, reject }); worker.postMessage({ id, op, ...payload }, transfer); });

/* ================= canvas helpers ================= */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
function readImg(c) { const d = ctx2d(c).getImageData(0, 0, c.width, c.height); return { width: d.width, height: d.height, data: d.data }; }
function imgToCanvas(img, c = canvas(img.width, img.height)) {
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}
const toBlob = (c, q = 0.9) => new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('encode'))), 'image/jpeg', q));
async function decode(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
    try { return await createImageBitmap(blob); } catch {}
  }
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('decode')); im.src = URL.createObjectURL(blob); });
}
const dims = (b) => ({ w: b.naturalWidth || b.width, h: b.naturalHeight || b.height });
// draw a decoded image, scaled to maxSide and turned by quarter turns
function drawTurned(bmp, maxSide, rot = 0) {
  const { w, h } = dims(bmp);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.round(w * s), H = Math.round(h * s);
  const r = ((rot % 4) + 4) % 4;
  const c = canvas(r % 2 ? H : W, r % 2 ? W : H), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.translate(c.width / 2, c.height / 2); g.rotate((r * Math.PI) / 2);
  g.drawImage(bmp, -W / 2, -H / 2, W, H);
  return c;
}
function scaleQuad(q, s) { return q.map((p) => ({ x: p.x * s, y: p.y * s })); }
function turnQuad(q, w, h, dir) {
  // rotate points of an image of size w×h by +90° (dir 1, clockwise) or −90°
  const r = dir > 0 ? q.map((p) => ({ x: h - p.y, y: p.x })) : q.map((p) => ({ x: p.y, y: w - p.x }));
  return orderQuad(r);
}

/* ================= session (a capture / edit in progress) ================= */
let session = null;
function newSession(extra = {}) { session = { shots: [], index: 0, finished: false, docId: null, editPageId: null, applyAll: true, ...extra }; return session; }

async function ingest(blobOrCanvas) {
  // normalise any picture into a stored JPEG of at most SRC_MAX and detect the page
  let c;
  if (blobOrCanvas instanceof HTMLCanvasElement) {
    c = blobOrCanvas.width > SRC_MAX || blobOrCanvas.height > SRC_MAX ? drawTurned(blobOrCanvas, SRC_MAX) : blobOrCanvas;
  } else {
    const bmp = await decode(blobOrCanvas);
    c = drawTurned(bmp, SRC_MAX);
    bmp.close?.();
  }
  const blob = await toBlob(c, 0.92);
  const shot = { id: uid(), blob, w: c.width, h: c.height, rot: 0, quad: null, confident: false, filter: settings.defFilter, adjust: { brightness: 0, contrast: 0 } };
  const small = drawTurned(c, 640);
  const k = c.width / small.width;
  try {
    const { quad, confident } = await work('detect', { img: readImg(small) });
    shot.quad = scaleQuad(quad, k); shot.confident = confident;
  } catch { shot.quad = defaultQuad(shot.w, shot.h, 0.04); }
  const th = drawTurned(c, 240);
  shot.thumbURL = objURL(await toBlob(th, 0.7));
  return shot;
}
// the shot's dimensions after its source rotation
const shotDims = (s) => (s.rot % 2 ? { w: s.h, h: s.w } : { w: s.w, h: s.h });

const srcCache = new Map(); // shot.id+rot+max -> canvas
async function shotSource(shot, maxSide) {
  const key = `${shot.id}:${shot.rot}:${maxSide}`;
  if (srcCache.has(key)) return srcCache.get(key);
  const bmp = await decode(shot.blob);
  const c = drawTurned(bmp, maxSide, shot.rot);
  bmp.close?.();
  if (srcCache.size > 4) srcCache.delete(srcCache.keys().next().value);
  srcCache.set(key, c);
  return c;
}

/* ================= UI primitives ================= */
const app = $('#app');
let cleanup = [];
function mount(html, cls = '') {
  cleanup.forEach((f) => { try { f(); } catch {} }); cleanup = [];
  closeSheet(true);
  freeURLs();
  const el = document.createElement('div');
  el.className = `screen enter ${cls}`;
  el.innerHTML = html;
  app.replaceChildren(el);
  return el;
}

function toast(msg, action) {
  const box = $('.toasts');
  box.replaceChildren();
  const el = document.createElement('div');
  el.className = 'toast hide';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  box.append(el);
  requestAnimationFrame(() => el.classList.remove('hide'));
  let timer;
  const close = () => { clearTimeout(timer); el.classList.add('hide'); setTimeout(() => el.remove(), 300); };
  const arm = () => { timer = setTimeout(close, action ? 5000 : 2600); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  if (action) el.querySelector('button').onclick = () => { action.run(); close(); };
  arm();
}

let sheetEls = null;
function openSheet(html, { studio = false, onClose } = {}) {
  closeSheet(true);
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const sh = document.createElement('div'); sh.className = `sheet${studio ? ' studio' : ''}`;
  sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
  sh.innerHTML = `<div class="grabber" aria-hidden="true"></div>${html}`;
  document.body.append(scrim, sh);
  const prevFocus = document.activeElement;
  sheetEls = { scrim, sh, onClose, prevFocus };
  scrim.onclick = () => closeSheet();
  requestAnimationFrame(() => { scrim.classList.add('open'); sh.classList.add('open'); (sh.querySelector('[autofocus]') || sh.querySelector('button, input'))?.focus({ preventScroll: true }); });
  // drag down to dismiss
  let y0 = null, t0 = 0, dy = 0;
  const grab = sh.querySelector('.grabber');
  const down = (e) => { if (e.target.closest('input, .seg, .menu') && e.target !== grab) return; if (sh.scrollTop > 0) return; y0 = e.clientY; t0 = performance.now(); dy = 0; sh.style.transition = 'none'; };
  const move = (e) => { if (y0 == null) return; dy = e.clientY - y0; if (dy < 0) dy = dy / 4; sh.style.transform = `translateY(${dy}px)`; };
  const up = () => { if (y0 == null) return; sh.style.transition = ''; const v = dy / (performance.now() - t0); y0 = null; if (dy > 120 || v > 0.5) closeSheet(); else sh.style.transform = ''; };
  sh.addEventListener('pointerdown', down); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  sheetEls.unbind = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  return sh;
}
function closeSheet(instant = false) {
  if (!sheetEls) return;
  const { scrim, sh, onClose, unbind, prevFocus } = sheetEls; sheetEls = null;
  unbind?.();
  if (instant) { scrim.remove(); sh.remove(); } else {
    sh.classList.add('closing'); sh.style.transform = ''; sh.classList.remove('open'); scrim.classList.remove('open');
    setTimeout(() => { scrim.remove(); sh.remove(); }, 220);
  }
  prevFocus?.focus?.({ preventScroll: true });
  onClose?.();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetEls) closeSheet(); });

function confirmSheet({ title, body, ok, danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const sh = openSheet(`<h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
      <div class="actions"><button class="btn btn-quiet" data-a="no">${t('cancel')}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(ok)}</button></div>`,
    { onClose: () => { if (!done) resolve(false); } });
    sh.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; done = true; resolve(a === 'yes'); closeSheet(); };
  });
}
function promptSheet({ title, value, ok }) {
  return new Promise((resolve) => {
    let done = false;
    const sh = openSheet(`<h2>${esc(title)}</h2>
      <form><label class="field"><span class="sr">${esc(title)}</span><input type="text" value="${esc(value)}" autofocus maxlength="120" enterkeyhint="done"></label>
      <div class="actions"><button type="button" class="btn btn-quiet" data-a="no">${t('cancel')}</button><button class="btn btn-primary" type="submit">${esc(ok)}</button></div></form>`,
    { onClose: () => { if (!done) resolve(null); } });
    const inp = sh.querySelector('input');
    setTimeout(() => inp.select(), 350);
    sh.querySelector('form').onsubmit = (e) => { e.preventDefault(); done = true; resolve(inp.value.trim() || value); closeSheet(); };
    sh.querySelector('[data-a="no"]').onclick = () => closeSheet();
  });
}

let busyEl = null;
function busy(msg, p = null) {
  if (!busyEl) {
    busyEl = document.createElement('div'); busyEl.className = 'busy';
    busyEl.innerHTML = `<div class="busy-card" role="alertdialog" aria-live="polite"><p></p><div class="track"><i></i></div></div>`;
    document.body.append(busyEl);
  }
  busyEl.querySelector('p').textContent = msg;
  const tr = busyEl.querySelector('.track');
  tr.classList.toggle('indet', p == null);
  if (p != null) tr.style.setProperty('--p', p);
}
function unbusy() { busyEl?.remove(); busyEl = null; }

/* ================= file import ================= */
const fileIn = $('#file-in');
function pickImages() {
  return new Promise((resolve) => {
    fileIn.value = '';
    const onChange = () => { fileIn.removeEventListener('change', onChange); resolve([...fileIn.files]); };
    fileIn.addEventListener('change', onChange);
    fileIn.click();
  });
}
async function importInto(sess, files) {
  const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|gif|bmp)$/i.test(f.name));
  if (!imgs.length) return 0;
  let n = 0;
  for (let i = 0; i < imgs.length; i++) {
    busy(t('processing'), imgs.length > 1 ? i / imgs.length : null);
    try { sess.shots.push(await ingest(imgs[i])); n++; } catch { toast(t('errLoad')); }
  }
  unbusy();
  return n;
}

/* ================= router ================= */
let stream = null;
function stopCamera() { if (stream) { stream.getTracks().forEach((tr) => tr.stop()); stream = null; } }
const go = (hash, replace = false) => { if (replace) location.replace(hash); else location.hash = hash; };

async function route() {
  stopCamera();
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = h.split('/');
  try {
    if (!a) return await renderLibrary();
    if (a === 'doc' && b) return await renderDoc(b);
    if (a === 'cam') return session && !session.finished ? renderCamera() : go('#/', true);
    if (a === 'crop') return session && !session.finished && session.shots.length ? renderCrop() : go('#/', true);
    if (a === 'filter') return session && !session.finished && session.shots.length ? await renderFilter() : go('#/', true);
    if (a === 'settings') return await renderSettings();
    if (a === 'page' && b && c === 'edit') return await startEditPage(b);
    go('#/', true);
  } catch (err) {
    console.error(err); unbusy(); toast(t('errGeneric'));
  }
}
window.addEventListener('hashchange', route);

/* ================= library ================= */
async function docThumb(doc) {
  if (!doc.pageIds.length) return null;
  const p = await db.getPage(doc.pageIds[0]);
  return p?.thumb ? objURL(p.thumb) : null;
}

async function renderLibrary() {
  const docs = await db.listDocs();
  const el = mount(`
    <header class="lib-head">
      <div class="brand"><img src="icons/icon-192.png" alt="" width="40" height="40"><h1>${t('appName')}</h1></div>
      <button class="icon-btn" data-a="settings" aria-label="${t('settings')}">${icon('settings')}</button>
    </header>
    ${docs.length ? `<div class="search">${icon('search')}<input type="search" placeholder="${t('search')}" aria-label="${t('search')}" enterkeyhint="search"></div>` : ''}
    <main id="main" style="display:contents"></main>
    <div class="dock">
      <button class="btn btn-quiet" data-a="import">${icon('image')}<span>${t('import')}</span></button>
      <button class="btn btn-primary" data-a="scan">${icon('camera')}<span>${t('scan')}</span></button>
    </div>`);
  const main = $('#main', el);
  const thumbs = await Promise.all(docs.map(docThumb));
  const draw = (q = '') => {
    const list = docs.map((d, i) => ({ d, th: thumbs[i] })).filter(({ d }) => d.name.toLowerCase().includes(q.toLowerCase()));
    if (!docs.length) {
      main.innerHTML = `<section class="empty">
        <svg class="empty-art" viewBox="0 0 128 160" aria-hidden="true">
          <rect x="22" y="18" width="84" height="112" rx="4" fill="var(--surface)" />
          <rect x="34" y="38" width="48" height="5" rx="2.5" fill="var(--surface-3)"/><rect x="34" y="52" width="60" height="5" rx="2.5" fill="var(--surface-3)"/>
          <rect x="34" y="66" width="54" height="5" rx="2.5" fill="var(--surface-3)"/><rect x="34" y="80" width="38" height="5" rx="2.5" fill="var(--surface-3)"/>
          <g fill="none" stroke="var(--ink)" stroke-width="5" stroke-linecap="round"><path d="M6 30V8h22M100 8h22v22M122 120v22h-22M28 142H6v-22"/></g>
        </svg>
        <h2>${t('emptyTitle')}</h2><p>${t('emptyBody')}</p></section>`;
      return;
    }
    if (!list.length) { main.innerHTML = `<section class="empty"><p>${t('noResults')}</p></section>`; return; }
    main.innerHTML = `<ul class="list">${list.map(({ d, th }, i) => `
      <li class="row row-item" style="--n:${Math.min(i, 12)}">
        <button class="row-main" data-a="open" data-id="${d.id}">
          ${th ? `<img class="thumb" src="${th}" alt="" loading="lazy">` : `<span class="thumb"></span>`}
          <span class="row-text"><span class="row-name">${esc(d.name)}</span><span class="row-meta">${fmtDate(d.updated)} · ${t('pages', d.pageIds.length)}</span></span>
        </button>
        <button class="icon-btn" data-a="menu" data-id="${d.id}" aria-label="${t('more')}: ${esc(d.name)}">${icon('more')}</button>
      </li>`).join('')}</ul>`;
  };
  draw();
  $('input[type=search]', el)?.addEventListener('input', (e) => draw(e.target.value));

  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, id = b.dataset.id;
    if (a === 'settings') go('#/settings');
    if (a === 'scan') { newSession(); go('#/cam'); }
    if (a === 'import') { const files = await pickImages(); const s = newSession(); if (await importInto(s, files)) go('#/crop'); }
    if (a === 'open') go(`#/doc/${id}`);
    if (a === 'menu') docMenu(docs.find((d) => d.id === id), () => renderLibrary());
  };
}

function docMenu(doc, refresh) {
  const sh = openSheet(`<h2>${esc(doc.name)}</h2><p>${t('pages', doc.pageIds.length)}</p>
    <ul class="menu">
      <li><button data-a="share">${icon('share')}${t('share')}</button></li>
      <li><button data-a="rename">${icon('edit')}${t('rename')}</button></li>
      <li><button data-a="delete" class="danger">${icon('trash')}${t('delete')}</button></li>
    </ul>`);
  sh.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    closeSheet(true);
    if (a === 'share') exportSheet(doc);
    if (a === 'rename') { const name = await promptSheet({ title: t('docName'), value: doc.name, ok: t('save') }); if (name && name !== doc.name) { doc.name = name; doc.updated = Date.now(); await db.putDoc(doc); refresh(); } }
    if (a === 'delete') { if (await confirmSheet({ title: t('deleteDocQ', doc.name), body: t('deleteDocBody'), ok: t('delete') })) { await db.deleteDoc(doc.id); toast(t('deleted')); refresh(true); } }
  };
}

/* ================= camera ================= */
async function renderCamera() {
  const el = mount(`
    <div class="cam studio">
      <div class="cam-view">
        <video playsinline muted autoplay></video>
        <svg class="overlay" aria-hidden="true"><polygon class="cam-quad" points="" style="opacity:0"/></svg>
        <div class="cam-flash"></div>
        <div class="cam-top">
          <button class="icon-btn" data-a="close" aria-label="${t('close')}">${icon('close')}</button>
          <button class="icon-btn" data-a="torch" aria-label="${t('torch')}" aria-pressed="false" hidden>${icon('flash')}</button>
        </div>
        <div class="cam-hint" aria-live="polite"><span>${t('camLooking')}</span></div>
      </div>
      <div class="cam-bottom">
        <div class="cam-modes"><div class="seg" role="group"><button data-a="mode" data-m="single" aria-pressed="${!session.batch}">${t('camSingle')}</button><button data-a="mode" data-m="batch" aria-pressed="${!!session.batch}">${t('camBatch')}</button></div></div>
        <div class="cam-side"><button class="cam-gal" data-a="gallery" aria-label="${t('fromGallery')}">${icon('image')}</button></div>
        <button class="shutter" data-a="shoot" aria-label="${t('shutter')}" disabled></button>
        <div class="cam-side end"><div class="stack"></div></div>
      </div>
    </div>`, 'studio');
  const video = $('video', el), quadEl = $('.cam-quad', el), hint = $('.cam-hint span', el), stack = $('.stack', el), shutter = $('.shutter', el);
  const drawStack = (drop = false) => {
    const n = session.shots.length;
    if (!n) { stack.innerHTML = ''; return; }
    const last = session.shots[n - 1];
    stack.innerHTML = `<img class="stack-thumb${drop ? ' drop' : ''}" src="${last.thumbURL}" alt=""><span class="stack-count">${n}</span><button class="btn btn-primary" data-a="done">${t('done')}</button>`;
  };
  drawStack();

  const fail = (msg) => {
    $('.cam-view', el).insertAdjacentHTML('beforeend', `<div class="cam-msg"><div><p>${esc(msg)}</p><button class="btn btn-primary" data-a="gallery">${icon('image')}${t('fromGallery')}</button></div></div>`);
  };
  if (!window.isSecureContext) { fail(t('camHttps')); }
  else if (!navigator.mediaDevices?.getUserMedia) { fail(t('camNone')); }
  else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
      if (!document.body.contains(el)) { stopCamera(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      shutter.disabled = false;
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      if (caps.torch) $('[data-a=torch]', el).hidden = false;
      if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch (err) {
      fail(err?.name === 'NotAllowedError' ? t('camDenied') : t('camNone'));
    }
  }

  // live outline: sample a small frame a few times a second
  const probe = canvas(1, 1); let live = true, busyDetect = false;
  cleanup.push(() => { live = false; });
  const tick = async () => {
    if (!live) return;
    if (video.videoWidth && !busyDetect) {
      busyDetect = true;
      const vw = video.videoWidth, vh = video.videoHeight, s = 320 / Math.max(vw, vh);
      probe.width = Math.round(vw * s); probe.height = Math.round(vh * s);
      ctx2d(probe).drawImage(video, 0, 0, probe.width, probe.height);
      try {
        const { quad, confident } = await work('detect', { img: readImg(probe) });
        if (!live) return;
        const r = video.getBoundingClientRect(); const k = Math.max(r.width / probe.width, r.height / probe.height);
        const ox = (r.width - probe.width * k) / 2, oy = (r.height - probe.height * k) / 2;
        quadEl.setAttribute('points', quad.map((p) => `${(p.x * k + ox).toFixed(1)},${(p.y * k + oy).toFixed(1)}`).join(' '));
        quadEl.style.opacity = confident ? 1 : 0;
        hint.textContent = confident ? t('camFound') : t('camLooking');
        hint.classList.toggle('found', confident);
      } catch {}
      busyDetect = false;
    }
    setTimeout(tick, 380);
  };
  tick();

  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') { session.finished = true; history.length > 1 ? history.back() : go('#/', true); }
    if (a === 'mode') { session.batch = b.dataset.m === 'batch'; $$('[data-a=mode]', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); }
    if (a === 'torch') {
      const on = b.getAttribute('aria-pressed') !== 'true';
      try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); b.setAttribute('aria-pressed', on); } catch {}
    }
    if (a === 'gallery') {
      const files = await pickImages();
      if (await importInto(session, files)) { if (session.batch) drawStack(true); else go('#/crop'); }
    }
    if (a === 'done') go('#/crop');
    if (a === 'shoot') {
      if (!video.videoWidth || shutter.disabled) return;
      const flash = $('.cam-flash', el); flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
      navigator.vibrate?.(10);
      const c = canvas(video.videoWidth, video.videoHeight);
      c.getContext('2d').drawImage(video, 0, 0);
      shutter.disabled = true;
      try {
        const shot = await ingest(c);
        session.shots.push(shot); session.fromCam = true;
        if (session.batch) drawStack(true); else { go('#/crop'); return; }
      } catch { toast(t('errGeneric')); }
      shutter.disabled = false;
    }
  };
}

/* ================= crop ================= */
async function renderCrop() {
  const n = session.shots.length;
  session.index = Math.min(session.index, n - 1);
  const el = mount(`
    <div class="studio-screen studio">
      <header class="bar">
        <button class="icon-btn" data-a="back" aria-label="${t('back')}">${icon('back', 'flip')}</button>
        <h1>${t('crop')}</h1>
        ${n > 1 ? `<button class="icon-btn" data-a="remove" aria-label="${t('removeShot')}">${icon('trash')}</button>` : ''}
      </header>
      <div class="stage">
        <canvas class="img"></canvas>
        <svg aria-hidden="true"><path class="mask"/><polygon class="edge"/><g class="hs"></g></svg>
        <div class="loupe"><canvas width="112" height="112"></canvas></div>
      </div>
      <div class="tools">
        <button class="tool" data-a="rotl">${icon('rotl')}<span>${t('rotL')}</span></button>
        <button class="tool" data-a="auto">${icon('auto')}<span>${t('autoDetect')}</span></button>
        <button class="tool" data-a="full">${icon('full')}<span>${t('fullPage')}</span></button>
        <button class="tool" data-a="rotr">${icon('rotr')}<span>${t('rotR')}</span></button>
      </div>
      <div class="foot">
        ${n > 1 ? `<div class="pager"><button class="icon-btn" data-a="prev" aria-label="${t('back')}">${icon('back', 'flip')}</button><span class="pg"></span><button class="icon-btn" data-a="next" aria-label="${t('next')}">${icon('down', 'flip')}</button></div>` : ''}
        <button class="btn btn-primary" data-a="go">${t('next')}${icon('back', 'flip-r')}</button>
      </div>
    </div>`, 'studio');
  // forward arrow: mirror of back
  $('[data-a=go] .i', el).style.transform = settings.lang === 'ar' ? 'none' : 'scaleX(-1)';

  const stage = $('.stage', el), cv = $('canvas.img', el), svg = $('.stage > svg', el), maskEl = $('.mask', el), edgeEl = $('.edge', el), hs = $('.hs', el);
  const loupe = $('.loupe', el), lctx = $('canvas', loupe).getContext('2d');
  let shot, src, k = 1, ox = 0, oy = 0, pts = [];

  async function load() {
    shot = session.shots[session.index];
    if (n > 1) $('.pg', el).textContent = t('pageOf', session.index + 1, n);
    src = await shotSource(shot, PREVIEW_MAX);
    layout();
  }
  function layout() {
    const r = stage.getBoundingClientRect();
    const pad = 22;
    k = Math.min((r.width - pad * 2) / src.width, (r.height - pad * 2) / src.height);
    const dw = src.width * k, dh = src.height * k;
    ox = (r.width - dw) / 2; oy = (r.height - dh) / 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(dw * dpr); cv.height = Math.round(dh * dpr);
    cv.style.cssText = `left:${ox}px;top:${oy}px;width:${dw}px;height:${dh}px`;
    const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, cv.width, cv.height);
    const { w } = shotDims(shot); const s = src.width / w; // full-source -> preview
    pts = shot.quad.map((p) => ({ x: p.x * s * k + ox, y: p.y * s * k + oy }));
    draw();
  }
  const isConvex = (q) => { let sign = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]; const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); if (z === 0) continue; if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false; } return true; };
  function draw() {
    const r = stage.getBoundingClientRect();
    const poly = pts.map((p) => `${p.x},${p.y}`).join(' ');
    maskEl.setAttribute('d', `M${ox},${oy}h${src.width * k}v${src.height * k}h${-src.width * k}z M${pts.map((p) => `${p.x},${p.y}`).join(' L')} z`);
    edgeEl.setAttribute('points', poly);
    const ok = isConvex(pts);
    edgeEl.classList.toggle('bad', !ok);
    $('[data-a=go]', el).disabled = !ok;
    const mids = pts.map((p, i) => { const q = pts[(i + 1) % 4]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; });
    hs.innerHTML = pts.map((p, i) => `<circle class="handle" cx="${p.x}" cy="${p.y}" r="13"/><circle class="handle-hit" data-h="c${i}" cx="${p.x}" cy="${p.y}" r="28"/>`).join('') +
      mids.map((p, i) => `<rect class="handle-mid" x="${p.x - 9}" y="${p.y - 3}" width="18" height="6" rx="3" transform="rotate(${Math.atan2(pts[(i + 1) % 4].y - pts[i].y, pts[(i + 1) % 4].x - pts[i].x) * 180 / Math.PI} ${p.x} ${p.y})"/><circle class="handle-hit" data-h="m${i}" cx="${p.x}" cy="${p.y}" r="22"/>`).join('');
    void r;
  }
  function commit() {
    const { w } = shotDims(shot); const s = src.width / w;
    shot.quad = pts.map((p) => ({ x: (p.x - ox) / k / s, y: (p.y - oy) / k / s }));
    shot.preview = null; // crop changed, rebuild previews later
  }
  const clampPt = (p) => ({ x: Math.min(ox + src.width * k, Math.max(ox, p.x)), y: Math.min(oy + src.height * k, Math.max(oy, p.y)) });
  function showLoupe(p) {
    const Z = 2.2; // magnification relative to screen
    const size = 112; const half = size / 2 / (k * Z);
    const sx = (p.x - ox) / k, sy = (p.y - oy) / k;
    lctx.fillStyle = '#000'; lctx.fillRect(0, 0, size, size);
    lctx.drawImage(src, sx - half, sy - half, half * 2, half * 2, 0, 0, size, size);
    // the edges in the loupe
    lctx.strokeStyle = '#c6f046'; lctx.lineWidth = 2; lctx.beginPath();
    pts.forEach((q, i) => { const x = (q.x - p.x) * Z + size / 2, y = (q.y - p.y) * Z + size / 2; i ? lctx.lineTo(x, y) : lctx.moveTo(x, y); }); lctx.closePath(); lctx.stroke();
    const above = p.y - 150 > 0;
    loupe.style.left = `${Math.min(stage.clientWidth - size - 8, Math.max(8, p.x - size / 2))}px`;
    loupe.style.top = `${above ? p.y - 150 : p.y + 40}px`;
    loupe.classList.add('on');
  }

  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-h]'); if (!hEl || drag) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    drag = { h: hEl.dataset.h, id: e.pointerId, start: { x: e.clientX - r.left, y: e.clientY - r.top }, orig: pts.map((p) => ({ ...p })) };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = stage.getBoundingClientRect();
    const dx = e.clientX - r.left - drag.start.x, dy = e.clientY - r.top - drag.start.y;
    const idx = +drag.h.slice(1);
    if (drag.h[0] === 'c') { pts[idx] = clampPt({ x: drag.orig[idx].x + dx, y: drag.orig[idx].y + dy }); showLoupe(pts[idx]); }
    else { const j = (idx + 1) % 4; pts[idx] = clampPt({ x: drag.orig[idx].x + dx, y: drag.orig[idx].y + dy }); pts[j] = clampPt({ x: drag.orig[j].x + dx, y: drag.orig[j].y + dy }); showLoupe({ x: (pts[idx].x + pts[j].x) / 2, y: (pts[idx].y + pts[j].y) / 2 }); }
    draw();
  });
  const end = (e) => { if (!drag || e.pointerId !== drag.id) return; drag = null; loupe.classList.remove('on'); commit(); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(() => src && layout()); ro.observe(stage); cleanup.push(() => ro.disconnect());

  async function turn(dir) {
    const { w, h } = shotDims(shot);
    shot.quad = turnQuad(shot.quad, w, h, dir);
    shot.rot = (shot.rot + dir + 4) % 4; shot.preview = null;
    await load();
  }
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'back') {
      // in single-shot mode, going back from the crop means "retake"
      if (session.fromCam && !session.batch) session.shots = [];
      history.back();
    }
    if (a === 'rotl') turn(-1);
    if (a === 'rotr') turn(1);
    if (a === 'full') { const { w, h } = shotDims(shot); shot.quad = defaultQuad(w, h); shot.preview = null; layout(); }
    if (a === 'auto') {
      const small = drawTurned(src, 640); const s = shotDims(shot).w / small.width;
      const { quad } = await work('detect', { img: readImg(small) });
      shot.quad = scaleQuad(quad, s); shot.preview = null; layout();
    }
    if (a === 'prev' || a === 'next') { session.index = (session.index + (a === 'next' ? 1 : -1) + n) % n; await load(); }
    if (a === 'remove') {
      session.shots.splice(session.index, 1);
      renderCrop();
    }
    if (a === 'go') { session.index = 0; go('#/filter'); }
  };
  await load();
}

/* ================= filter ================= */
async function buildPreview(shot) {
  if (shot.preview) return shot.preview;
  const src = await shotSource(shot, PREVIEW_MAX);
  const s = src.width / shotDims(shot).w;
  const img = await work('process', { img: readImg(src), quad: scaleQuad(shot.quad, s), filter: 'original', maxSide: 1000 });
  shot.preview = img;
  // mini version for the filter strip
  const c = imgToCanvas(img); const m = drawTurned(c, 180);
  shot.mini = readImg(m);
  return img;
}

async function renderFilter() {
  const n = session.shots.length;
  const el = mount(`
    <div class="studio-screen studio">
      <header class="bar">
        <button class="icon-btn" data-a="back" aria-label="${t('back')}">${icon('back', 'flip')}</button>
        <h1>${t('filters')}</h1>
        <button class="icon-btn" data-a="adjust" aria-label="${t('adjust')}" aria-pressed="false">${icon('adjust')}</button>
      </header>
      <div class="preview"><canvas aria-label=""></canvas></div>
      <div class="adjust" hidden>
        <label class="slider"><span>${t('brightness')}</span><input type="range" min="-60" max="60" step="1" data-k="brightness"><output></output></label>
        <label class="slider"><span>${t('contrast')}</span><input type="range" min="-60" max="60" step="1" data-k="contrast"><output></output></label>
      </div>
      <div class="strip" role="group" aria-label="${t('filters')}">${FILTERS.map((f) => `<button class="chip" data-a="f" data-f="${f}" aria-pressed="false"><canvas width="132" height="168"></canvas><span>${t('f_' + f)}</span></button>`).join('')}</div>
      ${n > 1 ? `<label class="check"><input type="checkbox" ${session.applyAll ? 'checked' : ''} data-a="all">${t('applyAll')}</label>` : ''}
      <div class="foot">
        ${n > 1 ? `<div class="pager"><button class="icon-btn" data-a="prev" aria-label="${t('back')}">${icon('back', 'flip')}</button><span class="pg"></span><button class="icon-btn" data-a="next" aria-label="${t('next')}">${icon('down', 'flip')}</button></div>` : ''}
        <button class="btn btn-primary" data-a="save">${icon('check')}${t('save')}</button>
      </div>
    </div>`, 'studio');
  const pv = $('.preview canvas', el);
  let shot, token = 0;

  async function renderPreview() {
    const my = ++token;
    pv.classList.add('dim');
    const img = await work('filter', { img: shot.preview, filter: shot.filter, adjust: shot.adjust, maxSide: 1000 });
    if (my !== token) return;
    imgToCanvas(img, pv); pv.classList.remove('dim');
  }
  async function renderChips() {
    $$('.chip', el).forEach((ch) => ch.setAttribute('aria-pressed', ch.dataset.f === shot.filter));
    for (const ch of $$('.chip', el)) {
      const img = await work('filter', { img: shot.mini, filter: ch.dataset.f, adjust: { brightness: 0, contrast: 0 }, maxSide: 200 });
      const c = ch.querySelector('canvas'); const g = c.getContext('2d');
      const tmp = imgToCanvas(img); const s = Math.max(c.width / tmp.width, c.height / tmp.height);
      g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(tmp, (c.width - tmp.width * s) / 2, (c.height - tmp.height * s) / 2, tmp.width * s, tmp.height * s);
    }
  }
  function syncSliders() {
    $$('input[type=range]', el).forEach((r) => { r.value = shot.adjust[r.dataset.k]; r.nextElementSibling.textContent = shot.adjust[r.dataset.k]; });
  }
  async function load() {
    shot = session.shots[session.index];
    if (n > 1) $('.pg', el).textContent = t('pageOf', session.index + 1, n);
    if (!shot.preview) { busy(t('processing')); try { await buildPreview(shot); } finally { unbusy(); } }
    syncSliders();
    await renderPreview();
    renderChips();
    // warm up the others in the background
    session.shots.forEach((s) => { if (!s.preview) buildPreview(s).catch(() => {}); });
  }
  let slideTimer;
  el.addEventListener('input', (e) => {
    const r = e.target.closest('input[type=range]'); if (!r) return;
    shot.adjust[r.dataset.k] = +r.value; r.nextElementSibling.textContent = r.value;
    if (session.applyAll) session.shots.forEach((s) => { s.adjust = { ...shot.adjust }; });
    clearTimeout(slideTimer); slideTimer = setTimeout(renderPreview, 50);
  });
  el.addEventListener('change', (e) => { if (e.target.dataset.a === 'all') session.applyAll = e.target.checked; });
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'back') history.back();
    if (a === 'adjust') { const p = $('.adjust', el); p.hidden = !p.hidden; b.setAttribute('aria-pressed', !p.hidden); }
    if (a === 'f') {
      shot.filter = b.dataset.f;
      if (session.applyAll) session.shots.forEach((s) => { s.filter = shot.filter; });
      $$('.chip', el).forEach((ch) => ch.setAttribute('aria-pressed', ch === b));
      renderPreview();
    }
    if (a === 'prev' || a === 'next') { session.index = (session.index + (a === 'next' ? 1 : -1) + n) % n; await load(); }
    if (a === 'save') await saveSession();
  };
  await load();
}

async function processShot(shot) {
  const src = await shotSource(shot, SRC_MAX);
  const img = await work('process', { img: readImg(src), quad: shot.quad, filter: shot.filter, adjust: shot.adjust, maxSide: OUT_MAX });
  const c = imgToCanvas(img);
  const processed = await toBlob(c, 0.9);
  const thumb = await toBlob(drawTurned(c, 420), 0.8);
  return { processed, thumb, w: c.width, h: c.height };
}

async function saveSession() {
  const s = session; const n = s.shots.length;
  let doc;
  if (s.docId) doc = await db.getDoc(s.docId);
  if (!doc) doc = { id: uid(), name: defaultDocName(), created: Date.now(), updated: Date.now(), pageIds: [] };
  try {
    for (let i = 0; i < n; i++) {
      busy(t('processing'), i / n); await nextFrame();
      const sh = s.shots[i];
      const out = await processShot(sh);
      const id = s.editPageId || uid();
      await db.putPage({ id, docId: doc.id, original: sh.blob, srcW: sh.w, srcH: sh.h, rot: sh.rot, quad: sh.quad, filter: sh.filter, adjust: sh.adjust, ...out, created: Date.now() });
      if (!s.editPageId) {
        if (s.insertAt != null) doc.pageIds.splice(s.insertAt + i, 0, id); else doc.pageIds.push(id);
      }
      busy(t('processing'), (i + 1) / n);
    }
    doc.updated = Date.now();
    await db.putDoc(doc);
  } finally { unbusy(); }
  s.finished = true; srcCache.clear();
  go(`#/doc/${doc.id}`, true);
  toast(t('saved'));
}

async function startEditPage(pageId) {
  const p = await db.getPage(pageId);
  if (!p) return go('#/', true);
  newSession({ docId: p.docId, editPageId: p.id });
  session.shots.push({ id: uid(), blob: p.original, w: p.srcW, h: p.srcH, rot: p.rot || 0, quad: p.quad, filter: p.filter, adjust: { ...p.adjust } });
  go('#/crop', true);
}

/* ================= document ================= */
async function renderDoc(id) {
  const doc = await db.getDoc(id);
  if (!doc) return go('#/', true);
  const pages = await db.getPages(doc);
  let reordering = false;
  const el = mount(`
    <header class="bar">
      <button class="icon-btn" data-a="home" aria-label="${t('back')}">${icon('back', 'flip')}</button>
      <button class="title" data-a="rename" aria-label="${t('rename')}">${esc(doc.name)}</button>
      ${pages.length > 1 ? `<button class="icon-btn" data-a="reorder" aria-label="${t('reorder')}" aria-pressed="false">${icon('reorder')}</button>` : ''}
      <button class="icon-btn" data-a="menu" aria-label="${t('more')}">${icon('more')}</button>
    </header>
    <p class="doc-meta">${fmtDate(doc.updated)} · ${t('pages', pages.length)}</p>
    <ul class="grid"></ul>
    <div class="dock">
      <button class="btn btn-quiet" data-a="add">${icon('camera')}<span>${t('addPages')}</span></button>
      <button class="btn btn-primary" data-a="export">${icon('share')}<span>${t('share')}</span></button>
    </div>`);
  const grid = $('.grid', el);
  const thumbs = new Map(pages.map((p) => [p.id, objURL(p.thumb)]));
  const draw = () => {
    grid.classList.toggle('reordering', reordering);
    grid.innerHTML = doc.pageIds.map((pid, i) => `
      <li class="tile" style="--n:${Math.min(i, 12)}">
        <button class="tile-btn" data-a="view" data-i="${i}" aria-label="${t('pageN', i + 1)}"><img src="${thumbs.get(pid)}" alt="" loading="lazy"></button>
        <div class="tile-label"><span>${t('pageN', i + 1)}</span>
          <span class="tile-moves"><button class="icon-btn" data-a="up" data-i="${i}" aria-label="${t('moveEarlier')}" ${i === 0 ? 'disabled' : ''}>${icon('up', 'flip')}</button><button class="icon-btn" data-a="down" data-i="${i}" aria-label="${t('moveLater')}" ${i === doc.pageIds.length - 1 ? 'disabled' : ''}>${icon('down', 'flip')}</button></span>
        </div>
      </li>`).join('');
  };
  draw();
  const refreshDoc = () => renderDoc(id);

  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, i = +b.dataset.i;
    if (a === 'home') go('#/');
    if (a === 'rename') { const name = await promptSheet({ title: t('docName'), value: doc.name, ok: t('save') }); if (name) { doc.name = name; doc.updated = Date.now(); await db.putDoc(doc); $('.title', el).textContent = name; } }
    if (a === 'menu') docMenu(doc, (gone) => (gone ? go('#/', true) : refreshDoc()));
    if (a === 'reorder') { reordering = !reordering; b.setAttribute('aria-pressed', reordering); draw(); }
    if (a === 'up' || a === 'down') {
      const j = a === 'up' ? i - 1 : i + 1;
      [doc.pageIds[i], doc.pageIds[j]] = [doc.pageIds[j], doc.pageIds[i]];
      doc.updated = Date.now(); await db.putDoc(doc); draw();
      grid.querySelector(`[data-a="${a}"][data-i="${j}"]`)?.focus();
    }
    if (a === 'view') { if (reordering) return; viewer(doc, i, refreshDoc); }
    if (a === 'add') addPagesSheet(doc);
    if (a === 'export') exportSheet(doc);
  };
}

function addPagesSheet(doc) {
  const sh = openSheet(`<h2>${t('addPages')}</h2>
    <ul class="menu"><li><button data-a="cam">${icon('camera')}${t('scan')}</button></li><li><button data-a="imp">${icon('image')}${t('import')}</button></li></ul>`);
  sh.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    closeSheet(true);
    newSession({ docId: doc.id, batch: true });
    if (a === 'cam') go('#/cam');
    else if (await importInto(session, await pickImages())) go('#/crop');
  };
}

function viewer(doc, start, onChange) {
  let i = start;
  const v = document.createElement('div');
  v.className = 'viewer studio'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true');
  v.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-a="close" aria-label="${t('close')}">${icon('close')}</button>
      <h1 class="vt"></h1>
      <button class="icon-btn" data-a="prev" aria-label="${t('back')}">${icon('back', 'flip')}</button>
      <button class="icon-btn" data-a="next" aria-label="${t('next')}">${icon('down', 'flip')}</button>
    </header>
    <div class="viewer-img"><img alt=""></div>
    <div class="tools">
      <button class="tool" data-a="edit">${icon('edit')}<span>${t('editPage')}</span></button>
      <button class="tool" data-a="share">${icon('share')}<span>${t('share')}</span></button>
      <button class="tool" data-a="del">${icon('trash')}<span>${t('deletePage')}</span></button>
    </div>`;
  document.body.append(v);
  v.animate([{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  let url;
  const show = async () => {
    const p = await db.getPage(doc.pageIds[i]);
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(p.processed);
    $('img', v).src = url;
    $('.vt', v).textContent = t('pageOf', i + 1, doc.pageIds.length);
    const one = doc.pageIds.length < 2;
    $('[data-a=prev]', v).hidden = one; $('[data-a=next]', v).hidden = one;
  };
  const close = () => { v.remove(); if (url) URL.revokeObjectURL(url); window.removeEventListener('hashchange', close); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step((e.key === 'ArrowRight') === (settings.lang !== 'ar') ? 1 : -1); };
  const step = (d) => { i = (i + d + doc.pageIds.length) % doc.pageIds.length; show(); };
  window.addEventListener('hashchange', close); document.addEventListener('keydown', key);
  // swipe between pages
  let sx = null;
  $('.viewer-img', v).addEventListener('pointerdown', (e) => { sx = e.clientX; });
  $('.viewer-img', v).addEventListener('pointerup', (e) => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 50 && doc.pageIds.length > 1) step((dx < 0) === (settings.lang !== 'ar') ? 1 : -1); });
  v.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'close') close();
    if (a === 'prev') step(-1);
    if (a === 'next') step(1);
    if (a === 'edit') { const pid = doc.pageIds[i]; close(); go(`#/page/${pid}/edit`); }
    if (a === 'share') { const p = await db.getPage(doc.pageIds[i]); await shareOrDownload([new File([p.processed], `${safeName(doc.name)}-${i + 1}.jpg`, { type: 'image/jpeg' })], doc.name); }
    if (a === 'del') {
      const pid = doc.pageIds[i];
      const page = await db.getPage(pid);
      doc.pageIds.splice(i, 1);
      await db.deletePage(pid);
      if (!doc.pageIds.length) { await db.deleteDoc(doc.id); close(); go('#/', true); toast(t('deleted')); return; }
      doc.updated = Date.now(); await db.putDoc(doc);
      const at = i;
      close(); onChange();
      toast(t('deleted'), { label: t('undo'), run: async () => { await db.putPage(page); doc.pageIds.splice(at, 0, pid); await db.putDoc(doc); onChange(); } });
    }
  };
  show();
}

/* ================= export ================= */
const safeName = (s) => (s || 'scan').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'scan';
const QUAL = { small: { max: 1600, q: 0.62 }, std: { max: 2200, q: 0.78 }, high: { max: OUT_MAX, q: 0.92 } };

async function encodePage(p, qual) {
  if (qual === 'high') return { blob: p.processed, w: p.w, h: p.h };
  const { max, q } = QUAL[qual];
  const bmp = await decode(p.processed);
  const c = drawTurned(bmp, max); bmp.close?.();
  return { blob: await toBlob(c, q), w: c.width, h: c.height };
}

/* inside the Android app, files go through the native share sheet and the Documents folder */
const native = () => window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Filesystem;
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function nativeWrite(blob, name, directory) {
  const { Filesystem } = window.Capacitor.Plugins;
  const res = await Filesystem.writeFile({ path: `Scanner74/${name}`, data: await toBase64(blob), directory, recursive: true });
  return res.uri;
}
async function shareOrDownload(files, title) {
  if (native() && window.Capacitor.Plugins.Share) {
    try {
      const uris = []; for (const f of files) uris.push(await nativeWrite(f, f.name, 'CACHE'));
      await window.Capacitor.Plugins.Share.share({ title, files: uris, dialogTitle: t('share') });
    } catch (err) { if (!/cancel/i.test(String(err?.message))) toast(t('errGeneric')); }
    return;
  }
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  if (files.length > 1) {
    const zip = await makeZip(files);
    download(zip, `${safeName(title)}.zip`);
  } else download(files[0], files[0].name);
  if (!navigator.canShare) toast(t('shareUnsupported'));
}
async function download(blob, name) {
  if (native()) {
    try { await nativeWrite(blob, name, 'DOCUMENTS'); toast(t('savedTo')); } catch { toast(t('errGeneric')); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function exportSheet(doc) {
  const st = { fmt: 'pdf', size: settings.pageSize, qual: settings.quality };
  const seg = (k, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-k="${k}" data-v="${v}" aria-pressed="${st[k] === v}">${l}</button>`).join('')}</div>`;
  const sh = openSheet(`<h2>${t('exportTitle')}</h2>
    <p>${esc(doc.name)} · ${t('pages', doc.pageIds.length)}</p>
    <div class="group"><div class="group-label">${t('format')}</div>${seg('fmt', [['pdf', t('fmtPdf')], ['jpg', t('fmtJpg')]])}</div>
    <div class="group" data-g="size"><div class="group-label">${t('pageSize')}</div>${seg('size', [['a4', t('sizeA4')], ['letter', t('sizeLetter')], ['fit', t('sizeFit')]])}</div>
    <div class="group"><div class="group-label">${t('quality')}</div>${seg('qual', [['small', t('qSmall')], ['std', t('qStd')], ['high', t('qHigh')]])}</div>
    <div class="note">${icon('check')}<span class="est">${t('noWatermark')}</span></div>
    <div class="actions"><button class="btn btn-quiet" data-a="dl">${icon('download')}${t('download')}</button><button class="btn btn-primary" data-a="share">${icon('share')}${t('share')}</button></div>`);
  const est = $('.est', sh);
  let sizes = null;
  db.getDoc(doc.id).then((d) => db.getPages(d)).then((ps) => { sizes = ps.reduce((s, p) => s + p.processed.size, 0); upd(); });
  const upd = () => {
    if (!sizes) return;
    const f = { small: 0.28, std: 0.55, high: 1 }[st.qual];
    est.textContent = `${t('noWatermark')} · ${t('estSize', fmtBytes(sizes * f))}`;
  };
  sh.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-k]');
    if (s) {
      st[s.dataset.k] = s.dataset.v;
      $$(`[data-k=${s.dataset.k}]`, sh).forEach((x) => x.setAttribute('aria-pressed', x === s));
      $('[data-g=size]', sh).hidden = st.fmt !== 'pdf';
      if (s.dataset.k === 'size') { settings.pageSize = st.size; saveSettings(); }
      if (s.dataset.k === 'qual') { settings.quality = st.qual; saveSettings(); upd(); }
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    closeSheet(true);
    busy(t('building'), 0);
    try {
      const pages = await db.getPages(await db.getDoc(doc.id));
      const enc = [];
      for (let i = 0; i < pages.length; i++) { enc.push(await encodePage(pages[i], st.qual)); busy(t('building'), (i + 1) / pages.length); }
      let files;
      if (st.fmt === 'pdf') {
        const pdfPages = await Promise.all(enc.map(async (x) => ({ jpeg: new Uint8Array(await x.blob.arrayBuffer()), width: x.w, height: x.h })));
        const pdf = buildPdf(pdfPages, { size: st.size, title: doc.name });
        files = [new File([pdf], `${safeName(doc.name)}.pdf`, { type: 'application/pdf' })];
      } else {
        files = enc.map((x, i) => new File([x.blob], `${safeName(doc.name)}-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
      }
      unbusy();
      if (a === 'share') await shareOrDownload(files, doc.name);
      else if (files.length > 1) download(await makeZip(files), `${safeName(doc.name)}.zip`);
      else download(files[0], files[0].name);
    } catch (err) { console.error(err); unbusy(); toast(t('errGeneric')); }
  });
}

/* ---------- tiny ZIP (store, no compression — JPEGs don't shrink anyway) ---------- */
const CRC = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function makeZip(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  const now = new Date(); const dosT = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1); const dosD = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer()); const name = enc.encode(f.name); const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dosT, true); h.setUint16(12, dosD, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

/* ================= settings ================= */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });

async function renderSettings() {
  const seg = (k, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-k="${k}" data-v="${v}" aria-pressed="${settings[k] === v}">${l}</button>`).join('')}</div>`;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const el = mount(`
    <header class="bar">
      <button class="icon-btn" data-a="back" aria-label="${t('back')}">${icon('back', 'flip')}</button>
      <h1>${t('settings')}</h1>
    </header>
    <div class="settings">
      <section><h2>${t('language')}</h2>${seg('lang', [['ar', 'العربية'], ['en', 'English']])}</section>
      <section><h2>${t('theme')}</h2>${seg('theme', [['system', t('themeSystem')], ['light', t('themeLight')], ['dark', t('themeDark')]])}</section>
      <section><h2>${t('defaultFilter')}</h2>${seg('defFilter', [['magic', t('f_magic')], ['enhance', t('f_enhance')], ['bw', t('f_bw')], ['original', t('f_original')]])}</section>
      <section><h2>${t('defaultSize')}</h2>${seg('pageSize', [['a4', t('sizeA4')], ['letter', t('sizeLetter')], ['fit', t('sizeFit')]])}</section>
      ${standalone ? '' : `<section><h2>${t('install')}</h2>
        ${installEvt ? `<button class="btn btn-primary" data-a="install">${icon('download')}${t('install')}</button>` : ''}
        <p>${t('installHint')}${ios ? ' ' + t('iosInstall') : ''}</p></section>`}
      <section><h2>${t('storage')}</h2><p class="st-text">…</p><div class="meter"><i></i></div>
        <div class="switch-row"><span><span>${t('persist')}</span><small class="ps"></small></span><button class="btn btn-quiet" data-a="persist">${icon('lock')}</button></div>
      </section>
      <section><button class="btn btn-quiet btn-block" data-a="erase" style="color:var(--danger)">${icon('trash')}${t('eraseAll')}</button></section>
      <section><h2>${t('about')}</h2><p>${t('aboutBody')}</p><p>${t('version')} ${VERSION}</p></section>
    </div>`);
  const refreshStorage = async () => {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      $('.st-text', el).textContent = t('storageUsed', fmtBytes(usage), fmtBytes(quota));
      $('.meter i', el).style.setProperty('--w', `${Math.max(1, (usage / (quota || 1)) * 100)}%`);
    } else $('.st-text', el).textContent = '—';
    const persisted = await navigator.storage?.persisted?.();
    $('.ps', el).textContent = persisted ? t('persistOn') : t('persistOff');
    $('[data-a=persist]', el).hidden = !!persisted || !navigator.storage?.persist;
  };
  refreshStorage();
  el.onclick = async (e) => {
    const s = e.target.closest('[data-k]');
    if (s) {
      settings[s.dataset.k] = s.dataset.v; saveSettings();
      if (s.dataset.k === 'lang' || s.dataset.k === 'theme') { applyLocale(); return renderSettings(); }
      $$(`[data-k=${s.dataset.k}]`, el).forEach((x) => x.setAttribute('aria-pressed', x === s));
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'back') history.length > 1 ? history.back() : go('#/', true);
    if (a === 'install' && installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; renderSettings(); }
    if (a === 'persist') { await navigator.storage.persist(); refreshStorage(); }
    if (a === 'erase') { if (await confirmSheet({ title: t('eraseAllQ'), body: t('eraseAllBody'), ok: t('delete') })) { await db.clearAll(); toast(t('deleted')); refreshStorage(); } }
  };
}

/* ================= boot ================= */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
