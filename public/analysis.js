// ---------- Analysen in der Verkäufe-Ansicht ----------
// Nutzt chart(), describe(), table(), eur, pct, sgn, cls, dateDe, verk, cssVar aus app.js und `sales` aus sales.js.
// Die Diagramme folgen dem gewählten Zeitraum, nicht den Filtern der Tabelle darunter.
//
// Farben: Gewinn = --good, Verlust = --bad, neutral = --muted. Grün und Rot liegen für Rot-Grün-Schwäche nah
// beieinander (Palette-Validator: ΔE 5,5 bis 7,4), deshalb steckt das Vorzeichen immer noch in einem zweiten Merkmal:
// Form (Kreis/Dreieck) im Streudiagramm, Richtung vom Nullpunkt bei den Balken, dazu Legende und Tooltips.

const eur0 = n => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const round2 = n => Math.round(n * 100) / 100;

// Nächste "runde" Obergrenze (1, 1,2, 1,5, 2, 2,5, 3, 4, 5, 6, 8 × 10^n), damit beide Achsen des Streudiagramms gleich enden
function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(k => k * p >= v) * p;
}

function anColors() {
  return { good: cssVar('--good'), bad: cssVar('--bad'), muted: cssVar('--muted'), border: cssVar('--border'), surface: cssVar('--surface') };
}

// Verkäufe je Tag zusammenfassen und fortlaufend aufsummieren
function cumulativeSeries(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.sold_date) || { day: r.sold_date, count: 0, profit: 0 };
    d.count++;
    d.profit += r.profit;
    byDay.set(r.sold_date, d);
  }
  let sum = 0;
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map(d => ({ ...d, profit: round2(d.profit), total: round2((sum += d.profit)) }));
}

function renderCumulative(rows, c) {
  const days = cumulativeSeries(rows);
  const pts = days.map(d => ({ x: dayNum(d.day), y: d.total }));
  const spanYears = new Set(days.map(d => d.day.slice(0, 4))).size > 1;
  const tickDate = v => new Date(v * 86400000).toLocaleDateString('de-DE',
    spanYears ? { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' } : { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  chart('ch-cum', {
    type: 'line',
    data: { datasets: [{ label: 'Kumulierter Gewinn', data: pts, borderColor: c.good, backgroundColor: c.good, borderWidth: 2,
      pointRadius: pts.length <= 60 ? 4 : 0, pointHoverRadius: 6, pointBorderColor: c.surface, pointBorderWidth: 1.5, tension: 0 }] },
    options: {
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: items => dateDe(days[items[0].dataIndex].day),
          label: x => { const d = days[x.dataIndex]; return [`Kumuliert: ${eur(d.total)}`, `Dieser Tag: ${sgn(d.profit)} (${verk(d.count)})`]; }
        } }
      },
      scales: {
        x: { type: 'linear', bounds: 'data', grid: { display: false }, ticks: { precision: 0, maxTicksLimit: 7, includeBounds: false, callback: v => (Number.isInteger(v) ? tickDate(v) : '') } },
        y: { ticks: { callback: v => eur0(v) }, grid: { color: ctx => (ctx.tick.value === 0 ? c.muted : c.border) } }
      }
    }
  });
  const last = days[days.length - 1], peak = Math.max(...days.map(d => d.total));
  describe('ch-cum', 'Liniendiagramm kumulierter Gewinn', [
    `${days.length} ${days.length === 1 ? 'Verkaufstag' : 'Verkaufstage'}, zuletzt am ${dateDe(last.day)}: ${eur(last.total)}`,
    `Höchststand ${eur(peak)}`, 'alle Werte stehen in der Tabelle darunter'
  ]);
  $('#cum-table').innerHTML = table(days, [
    { h: 'Tag', f: d => dateDe(d.day) },
    { h: 'Verkäufe', r: true, f: d => d.count },
    { h: 'Gewinn am Tag', r: true, f: d => `<span class="${cls(d.profit)}">${eur(d.profit)}</span>` },
    { h: 'Kumuliert', r: true, f: d => `<span class="${cls(d.total)}">${eur(d.total)}</span>` }
  ]);
}

