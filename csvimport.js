// CSV-Import: liest Artikellisten aus Excel/Numbers/Google Sheets (oder dem eigenen Export) ein.
//
//   POST /api/import.csv[?dry=1][&skipDuplicates=0]
//   Body: die CSV-Datei als Text (Content-Type: text/csv), höchstens 5 MB und 5000 Zeilen.
//
// Mit dry=1 wird nur geprüft (Vorschau); ohne dry werden alle gültigen Zeilen in einer Transaktion angelegt.
// Erkannt werden automatisch: Trennzeichen (; , Tab), Zeichensatz (UTF-8, UTF-16, Windows-1252 wie bei Excel),
// Spaltenüberschriften (deutsch/englisch, mehrere Schreibweisen), Zahlen (1.234,56 / 1,234.56 / 12,5 / "12 €"),
// Datum (TT.MM.JJJJ, JJJJ-MM-TT) und Status (auch "Noch nicht versendet", "zu versenden" usw.).
// Zeilen mit Fehlern werden übersprungen und mit Zeilennummer (wie in Excel) gemeldet.
const express = require('express');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_LIST = 200;        // so viele Fehler/Warnungen werden einzeln gemeldet, der Rest nur gezählt

// Feld -> [Anzeigename, mögliche Spaltenüberschriften]. Überschriften werden vor dem Vergleich normalisiert
// (klein, ä->ae, ö->oe, ü->ue, ß->ss, ohne Leer- und Sonderzeichen).
const COLUMNS = {
  title: ['Titel', ['titel', 'title', 'artikel', 'artikelname', 'bezeichnung', 'name', 'produkt']],
  description: ['Beschreibung', ['beschreibung', 'description']],
  size: ['Größe', ['groesse', 'size', 'konfektionsgroesse']],
  category: ['Kategorie', ['kategorie', 'category']],
  brand: ['Marke', ['marke', 'brand', 'hersteller']],
  condition: ['Zustand', ['zustand', 'condition']],
  status: ['Status', ['status']],
  purchase_price: ['Einkaufspreis', ['einkaufspreis', 'ek', 'ekpreis', 'kaufpreis', 'einkauf', 'purchaseprice']],
  purchase_date: ['Gekauft am', ['gekauftam', 'kaufdatum', 'einkaufsdatum', 'ekdatum', 'purchasedate']],
  listing_price: ['Einstellpreis', ['einstellpreis', 'angebotspreis', 'listingprice', 'listenpreis']],
  listed_date: ['Online seit', ['onlineseit', 'eingestelltam', 'einstelldatum', 'listeddate']],
  sold_price: ['Verkaufspreis', ['verkaufspreis', 'vk', 'vkpreis', 'erloes', 'soldprice']],
  sold_date: ['Verkauft am', ['verkauftam', 'verkaufsdatum', 'vkdatum', 'solddate']],
  platform: ['Plattform', ['plattform', 'platform', 'marktplatz', 'verkaufskanal']],
  buyer: ['Käufer', ['kaeufer', 'buyer', 'kunde']],
  payment_method: ['Zahlungsart', ['zahlungsart', 'zahlungsmethode', 'paymentmethod']],
  payment_status: ['Zahlungsstatus', ['zahlungsstatus', 'paymentstatus']],
  fees: ['Gebühren', ['gebuehren', 'fees', 'provision']],
  shipping_cost: ['Versandkosten', ['versandkosten', 'shippingcost', 'porto', 'versand']],
  carrier: ['Versandanbieter', ['versandanbieter', 'carrier', 'versanddienstleister']],
  tracking_number: ['Sendungsnummer', ['sendungsnummer', 'trackingnummer', 'tracking', 'sendungsnr', 'trackingnumber']],
  notes: ['Notizen', ['notizen', 'notes', 'notiz', 'bemerkung', 'anmerkung']]
};
const MONEY = ['purchase_price', 'listing_price', 'sold_price', 'fees', 'shipping_cost'];
const DATES = ['purchase_date', 'listed_date', 'sold_date'];
const TEXT_LIMIT = { title: 300 };           // alle anderen Textfelder: 5000
const DEFAULT_TEXT_LIMIT = 5000;

