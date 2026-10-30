const $ = (s, el = document) => el.querySelector(s);
const eur = n => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const pct = n => (n == null ? '–' : (n * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' %');
const num1 = n => (n == null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 1 }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

let items = [];
let charts = {};
let editing = null;      // Artikel-Objekt oder null
let gallery = [];        // Bilder im Dialog in Reihenfolge: {id,url} (gespeichert) oder {file,url} (neu)
let removedIds = [];     // gespeicherte Bilder, die beim Speichern gelöscht werden

// ---------- Meldungen (statt alert/confirm) ----------
function showMsg(id, text, kind = 'error') {
  const el = $('#' + id);
  el.classList.toggle('info', kind === 'info');
  el.querySelector('.msg').textContent = text;
  el.hidden = false;
}
const hideMsg = id => { $('#' + id).hidden = true; };
document.addEventListener('click', e => {
  const c = e.target.closest('.banner-close');
  if (c) c.closest('.banner').hidden = true;
});

// Eigener Bestätigungsdialog für Unumkehrbares; Abbrechen ist vorausgewählt
function confirmDialog({ title, text, ok }) {
  const d = $('#dlg-confirm');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  $('#cf-ok').textContent = ok;
  return new Promise(resolve => {
    d.returnValue = 'cancel';
    const done = () => { d.removeEventListener('close', done); resolve(d.returnValue === 'ok'); };
    d.addEventListener('close', done);
    d.showModal();
    $('#cf-cancel').focus();
  });
}
$('#cf-ok').addEventListener('click', () => $('#dlg-confirm').close('ok'));
$('#cf-cancel').addEventListener('click', () => $('#dlg-confirm').close('cancel'));

async function api(url, opts = {}) {
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('Keine Verbindung zum Server'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ---------- Navigation ----------
document.querySelectorAll('.tab').forEach(b =>
  b.addEventListener('click', () => showView(b.dataset.view)));

function showView(v) {
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.view === v;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#view-dashboard').hidden = v !== 'dashboard';
  $('#view-items').hidden = v !== 'items';
  if (v === 'dashboard') loadStats();
}

// ---------- Artikelliste ----------
async function loadItems() {
  items = await api('/api/items');
  $('#items-list').setAttribute('aria-busy', 'false');
  renderItems();
  fillDatalists();
}

const STATUS_LABEL = { lager: 'Lager', online: 'Online', reserviert: 'Reserviert', zu_versenden: 'Noch nicht versendet', versendet: 'Versendet', verkauft: 'Verkauft' };

function renderItems() {
  const q = $('#f-search').value.toLowerCase();
  const st = $('#f-status').value;
  const list = items.filter(i =>
    (!st || (st === 'aktiv' ? i.status !== 'verkauft' : i.status === st)) &&
    (!q || [i.title, i.brand, i.category, i.description, i.platform].some(x => (x || '').toLowerCase().includes(q))));
  $('#items-list').innerHTML = list.length ? list.map(i => `
    <article class="item" data-id="${i.id}" tabindex="0" role="button">
      <div class="img">${i.images[0] ? `<img loading="lazy" src="${esc(i.images[0].url)}" alt="">` : '📷'}${i.images.length > 1 ? `<span class="count">📷 ${i.images.length}</span>` : ''}</div>
      <div class="body">
        <span class="badge ${i.status}">${esc(STATUS_LABEL[i.status] || i.status)}</span>
        <div class="title">${esc(i.title)}</div>
        <div class="meta">${esc([i.brand, i.size, i.category].filter(Boolean).join(' · '))}</div>
        ${i.tracking_number ? `<div class="track">📦 ${esc([i.carrier, i.tracking_number].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="price"><span>EK ${eur(i.purchase_price)}</span><span>${i.sold_price != null ? 'VK ' + eur(i.sold_price) : i.listing_price != null ? 'Angebot ' + eur(i.listing_price) : ''}</span></div>
      </div>
    </article>`).join('') : '<p class="empty">Keine Artikel gefunden.</p>';
}

function fillDatalists() {
  const uniq = k => [...new Set(items.map(i => i[k]).filter(Boolean))];
  $('#dl-category').innerHTML = uniq('category').map(v => `<option>${esc(v)}</option>`).join('');
  $('#dl-brand').innerHTML = uniq('brand').map(v => `<option>${esc(v)}</option>`).join('');
}

$('#f-search').addEventListener('input', renderItems);
$('#f-status').addEventListener('change', renderItems);
$('#items-list').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('.item[data-id]');
  if (!el || e.target !== el) return;
  e.preventDefault();
  openDialog(items.find(i => i.id == el.dataset.id));
});
$('#items-list').addEventListener('click', e => {
  const el = e.target.closest('.item');
  if (el && el.dataset.id) openDialog(items.find(i => i.id == el.dataset.id));
});

// ---------- Dialog ----------
const dlg = $('#dlg');
const form = $('#form');

$('#btn-new').addEventListener('click', () => openDialog(null));
$('#btn-cancel').addEventListener('click', () => dlg.close());

function openDialog(item) {
  editing = item;
  gallery = (item?.images || []).map(i => ({ id: i.id, url: i.url }));
  removedIds = [];
  form.reset();
  $('#dlg-title').textContent = item ? 'Bearbeiten' : 'Neuer Artikel';
  $('#btn-delete').hidden = !item;
  if (item) {
    for (const el of form.elements) {
      if (el.name && item[el.name] != null) el.value = item[el.name];
    }
  }
  renderThumbs();
  updateProfit();
  updateWarnings();
  updateTrackLink();
  hideMsg('form-error');
  $('#sale-details').open = false;
  syncSaleDetails();
  dlg.showModal();
  dlg.scrollTop = 0;
}

// „Verkauf & Versand" bleibt zu, solange der Artikel noch nicht reserviert oder verkauft ist
const SALE_STATES = ['reserviert', 'zu_versenden', 'versendet', 'verkauft'];
function syncSaleDetails() {
  const f = form.elements;
  if (SALE_STATES.includes(f.status.value) || f.sold_price.value !== '') $('#sale-details').open = true;
}
form.elements.status.addEventListener('change', syncSaleDetails);

const MAX_IMAGES = 60;

function renderThumbs() {
  $('#gallery').innerHTML = gallery.map((g, i) => `
    <div class="thumb${i === 0 ? ' cover' : ''}${g.file ? ' is-new' : ''}" draggable="true" data-i="${i}">
      <img src="${esc(g.url)}" alt="Bild ${i + 1}" draggable="false" data-open="${i}">
      ${i === 0 ? '<span class="tag">Titelbild</span>' : `<button type="button" class="star" data-cover="${i}" title="Als Titelbild setzen">★</button>`}
      <button type="button" class="x" data-rm="${i}" title="Entfernen">×</button>
    </div>`).join('');
  $('#gallery-count').textContent = gallery.length
    ? `${gallery.length} Bild${gallery.length === 1 ? '' : 'er'} · ziehen zum Sortieren, das erste ist das Titelbild`
    : '';
}

function addFiles(files) {
  const imgs = [...files].filter(f => f.type.startsWith('image/'));
  const room = MAX_IMAGES - gallery.length;
  if (imgs.length > room) showMsg('form-error', `Maximal ${MAX_IMAGES} Bilder pro Artikel – ${imgs.length - Math.max(room, 0)} Bild(er) wurden nicht übernommen.`, 'info');
  for (const f of imgs.slice(0, Math.max(room, 0))) gallery.push({ file: f, url: URL.createObjectURL(f) });
  renderThumbs();
}

// Auswählen, Ziehen und Einfügen
const dz = $('#dropzone');
dz.addEventListener('click', () => $('#files').click());
dz.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#files').click(); }
});
$('#files').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
const hasFiles = e => e.dataTransfer?.types?.includes('Files');
dlg.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); dz.classList.add('over'); } });
dlg.addEventListener('dragleave', e => { if (e.target === dlg || e.target === dz) dz.classList.remove('over'); });
dlg.addEventListener('drop', e => {
  dz.classList.remove('over');
  if (hasFiles(e)) { e.preventDefault(); addFiles(e.dataTransfer.files); }
});
dlg.addEventListener('paste', e => { if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files); });

// Sortieren per Drag-and-drop (Desktop); Titelbild-Stern funktioniert auch am Handy
let dragFrom = null;
const galleryEl = $('#gallery');
galleryEl.addEventListener('dragstart', e => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  dragFrom = +t.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});
galleryEl.addEventListener('dragover', e => { if (dragFrom !== null) e.preventDefault(); });
galleryEl.addEventListener('drop', e => {
  if (dragFrom === null) return;
  e.preventDefault();
  e.stopPropagation();
  const t = e.target.closest('.thumb');
  const to = t ? +t.dataset.i : gallery.length - 1;
  const [moved] = gallery.splice(dragFrom, 1);
  gallery.splice(to, 0, moved);
  dragFrom = null;
  renderThumbs();
});
galleryEl.addEventListener('dragend', () => { dragFrom = null; });

dlg.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  const cover = e.target.closest('[data-cover]');
  const open = e.target.closest('[data-open]');
  if (rm) {
    const [g] = gallery.splice(+rm.dataset.rm, 1);
    if (g.id) removedIds.push(g.id);
    if (g.file) URL.revokeObjectURL(g.url);
    renderThumbs();
  } else if (cover) {
    const [g] = gallery.splice(+cover.dataset.cover, 1);
    gallery.unshift(g);
    renderThumbs();
  } else if (open) {
    openLightbox(+open.dataset.open);
  }
});
dlg.addEventListener('close', () => {
  gallery.forEach(g => g.file && URL.revokeObjectURL(g.url));
});

// Großansicht
const lb = $('#lightbox');
let lbI = 0;
function showLightbox() {
  if (!gallery.length) return lb.close();
  lbI = (lbI + gallery.length) % gallery.length;
  $('#lb-img').src = gallery[lbI].url;
  $('#lb-count').textContent = `${lbI + 1} / ${gallery.length}`;
}
function openLightbox(i) { lbI = i; showLightbox(); if (!lb.open) lb.showModal(); }
const lbStep = d => { lbI += d; showLightbox(); };
$('#lb-prev').addEventListener('click', () => lbStep(-1));
$('#lb-next').addEventListener('click', () => lbStep(1));
lb.addEventListener('click', e => { if (e.target === lb || e.target.id === 'lb-close') lb.close(); });
lb.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') lbStep(-1);
  if (e.key === 'ArrowRight') lbStep(1);
});
let touchX = null;
lb.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) lbStep(dx > 0 ? -1 : 1);
}, { passive: true });

// Fotos vor dem Upload verkleinern (Handy-Fotos haben schnell 5–10 MB)
async function shrink(file, max = 1800) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 800 * 1024) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

function formData() {
  const d = {};
  for (const el of form.elements) if (el.name) d[el.name] = el.value;
  return d;
}

function updateProfit() {
  const d = formData();
  const n = k => Number(d[k]) || 0;
  const box = $('#profit-preview');
  if (d.sold_price === '') { box.textContent = 'Gewinn wird berechnet, sobald ein Verkaufspreis eingetragen ist.'; return; }
  const profit = n('sold_price') - n('purchase_price') - n('fees') - n('shipping_cost');
  const margin = n('sold_price') ? profit / n('sold_price') : 0;
  box.innerHTML = `Gewinn: <strong class="${cls(profit)}">${eur(profit)}</strong> · Marge: ${pct(margin)}`;
}
function updateWarnings() {
  const d = formData();
  const bad = d.sold_date && d.listed_date && d.sold_date < d.listed_date;
  const box = $('#date-warning');
  box.hidden = !bad;
  if (bad) box.textContent = 'Hinweis: „Verkauft am" liegt vor „Online seit". Speichern klappt, aber die Standzeit wird für diesen Artikel nicht berechnet.';
}
form.addEventListener('input', () => { updateProfit(); updateWarnings(); });

// Status automatisch nachziehen, wenn Verkaufspreis eingetragen wird
form.elements.sold_price.addEventListener('change', () => {
  const s = form.elements.status;
  if (form.elements.sold_price.value !== '' && ['lager', 'online', 'reserviert'].includes(s.value)) {
    s.value = 'zu_versenden';
    if (!form.elements.sold_date.value) form.elements.sold_date.value = new Date().toISOString().slice(0, 10);
  }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = formData();
  const btn = form.querySelector('button[type=submit]');
  const json = { 'Content-Type': 'application/json' };
  btn.disabled = true;
  hideMsg('form-error');
  try {
    let id = editing?.id;
    if (id) await api('/api/items/' + id, { method: 'PUT', headers: json, body: JSON.stringify(body) });
    else {
      id = (await api('/api/items', { method: 'POST', headers: json, body: JSON.stringify(body) })).id;
      editing = { id, images: [] };   // bei einem Fehler später nicht doppelt anlegen
    }
    while (removedIds.length) {
      await api('/api/images/' + removedIds[0], { method: 'DELETE' });
      removedIds.shift();
    }
    const fresh = gallery.filter(g => g.file);
    for (let i = 0; i < fresh.length; i += 5) {
      btn.textContent = `Lade Bilder ${Math.min(i + 5, fresh.length)}/${fresh.length} …`;
      const batch = fresh.slice(i, i + 5);
      const fd = new FormData();
      for (const g of batch) fd.append('images', await shrink(g.file));
      const res = await api(`/api/items/${id}/images`, { method: 'POST', body: fd });
      batch.forEach((g, j) => { g.id = res.ids[j]; delete g.file; });
    }
    if (gallery.length > 1) {
      await api(`/api/items/${id}/images/order`, { method: 'PUT', headers: json, body: JSON.stringify({ ids: gallery.map(g => g.id) }) });
    }
    dlg.close();
    await loadItems();
    if (!$('#view-dashboard').hidden) loadStats();
  } catch (err) {
    showMsg('form-error', 'Speichern fehlgeschlagen: ' + err.message + '. Bitte versuch es noch einmal.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editing) return;
  const n = gallery.length;
  const what = n ? `Der Artikel und ${n === 1 ? 'sein Bild werden' : `seine ${n} Bilder werden`}` : 'Der Artikel wird';
  const ok = await confirmDialog({
    title: `„${editing.title}" löschen?`,
    text: `${what} dauerhaft gelöscht. Das lässt sich nicht rückgängig machen.`,
    ok: 'Artikel löschen'
  });
  if (!ok) return;
  try {
    await api('/api/items/' + editing.id, { method: 'DELETE' });
    dlg.close();
    await loadItems();
    if (!$('#view-dashboard').hidden) loadStats();
  } catch (err) {
    showMsg('form-error', 'Löschen fehlgeschlagen: ' + err.message);
  }
});

// ---------- Versand ----------
const TRACK_URLS = {
  'dhl': 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=',
  'deutsche post': 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=',
  'dpd': 'https://tracking.dpd.de/parcelstatus?locale=de_DE&query=',
  'gls': 'https://gls-group.com/DE/de/paketverfolgung?match=',
  'ups': 'https://www.ups.com/track?tracknum=',
  'hermes': 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#'
};
function trackUrl(carrier, nr) {
  const base = TRACK_URLS[(carrier || '').trim().toLowerCase()];
  nr = (nr || '').trim();
  return base && nr ? base + encodeURIComponent(nr) : null;
}
function updateTrackLink() {
  const u = trackUrl(form.elements.carrier.value, form.elements.tracking_number.value);
  const a = $('#track-link');
  a.hidden = !u;
  if (u) a.href = u;
}
form.elements.carrier.addEventListener('input', updateTrackLink);
form.elements.tracking_number.addEventListener('input', updateTrackLink);

let presets = [];
async function loadPresets() {
  presets = await api('/api/shipping-presets');
  $('#ship-preset').innerHTML = '<option value="">– wählen –</option>'
    + presets.map(p => `<option value="${p.id}">${esc(p.name)} (${eur(p.price)})</option>`).join('');
  $('#ship-list').innerHTML = presets.length ? presets.map(p => `
    <div class="ship-row"><span class="grow"><strong>${esc(p.name)}</strong> · ${esc(p.carrier || 'kein Anbieter')} · ${eur(p.price)}</span>
      <button type="button" class="danger" data-del-preset="${p.id}">Löschen</button></div>`).join('')
    : '<p class="empty">Noch keine Vorlagen.</p>';
}
$('#ship-preset').addEventListener('change', e => {
  const p = presets.find(x => x.id == e.target.value);
  if (!p) return;
  form.elements.shipping_cost.value = p.price;
  if (p.carrier) form.elements.carrier.value = p.carrier;
  e.target.value = '';
  updateProfit(); updateTrackLink();
});
$('#btn-presets').addEventListener('click', () => $('#dlg-ship').showModal());
$('#btn-ship-close').addEventListener('click', () => $('#dlg-ship').close());
$('#ship-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  hideMsg('ship-error');
  try {
    await api('/api/shipping-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name.value, carrier: f.carrier.value, price: f.price.value }) });
    f.reset();
    await loadPresets();
  } catch (err) { showMsg('ship-error', 'Vorlage konnte nicht gespeichert werden: ' + err.message); }
});
// Löschen ist hier schnell wieder gut zu machen: kein Dialog, dafür „Rückgängig“ in der Zeile
const deletedPresets = new Map();
$('#ship-list').addEventListener('click', async e => {
  const del = e.target.closest('[data-del-preset]');
  const undo = e.target.closest('[data-undo-preset]');
  hideMsg('ship-error');
  try {
    if (del) {
      const p = presets.find(x => x.id == del.dataset.delPreset);
      await api('/api/shipping-presets/' + del.dataset.delPreset, { method: 'DELETE' });
      if (p) deletedPresets.set(String(p.id), p);
      const row = del.closest('.ship-row');
      row.classList.add('undo');
      row.innerHTML = `<span class="grow">„${esc(p?.name || 'Vorlage')}“ gelöscht</span><button type="button" data-undo-preset="${p?.id}">Rückgängig</button>`;
    } else if (undo) {
      const p = deletedPresets.get(undo.dataset.undoPreset);
      if (!p) return;
      await api('/api/shipping-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, carrier: p.carrier, price: p.price }) });
      deletedPresets.delete(undo.dataset.undoPreset);
      await loadPresets();
    }
  } catch (err) { showMsg('ship-error', 'Das hat nicht geklappt: ' + err.message); }
});

// ---------- Dashboard ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* Speicher nicht verfügbar */ } }
};
let period = store.get('rd-period', 'all');
if (!['month', '3m', 'year', 'all'].includes(period)) period = 'all';
let deadDays = Number(store.get('rd-dead', 60));
if (![30, 60, 90].includes(deadDays)) deadDays = 60;

const monthDate = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); };
const monthLabel = key => monthDate(key).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
const monthLong = key => monthDate(key).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
const sgn = n => (n > 0 ? '+' : '') + eur(n);
const dateDe = iso => iso.split('-').reverse().join('.');
const verk = n => `${n} ${n === 1 ? 'Verkauf' : 'Verkäufe'}`;

function kpi(label, value, sub = '', c = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function chart(id, config) {
  charts[id]?.destroy();
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--border');
  // Chart-Text skaliert mit der Systemschrift (rem-Basis), mindestens 12 px
  Chart.defaults.font.size = Math.max(12, Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.76));
  if (reduceMotion) Chart.defaults.animation = false;
  charts[id] = new Chart($('#' + id), config);
}

// Screenreader: Das Canvas ist ein Bild, also bekommt es eine Textfassung der Kernwerte
function describe(id, title, parts) {
  const el = $('#' + id);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', parts.length ? `${title}: ${parts.slice(0, 8).join('; ')}` : `${title}: keine Daten`);
}

function table(rows, cols, foot) {
  if (!rows.length) return '<p class="empty">Noch keine Daten.</p>';
  const tfoot = foot
    ? `<tfoot><tr>${foot.map((c, i) => `<td class="${cols[i].r ? 'r' : ''}">${c}</td>`).join('')}</tr></tfoot>`
    : '';
  return `<table><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>${tfoot}</table>`;
}

function renderMonthCard(tm) {
  const p = tm.prev;
  const delta = tm.profit - p.toDate.profit;
  let cmp;
  if (!p.full.count) {
    cmp = '<span class="muted">Kein Vergleich möglich, im Vormonat gab es keine Verkäufe.</span>';
  } else {
    const pctTxt = p.toDate.profit > 0 ? ` (${delta >= 0 ? '+' : '−'}${pct(Math.abs(delta) / p.toDate.profit)})` : '';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '●';
    cmp = `<span class="${cls(delta)}"><strong>${arrow} ${sgn(delta)}${pctTxt}</strong></span> `
      + `<span class="muted">gegenüber ${monthLong(p.month)} bis zum ${p.cutoffDay}.</span>`;
  }
  $('#month-card').innerHTML = `
    <div class="mc-main">
      <div class="mc-title">Gewinn ${monthLong(tm.month)}</div>
      <div class="mc-value ${cls(tm.profit)}">${eur(tm.profit)}</div>
      <div class="mc-sub muted">${verk(tm.count)} · Umsatz ${eur(tm.revenue)}</div>
    </div>
    <div class="mc-cmp">
      <div>${cmp}</div>
      <div class="muted">${monthLong(p.month)} gesamt: ${eur(p.full.profit)} · ${verk(p.full.count)}</div>
    </div>`;
}

function renderMonthTable(monthly) {
  const tot = monthly.reduce((a, m) => ({
    count: a.count + m.count, revenue: a.revenue + m.revenue,
    cost: a.cost + m.cost + m.fees, profit: a.profit + m.profit
  }), { count: 0, revenue: 0, cost: 0, profit: 0 });
  const cols = [
    { h: 'Monat', f: r => monthLabel(r.month) },
    { h: 'Verk.', r: 1, f: r => r.count },
    { h: 'Umsatz', r: 1, f: r => eur(r.revenue) },
    { h: 'Kosten', r: 1, f: r => eur(r.cost + r.fees) },
    { h: 'Gewinn', r: 1, f: r => `<span class="${cls(r.profit)}">${eur(r.profit)}</span>` },
    { h: 'Marge', r: 1, f: r => (r.revenue ? pct(r.profit / r.revenue) : '–') }
  ];
  const foot = ['Summe', tot.count, eur(tot.revenue), eur(tot.cost),
    `<span class="${cls(tot.profit)}">${eur(tot.profit)}</span>`, tot.revenue ? pct(tot.profit / tot.revenue) : '–'];
  $('#tbl-monthly').innerHTML = table([...monthly].reverse(), cols, foot);
}

function syncControls() {
  document.querySelectorAll('#period button').forEach(b => {
    const on = b.dataset.period === period;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#dead-days').value = String(deadDays);
}

$('#period').addEventListener('click', e => {
  const b = e.target.closest('button[data-period]');
  if (!b) return;
  period = b.dataset.period;
  store.set('rd-period', period);
  loadStats();
});
$('#dead-days').addEventListener('change', e => {
  deadDays = Number(e.target.value);
  store.set('rd-dead', String(deadDays));
  loadStats();
});

$('#kpi-toggle').addEventListener('click', () => {
  const open = $('#kpis').classList.toggle('expanded');
  $('#kpi-toggle').setAttribute('aria-expanded', open);
  $('#kpi-toggle').textContent = open ? 'Weniger Kennzahlen' : 'Mehr Kennzahlen';
});
$('#period-info').addEventListener('click', () => {
  const p = $('#period-hint'); p.hidden = !p.hidden;
  $('#period-info').setAttribute('aria-expanded', String(!p.hidden));
});

async function renderStats() {
  syncControls();
  const s = await api(`/api/stats?period=${period}&dead=${deadDays}`);
  const t = s.totals;

  $('#period-hint').textContent = (s.from ? `Zeitraum: seit ${dateDe(s.from)}. ` : 'Zeitraum: alle Verkäufe. ')
    + 'Lagerwert, Bestand und Ladenhüter zeigen immer den aktuellen Stand.';
  renderMonthCard(s.thisMonth);

  // Auf dem Handy nur die wichtigsten Kennzahlen, der Rest hinter „Mehr Kennzahlen“ (Klasse kpi-extra)
  $('#kpis').innerHTML = [
    kpi('Gewinn', eur(t.profit), `${t.sold} verkauft`, cls(t.profit)),
    kpi('Umsatz', eur(t.revenue), `Kosten ${eur(t.cost)} + Gebühren ${eur(t.fees)}`),
    kpi('Marge', pct(t.margin), `ROI ${pct(t.roi)}`),
    kpi('Lagerwert', eur(t.stockValue), `${t.unsold} unverkauft, aktuell`),
    kpi('Ø Gewinn / Artikel', eur(t.avgProfit)).replace('class="kpi"', 'class="kpi kpi-extra"'),
    kpi('Ø Standzeit', t.avgStandtime == null ? '–' : num1(t.avgStandtime) + ' Tage', 'online → verkauft').replace('class="kpi"', 'class="kpi kpi-extra"'),
    kpi('Ø Preisabschlag', t.avgPriceDiff == null ? '–' : eur(t.avgPriceDiff), 'Verkauf vs. Einstellpreis', cls(t.avgPriceDiff)).replace('class="kpi"', 'class="kpi kpi-extra"'),
    kpi('Offene Zahlungen', eur(t.openPayments), 'verkauft, noch nicht bezahlt, alle Zeiträume', t.openPayments > 0 ? 'neg' : '').replace('class="kpi"', t.openPayments > 0 ? 'class="kpi"' : 'class="kpi kpi-extra"')
  ].join('');

  // Umsatz = Akzent, Gewinn und Marge = Grün, Anzahlen = neutral. Die Variablen sind für Hell und Dunkel kontrastgeprüft
  const C = { revenue: cssVar('--accent'), profit: cssVar('--good'), count: cssVar('--muted') };

  chart('ch-monthly', {
    type: 'bar',
    data: {
      labels: s.monthly.map(m => monthLabel(m.month)),
      datasets: [
        { label: 'Umsatz', data: s.monthly.map(m => m.revenue), backgroundColor: C.revenue },
        { label: 'Gewinn', data: s.monthly.map(m => m.profit), backgroundColor: C.profit }
      ]
    },
    options: { plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur(c.parsed.y)}` } } }, scales: { y: { ticks: { callback: v => eur(v) } } } }
  });
  const lastM = s.monthly[s.monthly.length - 1];
  describe('ch-monthly', 'Balkendiagramm Umsatz und Gewinn pro Monat', lastM
    ? [`${monthLong(lastM.month)}: Umsatz ${eur(lastM.revenue)}, Gewinn ${eur(lastM.profit)}`, `${s.monthly.length} Monate insgesamt, alle Werte stehen in der Monatsübersicht`] : []);
  renderMonthTable(s.monthly);

  chart('ch-platform', {
    type: 'bar',
    data: { labels: s.byPlatform.map(p => p.name), datasets: [{ label: 'Gewinn', data: s.byPlatform.map(p => p.profit), backgroundColor: C.profit }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => eur(c.parsed.x) + ` (${s.byPlatform[c.dataIndex].count} Verk.)` } } } }
  });
  describe('ch-platform', 'Gewinn nach Plattform', s.byPlatform.map(p => `${p.name} ${eur(p.profit)}`));

  chart('ch-payment', {
    type: 'bar',
    data: { labels: s.byPayment.map(p => p.name), datasets: [{ label: 'Verkäufe', data: s.byPayment.map(p => p.count), backgroundColor: C.count }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${verk(c.parsed.x)} (${eur(s.byPayment[c.dataIndex].revenue)})` } } }, scales: { x: { ticks: { precision: 0 } } } }
  });
  describe('ch-payment', 'Zahlungsarten', s.byPayment.map(p => `${p.name} ${verk(p.count)}`));

  chart('ch-category', {
    type: 'bar',
    data: { labels: s.byCategory.map(c => c.name), datasets: [{ label: 'Marge', data: s.byCategory.map(c => c.margin * 100), backgroundColor: C.profit }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => pct(c.parsed.y / 100) } } }, scales: { y: { ticks: { callback: v => v + ' %' } } } }
  });
  describe('ch-category', 'Marge nach Kategorie', s.byCategory.map(c => `${c.name} ${pct(c.margin)}`));

  const statusName = x => STATUS_LABEL[x.name] || x.name;
  chart('ch-status', {
    type: 'bar',
    data: { labels: s.byStatus.map(statusName), datasets: [{ label: 'Artikel', data: s.byStatus.map(x => x.count), backgroundColor: C.count }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.x} Artikel` } } }, scales: { x: { ticks: { precision: 0 } } } }
  });
  describe('ch-status', 'Bestand nach Status', s.byStatus.map(x => `${statusName(x)} ${x.count}`));

  $('#tbl-brand').innerHTML = table(s.byBrand.slice(0, 8), [
    { h: 'Marke', f: r => esc(r.name) },
    { h: 'Verk.', r: 1, f: r => r.count },
    { h: 'Gewinn', r: 1, f: r => `<span class="${cls(r.profit)}">${eur(r.profit)}</span>` },
    { h: 'Marge', r: 1, f: r => pct(r.margin) }
  ]);

  $('#dead-summary').textContent = s.deadTotal
    ? `${s.deadTotal} ${s.deadTotal === 1 ? 'Artikel' : 'Artikel'} · ${eur(s.deadCapital)} gebunden`
      + (s.deadTotal > s.deadStock.length ? ` · die ältesten ${s.deadStock.length} werden angezeigt` : '')
    : '';
  $('#tbl-dead').innerHTML = s.deadStock.length ? table(s.deadStock, [
    { h: 'Artikel', f: r => esc(r.title) },
    { h: 'Tage', r: 1, f: r => r.days },
    { h: 'EK', r: 1, f: r => eur(r.purchase_price) }
  ]) : '<p class="empty">Keine Ladenhüter 🎉</p>';
}

// Während des Ladens bleibt der alte Stand sichtbar (gedimmt), statt zu verschwinden
async function loadStats() {
  const view = $('#view-dashboard');
  view.setAttribute('aria-busy', 'true');
  try {
    await renderStats();
    view.classList.add('loaded');
    view.classList.remove('failed');
    hideMsg('load-error');
  } catch (err) {
    view.classList.add('failed');   // Platzhalter nicht endlos weiter schimmern lassen
    showLoadError(err, loadStats);
  } finally {
    view.setAttribute('aria-busy', 'false');
  }
}

function showLoadError(err, retry) {
  showMsg('load-error', 'Daten konnten nicht geladen werden: ' + err.message);
  $('#load-retry').onclick = () => { hideMsg('load-error'); retry(); };
}

// ---------- Start ----------
function start() {
  loadPresets().catch(() => {});
  return loadItems().then(loadStats).catch(err => {
    const list = $('#items-list');
    list.setAttribute('aria-busy', 'false');
    if (list.querySelector('.skel-item')) list.innerHTML = '';
    $('#view-dashboard').classList.add('failed');
    $('#view-dashboard').setAttribute('aria-busy', 'false');
    showLoadError(err, start);
  });
}
start();