function renderScatter(rows, c) {
  const win = rows.filter(r => r.profit >= 0), loss = rows.filter(r => r.profit < 0);
  const point = r => ({ x: r.purchase_price, y: r.sold_price, sale: r });
  const top = niceCeil(Math.max(1, ...rows.map(r => Math.max(r.purchase_price, r.sold_price))) * 1.02);
  const dots = (label, list, style, color, radius) => ({ label, data: list.map(point), pointStyle: style, pointRadius: radius, pointHoverRadius: radius + 2,
    pointHitRadius: 10, backgroundColor: color, borderColor: c.surface, borderWidth: 1.5 });
  const axis = text => ({ type: 'linear', min: 0, max: top, title: { display: true, text }, ticks: { maxTicksLimit: 6, maxRotation: 0, callback: v => eur0(v) } });
  chart('ch-scatter', {
    type: 'scatter',
    data: { datasets: [
      dots('Gewinn', win, 'circle', c.good, 5),
      ...(loss.length ? [dots('Verlust', loss, 'triangle', c.bad, 6)] : []),
      { type: 'line', label: 'Verkauf = Einkauf', data: [{ x: 0, y: 0 }, { x: top, y: top }], borderColor: c.muted, borderDash: [6, 4], borderWidth: 1.5,
        pointStyle: 'line', pointRadius: 0, pointHitRadius: 0, fill: false }
    ] },
    options: {
      aspectRatio: innerWidth < 500 ? 1 : 1.4,   // auf dem Handy höher, sonst wird das Feld winzig
      interaction: { mode: 'nearest', intersect: true },   // Standard beim Streudiagramm wäre "point": bei dicht liegenden Punkten ein Tooltip mit vielen Einträgen
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } },
        tooltip: {
          filter: x => x.raw && x.raw.sale,
          callbacks: {
            title: items => items[0].raw.sale.title,
            label: x => { const r = x.raw.sale; return [`Einkauf: ${eur(r.purchase_price)}`, `Verkauf: ${eur(r.sold_price)}`,
              `Gewinn: ${sgn(r.profit)}${r.margin != null ? ` (Marge ${pct(r.margin)})` : ''}`]; }
          }
        }
      },
      scales: { x: axis('Einkaufspreis'), y: axis('Verkaufspreis') }
    }
  });
  describe('ch-scatter', 'Streudiagramm Einkaufspreis gegen Verkaufspreis',
    [`${verk(rows.length)}`, `${win.length} mit Gewinn, ${loss.length} mit Verlust`, 'alle Einzelwerte stehen in der Tabelle weiter unten']);
}

const GROUP_LABEL = { platform: 'Plattform', category: 'Kategorie', brand: 'Marke' };
// Gewählte Gruppierung merken (nur im Browser; ohne Speicher gilt der Standard)
const anStore = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* Speicher nicht verfügbar */ } }
};
let groupKey = anStore.get('rd-sales-group', 'platform');
if (!GROUP_LABEL[groupKey]) groupKey = 'platform';

// Gewinn je Gruppe, die besten sieben einzeln, der Rest als "Weitere"
function groupRows(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const name = r[key] || 'Ohne Angabe';
    const g = m.get(name) || { name, count: 0, revenue: 0, profit: 0 };
    g.count++; g.revenue += r.sold_price; g.profit += r.profit;
    m.set(name, g);
  }
  let list = [...m.values()].sort((a, b) => b.profit - a.profit || a.name.localeCompare(b.name, 'de'));
  if (list.length > 8) {
    const rest = list.slice(7);
    list = [...list.slice(0, 7), { name: `Weitere (${rest.length})`, count: 0, revenue: 0, profit: 0 }];
    for (const g of rest) { const o = list[7]; o.count += g.count; o.revenue += g.revenue; o.profit += g.profit; }
  }
  return list.map(g => ({ ...g, profit: round2(g.profit), revenue: round2(g.revenue), margin: g.revenue ? g.profit / g.revenue : null }));
}

function renderGroup(rows, c) {
  const g = groupRows(rows, groupKey);
  chart('ch-group', {
    type: 'bar',
    data: { labels: g.map(x => x.name), datasets: [{ label: 'Gewinn', data: g.map(x => x.profit),
      backgroundColor: g.map(x => (x.profit < 0 ? c.bad : c.good)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: x => { const r = g[x.dataIndex];
          return [`Gewinn: ${eur(r.profit)}`, verk(r.count), `Ø ${eur(r.profit / r.count)} je Verkauf`, `Marge: ${pct(r.margin)}`]; } } }
      },
      scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, callback: v => eur0(v) } }, y: { grid: { display: false } } }
    }
  });
  describe('ch-group', `Balkendiagramm Gewinn nach ${GROUP_LABEL[groupKey]}`, g.map(x => `${x.name} ${eur(x.profit)}`));
  $('#group-table').innerHTML = table(g, [
    { h: GROUP_LABEL[groupKey], f: x => esc(x.name) },
    { h: 'Verkäufe', r: true, f: x => x.count },
    { h: 'Umsatz', r: true, f: x => eur(x.revenue) },
    { h: 'Gewinn', r: true, f: x => `<span class="${cls(x.profit)}">${eur(x.profit)}</span>` },
    { h: 'Marge', r: true, f: x => pct(x.margin) }
  ]);
}

function renderSalesCharts() {
  const rows = sales.sales;
  $('#sales-charts').hidden = rows.length === 0;
  if (!rows.length) {
    for (const id of ['ch-cum', 'ch-scatter', 'ch-group']) { charts[id]?.destroy(); delete charts[id]; }
    return;
  }
  const c = anColors();
  renderCumulative(rows, c);
  renderScatter(rows, c);
  $('#sc-group').value = groupKey;
  renderGroup(rows, c);
}

$('#sc-group').addEventListener('change', e => {
  groupKey = e.target.value;
  anStore.set('rd-sales-group', groupKey);
  if (sales && sales.sales.length) renderGroup(sales.sales, anColors());
});