// Der eigene Export enthält diese Spalten zusätzlich; sie werden berechnet und beim Import nicht gebraucht.
const DERIVED = ['id', 'gewinn', 'profit', 'bilder', 'images'];

const STATUS_WORDS = {
  lager: 'lager', lagernd: 'lager',
  online: 'online', eingestellt: 'online', angeboten: 'online',
  reserviert: 'reserviert',
  zuversenden: 'zu_versenden', nochnichtversendet: 'zu_versenden', gekauft: 'zu_versenden',
  versendet: 'versendet', unterwegs: 'versendet',
  verkauft: 'verkauft', abgeschlossen: 'verkauft', sold: 'verkauft'
};
const STATUS_LABEL = { zu_versenden: 'Noch nicht versendet', versendet: 'Versendet', verkauft: 'Verkauft' };
const PAID_WORDS = { bezahlt: 'bezahlt', paid: 'bezahlt', ja: 'bezahlt', offen: 'offen', open: 'offen', unbezahlt: 'offen', nein: 'offen' };

const norm = s => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]/g, '');

const HEADER_TO_FIELD = new Map();
for (const [field, [, names]] of Object.entries(COLUMNS)) for (const n of names) HEADER_TO_FIELD.set(n, field);

class ImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------- Bytes -> Text ----------
// Windows-1252 ("ANSI") ist der Zeichensatz, in dem deutsches Excel CSV-Dateien speichert. Bytes 0x80-0x9F weichen von
// Latin-1 ab (€ „ " … usw.). Wir lösen das selbst auf, weil TextDecoder('windows-1252') je nach Node-Version und ICU-Build
// fälschlich wie Latin-1 dekodiert.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
function decodeWindows1252(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    out += String.fromCharCode(...Array.from(buf.subarray(i, i + 8192), b => (b >= 0x80 && b < 0xA0 ? CP1252_HIGH.charCodeAt(b - 0x80) : b)));
  }
  return out;
}

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) {
    throw new ImportError('Das ist eine Excel-Datei (.xlsx). Bitte in Excel „Speichern unter“ → „CSV (Trennzeichen-getrennt)“ wählen und die CSV-Datei hochladen.');
  }
  if (buf.length >= 4 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) {
    throw new ImportError('Das ist eine alte Excel-Datei (.xls). Bitte in Excel „Speichern unter“ → „CSV (Trennzeichen-getrennt)“ wählen und die CSV-Datei hochladen.');
  }
  let text, encoding;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.subarray(2, 2 + ((buf.length - 2) & ~1)).toString('utf16le'); encoding = 'UTF-16';
  } else if (buf[0] === 0xFE && buf[1] === 0xFF) {
    text = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le'); encoding = 'UTF-16';
  } else {
    const body = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? buf.subarray(3) : buf;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); encoding = 'UTF-8'; }
    catch { text = decodeWindows1252(body); encoding = 'Windows-1252'; }
  }
  if (text.includes('\u0000')) throw new ImportError('Das scheint keine Textdatei zu sein. Bitte eine CSV-Datei hochladen.');
  return { text, encoding };
}

// ---------- Text -> Zeilen ----------
function detectDelimiter(text) {
  const count = { ';': 0, '\t': 0, ',': 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ) {
      if (c === '\n' || c === '\r') break;
      if (c in count) count[c]++;
    }
  }
  // bei Gleichstand gewinnt ; vor Tab vor ,
  let best = ';';
  for (const d of [';', '\t', ',']) if (count[d] > count[best]) best = d;
  return best;
}

// Gibt [{ no, cells }] zurück; no ist die Zeilennummer wie in Excel (Kopfzeile = 1). Leere Zeilen fehlen.
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = '', inQ = false, quoted = false, no = 1;
  const endField = () => { row.push(field); field = ''; quoted = false; };
  const endRow = () => {
    endField();
    if (row.some(c => c.trim() !== '')) {
      rows.push({ no, cells: row });
      if (rows.length > MAX_ROWS + 1) throw new ImportError(`Zu viele Zeilen (höchstens ${MAX_ROWS} Artikel pro Import). Bitte die Datei aufteilen.`);
    }
    row = []; no++;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"' && field === '' && !quoted) { inQ = true; quoted = true; }
    else if (c === delimiter) endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (inQ) throw new ImportError(`In Zeile ${no} fehlt ein schließendes Anführungszeichen.`);
  if (field !== '' || row.length) endRow();
  return rows;
}

