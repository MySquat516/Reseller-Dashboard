// ---------- Verkäufe ----------
// Nutzt Hilfsfunktionen aus app.js ($, api, eur, pct, cls, esc, kpi, dateDe, verk, period, items, openDialog, …).
let sales = null;                                  // Antwort von /api/sales
let salesSort = { key: 'sold_date', dir: -1 };     // dir: 1 aufsteigend, -1 absteigend
const salesFilter = { q: '', platform: '' };

const SALES_COLS = [
  { key: 'sold_date', h: 'Datum', f: r => dateDe(r.sold_date), v: r => r.sold_date },
  { key: 'title', h: 'Artikel', cls: 'col-title', f: r => `<button type="button" class="link" data-open="${r.id}">${esc(r.title)}</button>`, v: r => r.title.toLowerCase() },
  { key: 'platform', h: 'Plattform', opt: true, f: r => esc(r.platform || '–'), v: r => (r.platform || '').toLowerCase() },
  { key: 'purchase_price', h: 'EK', r: true, f: r => eur(r.purchase_price), v: r => r.purchase_price },
  { key: 'sold_price', h: 'VK', r: true, f: r => eur(r.sold_price), v: r => r.sold_price },
  { key: 'costs', h: 'Kosten', r: true, opt: true, f: r => eur(r.fees + r.shipping_cost), v: r => r.fees + r.shipping_cost },
  { key: 'profit', h: 'Gewinn', r: true, f: r => `<span class="${cls(r.profit)}">${eur(r.profit)}</span>`, v: r => r.profit },
  { key: 'margin', h: 'Marge', r: true, opt: true, f: r => (r.margin == null ? '–' : pct(r.margin)), v: r => r.margin ?? -Infinity },
  { key: 'standtime', h: 'Tage', r: true, opt: true, f: r => r.standtime ?? '–', v: r => r.standtime ?? -1 }
];

async function loadSales() {
  const view = $('#view-sales');
  view.setAttribute('aria-busy', 'true');
  try {
    sales = await api(`/api/sales?period=${period}`);
    syncControls();
    fillPlatformFilter();
    renderSales();
    hideMsg('load-error');
  } catch (err) {
    showLoadError(err, loadSales);
  } finally {
    view.setAttribute('aria-busy', 'false');
  }
}

