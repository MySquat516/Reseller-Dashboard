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

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
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
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#view-dashboard').hidden = v !== 'dashboard';
  $('#view-items').hidden = v !== 'items';
  if (v === 'dashboard') loadStats();
}

// ---------- Artikelliste ----------
async function loadItems() {
  items = await api('/api/items');
  renderItems();
  fillDatalists();
}

function renderItems() {
  const q = $('#f-search').value.toLowerCase();
  const st = $('#f-status').value;
  const list = items.filter(i =>
    (!st || i.status === st) &&
    (!q || [i.title, i.brand, i.category, i.description, i.platform].some(x => (x || '').toLowerCase().includes(q))));
  $('#items-list').innerHTML = list.length ? list.map(i => `
    <article class="item" data-id="${i.id}">
      <div class="img">${i.images[0] ? `<img loading="lazy" src="${esc(i.images[0].url)}" alt="">` : '📷'}${i.images.length > 1 ? `<span class="count">📷 ${i.images.length}</span>` : ''}</div>
      <div class="body">
        <span class="badge ${i.status}">${esc(i.status)}</span>
        <div class="title">${esc(i.title)}</div>
        <div class="meta">${esc([i.brand, i.size, i.category].filter(Boolean).join(' · '))}</div>
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
$('#items-list').addEventListener('click', e => {
  const el = e.target.closest('.item');
  if (el) openDialog(items.find(i => i.id == el.dataset.id));
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
  $('#dlg-title').textContent = item ? 'Artikel bearbeiten' : 'Neuer Artikel';
  $('#btn-delete').hidden = !item;
  if (item) {
    for (const el of form.elements) {
      if (el.name && item[el.name] != null) el.value = item[el.name];
    }
  }
  renderThumbs();
  updateProfit();
  dlg.showModal();
}

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
  if (imgs.length > room) alert(`Maximal ${MAX_IMAGES} Bilder pro Artikel – ${imgs.length - Math.max(room, 0)} Bild(er) wurden nicht übernommen.`);
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
form.addEventListener('input', updateProfit);

// Status automatisch nachziehen, wenn Verkaufspreis eingetragen wird
form.elements.sold_price.addEventListener('change', () => {
  const s = form.elements.status;
  if (form.elements.sold_price.value !== '' && ['lager', 'online'].includes(s.value)) {
    s.value = 'verkauft';
    if (!form.elements.sold_date.value) form.elements.sold_date.value = new Date().toISOString().slice(0, 10);
  }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = formData();
  const btn = form.querySelector('button[type=submit]');
  const json = { 'Content-Type': 'application/json' };
  btn.disabled = true;
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
    alert('Fehler beim Speichern: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`„${editing.title}" wirklich löschen?`)) return;
  await api('/api/items/' + editing.id, { method: 'DELETE' });
  dlg.close();
  await loadItems();
  if (!$('#view-dashboard').hidden) loadStats();
});

// ---------- Dashboard ----------
function kpi(label, value, sub = '', c = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
}

function chart(id, config) {
  charts[id]?.destroy();
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--muted').trim();
  Chart.defaults.borderColor = css.getPropertyValue('--border').trim();
  charts[id] = new Chart($('#' + id), config);
}

const PALETTE = ['#5b9dff', '#3ecf8e', '#f5b942', '#ff6b6b', '#b48cff', '#4fd1d9', '#ff9f6b', '#9aa7c2'];

function table(rows, cols) {
  if (!rows.length) return '<p class="empty">Noch keine Daten.</p>';
  return `<table><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function loadStats() {
  const s = await api('/api/stats');
  const t = s.totals;
  $('#kpis').innerHTML = [
    kpi('Gewinn', eur(t.profit), `${t.sold} verkauft`, cls(t.profit)),
    kpi('Umsatz', eur(t.revenue), `Kosten ${eur(t.cost)} + Gebühren ${eur(t.fees)}`),
    kpi('Marge', pct(t.margin), `ROI ${pct(t.roi)}`),
    kpi('Ø Gewinn / Artikel', eur(t.avgProfit)),
    kpi('Lagerwert', eur(t.stockValue), `${t.unsold} unverkauft`),
    kpi('Ø Standzeit', t.avgStandtime == null ? '–' : num1(t.avgStandtime) + ' Tage', 'online → verkauft'),
    kpi('Ø Preisabschlag', t.avgPriceDiff == null ? '–' : eur(t.avgPriceDiff), 'Verkauf vs. Einstellpreis', cls(t.avgPriceDiff)),
    kpi('Offene Zahlungen', eur(t.openPayments), 'verkauft, noch nicht bezahlt', t.openPayments > 0 ? 'neg' : '')
  ].join('');

  chart('ch-monthly', {
    type: 'bar',
    data: {
      labels: s.monthly.map(m => m.month),
      datasets: [
        { label: 'Umsatz', data: s.monthly.map(m => m.revenue), backgroundColor: PALETTE[0] },
        { label: 'Gewinn', data: s.monthly.map(m => m.profit), backgroundColor: PALETTE[1] }
      ]
    },
    options: { plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur(c.parsed.y)}` } } }, scales: { y: { ticks: { callback: v => eur(v) } } } }
  });

  chart('ch-platform', {
    type: 'bar',
    data: { labels: s.byPlatform.map(p => p.name), datasets: [{ label: 'Gewinn', data: s.byPlatform.map(p => p.profit), backgroundColor: PALETTE[0] }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => eur(c.parsed.x) + ` (${s.byPlatform[c.dataIndex].count} Verk.)` } } } }
  });

  chart('ch-payment', {
    type: 'doughnut',
    data: { labels: s.byPayment.map(p => p.name), datasets: [{ data: s.byPayment.map(p => p.count), backgroundColor: PALETTE, borderWidth: 0 }] },
    options: { plugins: { tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed} Verkäufe (${eur(s.byPayment[c.dataIndex].revenue)})` } } } }
  });

  chart('ch-category', {
    type: 'bar',
    data: { labels: s.byCategory.map(c => c.name), datasets: [{ label: 'Marge', data: s.byCategory.map(c => c.margin * 100), backgroundColor: PALETTE[2] }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => pct(c.parsed.y / 100) } } }, scales: { y: { ticks: { callback: v => v + ' %' } } } }
  });

  chart('ch-status', {
    type: 'doughnut',
    data: { labels: s.byStatus.map(x => x.name), datasets: [{ data: s.byStatus.map(x => x.count), backgroundColor: ['#8b95ab', PALETTE[0], PALETTE[1], PALETTE[2]], borderWidth: 0 }] }
  });

  $('#tbl-brand').innerHTML = table(s.byBrand.slice(0, 8), [
    { h: 'Marke', f: r => esc(r.name) },
    { h: 'Verk.', r: 1, f: r => r.count },
    { h: 'Gewinn', r: 1, f: r => `<span class="${cls(r.profit)}">${eur(r.profit)}</span>` },
    { h: 'Marge', r: 1, f: r => pct(r.margin) }
  ]);

  $('#tbl-dead').innerHTML = s.deadStock.length ? table(s.deadStock, [
    { h: 'Artikel', f: r => esc(r.title) },
    { h: 'Tage', r: 1, f: r => r.days },
    { h: 'EK', r: 1, f: r => eur(r.purchase_price) }
  ]) : '<p class="empty">Keine Ladenhüter 🎉</p>';
}

// ---------- Start ----------
loadItems().then(loadStats).catch(err => alert('Fehler beim Laden: ' + err.message));