// ---------- Werte ----------
function parseMoney(raw) {
  let s = raw.replace(/\s+/g, '').replace(/€|eur(?:o)?|\$/gi, '').replace(/'/g, '');
  if (s === '') return { value: null };
  if (!/^[+-]?[\d.,]+$/.test(s)) return { error: `Betrag „${raw.trim()}“ ist keine Zahl` };
  const neg = s[0] === '-';
  s = s.replace(/^[+-]/, '');
  if (neg && Number(s.replace(/[.,]/g, '')) !== 0) return { error: `Betrag „${raw.trim()}“ darf nicht negativ sein` };
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // beides vorhanden: das letzte Zeichen ist das Komma, das andere der Tausendertrenner
    const dec = lastDot > lastComma ? '.' : ',', thou = dec === '.' ? ',' : '.';
    if (s.split(dec).length > 2 || !new RegExp(`^\\d{1,3}(\\${thou}\\d{3})*\\${dec}\\d+$`).test(s)) return { error: `Betrag „${raw.trim()}“ ist keine gültige Zahl` };
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    if (/^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');     // 1.234 oder 12,500: Tausendertrenner
    else if (s.split(sep).length > 2) return { error: `Betrag „${raw.trim()}“ ist keine gültige Zahl` };
    else s = s.replace(sep, '.');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: `Betrag „${raw.trim()}“ ist keine gültige Zahl` };
  if (/\.\d{3,}$/.test(s)) return { error: `Betrag „${raw.trim()}“ hat mehr als 2 Nachkommastellen` };
  const n = Math.round(Number(s) * 100) / 100;
  if (n > 10_000_000) return { error: `Betrag „${raw.trim()}“ ist unrealistisch hoch` };
  return { value: n };
}

function parseDate(raw, validDay) {
  const s = raw.trim();
  if (s === '') return { value: null };
  const time = '(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?';
  let y, m, d, x;
  if ((x = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}$`).exec(s))) [, y, m, d] = x;
  else if ((x = new RegExp(`^(\\d{1,2})[./](\\d{1,2})[./](\\d{4}|\\d{2})${time}$`).exec(s))) {
    [, d, m, y] = x;
    if (y.length === 2) y = '20' + y;
  } else return { error: `Datum „${s}“ nicht erkannt (erwartet TT.MM.JJJJ oder JJJJ-MM-TT)` };
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!validDay(iso)) return { error: `Datum „${s}“ gibt es nicht im Kalender` };
  if (Number(y) < 1990 || Number(y) > 2100) return { error: `Datum „${s}“ ist unplausibel` };
  return { value: iso };
}

function cleanText(raw) {
  return raw.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/^'(?=[=+\-@\t\r])/, '')          // Schutzzeichen aus dem eigenen Export wieder entfernen
    .trim();
}

// ---------- Analyse ----------
const dupKey = (title, price, date) => `${title.toLowerCase().replace(/\s+/g, ' ').trim()}|${(price ?? 0).toFixed(2)}|${date || ''}`;

// existing: Map Schlüssel -> Anzahl vorhandener Artikel mit diesem Schlüssel
function analyze(buf, { existing = new Map(), STATUSES, SOLD_STATUSES, validDay }) {
  if (!buf.length) throw new ImportError('Die Datei ist leer.');
  const { text, encoding } = decode(buf);
  // Excel schreibt manchmal eine Hinweiszeile "sep=;" an den Anfang
  const hint = /^sep=([;,\t])(?:\r\n|\r|\n)/i.exec(text);
  const body = hint ? text.slice(hint[0].length) : text;
  const delimiter = hint ? hint[1] : detectDelimiter(text);
  const records = parseCsv(body, delimiter);
  if (!records.length) throw new ImportError('Die Datei enthält keine Zeilen.');

  // Spalten zuordnen
  const header = records[0].cells.map(h => h.trim());
  const fieldAt = [], mapped = [], ignored = [];
  const used = new Set();
  header.forEach((h, i) => {
    const key = norm(h);
    const field = HEADER_TO_FIELD.get(key);
    if (field && !used.has(field)) { used.add(field); fieldAt[i] = field; mapped.push({ header: h, field, label: COLUMNS[field][0] }); }
    else if (h !== '' && (field || !DERIVED.includes(key))) ignored.push(h);   // doppelte Spalte oder unbekannte Überschrift
  });
  if (!used.has('title')) {
    const e = new ImportError('Es wurde keine Spalte „Titel“ gefunden. Die erste Zeile muss die Spaltennamen enthalten, mindestens „Titel“.');
    e.headers = header.filter(Boolean);
    throw e;
  }

  const rows = [], errors = [], warnings = [];
  let errorCount = 0, warningCount = 0, valid = 0, duplicates = 0;
  const seen = new Map();     // Schlüssel -> wie viele gültige Zeilen dieser Datei ihn schon hatten
  const addErr = (no, message) => { errorCount++; if (errors.length < MAX_LIST) errors.push({ row: no, message }); };
  const addWarn = (no, message) => { warningCount++; if (warnings.length < MAX_LIST) warnings.push({ row: no, message }); };

  for (const { no, cells } of records.slice(1)) {
    if (cells.length > header.length && cells.slice(header.length).some(c => c.trim() !== '')) {
      addErr(no, `${cells.length} Werte, aber nur ${header.length} Spalten. Steht ein Trennzeichen im Text? Dann den Text in Anführungszeichen setzen.`);
      continue;
    }
    const v = {};
    cells.forEach((c, i) => { if (fieldAt[i] && i < header.length) v[fieldAt[i]] = c; });
    const item = {};
    const problems = [];

    for (const f of Object.keys(COLUMNS)) {
      const raw = v[f];
      if (raw === undefined || raw.trim() === '') continue;
      if (MONEY.includes(f)) {
        const r = parseMoney(raw);
        if (r.error) problems.push(`${COLUMNS[f][0]}: ${r.error}`); else if (r.value !== null) item[f] = r.value;
      } else if (DATES.includes(f)) {
        const r = parseDate(raw, validDay);
        if (r.error) problems.push(`${COLUMNS[f][0]}: ${r.error}`); else if (r.value) item[f] = r.value;
      } else if (f === 'status') {
        const s = STATUS_WORDS[norm(raw)];
        if (!s || !STATUSES.includes(s)) problems.push(`Status „${raw.trim()}“ unbekannt (erlaubt: Lager, Online, Reserviert, Noch nicht versendet, Versendet, Verkauft)`);
        else item.status = s;
      } else if (f === 'payment_status') {
        const s = PAID_WORDS[norm(raw)];
        if (s) item.payment_status = s;
        else addWarn(no, `Zahlungsstatus „${raw.trim()}“ unbekannt, es gilt „offen“`);
      } else {
        const t = cleanText(raw);
        const max = TEXT_LIMIT[f] || DEFAULT_TEXT_LIMIT;
        if (t.length > max) problems.push(`${COLUMNS[f][0]} ist zu lang (${t.length} Zeichen, höchstens ${max})`);
        else if (t) item[f] = t;
      }
    }
    if (!item.title && !problems.some(p => p.startsWith('Titel'))) problems.push('Titel fehlt');
    if (problems.length) { addErr(no, problems.join('; ')); continue; }

    if (!item.status) item.status = item.sold_price != null ? 'verkauft' : 'lager';
    const soldStatus = SOLD_STATUSES.includes(item.status);
    if (soldStatus && item.sold_price == null) addWarn(no, `„${item.title}“: Status „${STATUS_LABEL[item.status]}“ ohne Verkaufspreis. Zählt erst als Verkauf, wenn ein Verkaufspreis eingetragen ist.`);
    if (!soldStatus && item.sold_price != null) addWarn(no, `„${item.title}“: Verkaufspreis ohne Verkaufsstatus. Wird nicht als Verkauf gezählt.`);
    if (soldStatus && item.sold_price != null && !item.sold_date) addWarn(no, `„${item.title}“: Verkaufsdatum fehlt. Es zählt der Tag des Imports.`);
    if (item.sold_date && item.purchase_date && item.sold_date < item.purchase_date) addWarn(no, `„${item.title}“: Verkaufsdatum liegt vor dem Kaufdatum.`);

    // Mögliche Duplikate: gleicher Titel, Einkaufspreis und Kaufdatum wie ein schon vorhandener Artikel.
    // Mehrfache gleiche Zeilen in der Datei sind erlaubt (z. B. drei gleiche Socken), werden aber gegen den Bestand abgezählt.
    const key = dupKey(item.title, item.purchase_price, item.purchase_date);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const duplicate = n <= (existing.get(key) || 0);
    valid++;
    if (duplicate) duplicates++;
    rows.push({ no, item, duplicate });
  }

  return { delimiter, encoding, mapped, ignored, total: valid + errorCount, valid, duplicates, errors, errorCount, warnings, warningCount, rows };
}

// ---------- Express ----------
module.exports = function setupImport({ app, db, FIELDS, STATUSES, SOLD_STATUSES, validDay }) {
  const DEFAULTS = { description: '', size: '', category: '', brand: '', condition: '', status: 'lager', purchase_price: 0,
    platform: '', buyer: '', payment_method: '', payment_status: 'offen', fees: 0, shipping_cost: 0, carrier: '', tracking_number: '', notes: '' };
  const insert = db.prepare(`INSERT INTO items (${FIELDS.join(',')}) VALUES (${FIELDS.map(f => '@' + f).join(',')})`);
  const insertAll = db.transaction(list => { for (const it of list) insert.run(it); });

  app.post('/api/import.csv', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Bitte die CSV-Datei als Text senden (Content-Type: text/csv).' });
    const dry = ['1', 'true'].includes(String(req.query.dry));
    const skipDuplicates = !['0', 'false'].includes(String(req.query.skipDuplicates));

    const existing = new Map();
    for (const r of db.prepare('SELECT title, purchase_price, purchase_date FROM items').all()) {
      const k = dupKey(r.title, r.purchase_price, r.purchase_date);
      existing.set(k, (existing.get(k) || 0) + 1);
    }
    let a;
    try { a = analyze(req.body, { existing, STATUSES, SOLD_STATUSES, validDay }); }
    catch (err) {
      if (err instanceof ImportError) return res.status(err.status).json({ error: err.message, ...(err.headers ? { headers: err.headers } : {}) });
      throw err;
    }

    const wanted = a.rows.filter(r => !(skipDuplicates && r.duplicate));
    const out = {
      dry, delimiter: a.delimiter === '\t' ? 'tab' : a.delimiter, encoding: a.encoding,
      columns: { mapped: a.mapped, ignored: a.ignored },
      total: a.total, valid: a.valid, duplicates: a.duplicates, skipDuplicates,
      toImport: wanted.length,
      errors: a.errors, errorCount: a.errorCount, warnings: a.warnings, warningCount: a.warningCount,
      sample: a.rows.slice(0, 8).map(r => ({ row: r.no, duplicate: r.duplicate, title: r.item.title, status: r.item.status,
        purchase_price: r.item.purchase_price ?? null, sold_price: r.item.sold_price ?? null }))
    };
    if (!dry) {
      insertAll(wanted.map(r => ({ ...Object.fromEntries(FIELDS.map(f => [f, null])), ...DEFAULTS, ...r.item })));
      out.imported = wanted.length;
      out.skippedDuplicates = skipDuplicates ? a.duplicates : 0;
      out.skippedErrors = a.errorCount;
    }
    res.json(out);
  });
};

module.exports.analyze = analyze;
module.exports.parseCsv = parseCsv;
module.exports.parseMoney = parseMoney;
module.exports.parseDate = parseDate;
module.exports.detectDelimiter = detectDelimiter;
module.exports.decode = decode;
module.exports.decodeWindows1252 = decodeWindows1252;
module.exports.dupKey = dupKey;
module.exports.ImportError = ImportError;