function fillPlatformFilter() {
  const sel = $('#s-platform');
  const names = [...new Set(sales.sales.map(r => r.platform).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  if (salesFilter.platform && !names.includes(salesFilter.platform)) salesFilter.platform = '';
  sel.innerHTML = '<option value="">Alle Plattformen</option>' + names.map(n => `<option>${esc(n)}</option>`).join('');
  sel.value = salesFilter.platform;
}

function rankList(rows) {
  if (!rows.length) return '<p class="empty">Noch keine Daten.</p>';
  return `<ol class="rank">${rows.map(r => `
    <li><span class="t"><button type="button" class="link" data-open="${r.id}">${esc(r.title)}</button>
      <small>${dateDe(r.sold_date)}${r.platform ? ' · ' + esc(r.platform) : ''} · VK ${eur(r.sold_price)}</small></span>
      <span class="v ${cls(r.profit)}">${eur(r.profit)}</span></li>`).join('')}</ol>`;
}

function renderSales() {
  const all = sales.sales;
  const tot = sales.totals;
  $('#sales-kpis').innerHTML = [
    kpi('Verkäufe', String(tot.count), tot.count === 1 ? 'im Zeitraum' : 'im Zeitraum'),
    kpi('Umsatz', eur(tot.revenue), `Kosten ${eur(tot.cost)} + Gebühren/Versand ${eur(tot.fees)}`),
    kpi('Gewinn', eur(tot.profit), tot.revenue ? `Marge ${pct(tot.profit / tot.revenue)}` : '', cls(tot.profit)),
    kpi('Ø Gewinn / Verkauf', tot.count ? eur(tot.profit / tot.count) : '–', '', tot.count ? cls(tot.profit) : '')
  ].join('');

  const byProfit = [...all].sort((a, b) => b.profit - a.profit);
  const best = byProfit.slice(0, 5);
  const bestIds = new Set(best.map(r => r.id));
  const worst = byProfit.slice().reverse().filter(r => !bestIds.has(r.id)).slice(0, 5);
  $('#sales-best').innerHTML = rankList(best);
  $('#sales-worst').innerHTML = rankList(worst);

  const q = salesFilter.q.trim().toLowerCase();
  let rows = all.filter(r =>
    (!salesFilter.platform || r.platform === salesFilter.platform) &&
    (!q || [r.title, r.brand, r.category, r.platform].some(x => (x || '').toLowerCase().includes(q))));
  const col = SALES_COLS.find(c => c.key === salesSort.key) || SALES_COLS[0];
  rows = rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    const x = col.v(a), y = col.v(b);
    return (x < y ? -1 : x > y ? 1 : 0) * salesSort.dir || ia - ib;
  }).map(([r]) => r);

  if (!all.length) { $('#sales-table').innerHTML = '<p class="empty">Keine Verkäufe im gewählten Zeitraum.</p>'; return; }
  if (!rows.length) { $('#sales-table').innerHTML = '<p class="empty">Keine Treffer für diese Suche.</p>'; return; }

  const sum = k => rows.reduce((s, r) => s + k(r), 0);
  const revenue = sum(r => r.sold_price);
  const profit = sum(r => r.profit);
  const days = rows.filter(r => r.standtime != null);
  const footCells = {
    sold_date: '', title: `Summe (${verk(rows.length)})`, platform: '',
    purchase_price: eur(sum(r => r.purchase_price)), sold_price: eur(revenue),
    costs: eur(sum(r => r.fees + r.shipping_cost)),
    profit: `<span class="${cls(profit)}">${eur(profit)}</span>`,
    margin: revenue ? pct(profit / revenue) : '–',
    standtime: days.length ? 'Ø ' + num1(days.reduce((s, r) => s + r.standtime, 0) / days.length) : '–'
  };
  const th = c => {
    const on = salesSort.key === c.key;
    const sort = on ? (salesSort.dir === 1 ? 'ascending' : 'descending') : 'none';
    const arrow = on ? (salesSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="${c.r ? 'r' : ''} ${c.opt ? 'col-opt' : ''}" aria-sort="${sort}"><button type="button" data-sort="${c.key}">${c.h}${arrow}</button></th>`;
  };
  $('#sales-table').innerHTML = `<table>
    <thead><tr>${SALES_COLS.map(th).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr data-id="${r.id}">${SALES_COLS.map(c =>
      `<td class="${c.r ? 'r' : ''} ${c.opt ? 'col-opt' : ''} ${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr>${SALES_COLS.map(c => `<td class="${c.r ? 'r' : ''} ${c.opt ? 'col-opt' : ''}">${footCells[c.key]}</td>`).join('')}</tr></tfoot>
  </table>`;
}

function openSale(id) {
  const it = items.find(i => i.id === Number(id));
  if (it) openDialog(it);
}

$('#view-sales').addEventListener('click', e => {
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    salesSort = salesSort.key === key
      ? { key, dir: -salesSort.dir }
      : { key, dir: key === 'title' || key === 'platform' ? 1 : -1 };   // Text A→Z, Zahlen und Daten groß/neu zuerst
    renderSales();
    $('#sales-table [data-sort="' + key + '"]')?.focus();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) return openSale(open.dataset.open);
  const row = e.target.closest('#sales-table tbody tr');
  if (row) openSale(row.dataset.id);
});
$('#s-search').addEventListener('input', e => { salesFilter.q = e.target.value; if (sales) renderSales(); });
$('#s-platform').addEventListener('change', e => { salesFilter.platform = e.target.value; if (sales) renderSales(); });
