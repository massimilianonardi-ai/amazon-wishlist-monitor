/** Parse an exported CSV tab of the existing 12-column Amazon Price Monitor.
 * Never assumes this spreadsheet supplies wishlist membership. */
const HEADERS = [
  'ASIN', 'Descrizione', 'Prezzo attuale (€)',
  'Differenza dal precedente (€)', 'Prezzo minimo monitorato (€)',
  'Target (€)', 'Scostamento (€)', 'Stato', 'Nota Amazon',
  'URL Amazon', 'Ultimo controllo', 'Target notificato (€)'
];

function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('expected CSV content');
  const rows = [];
  let row = [], field = '', quoted = false, endedQuote = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; ++i) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i+1] === '"') { field += '"'; i++; }
        else { quoted = false; endedQuote = true; }
      } else field += c;
    } else if (c === '"' && field === '' && !endedQuote) {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = ''; endedQuote = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i+1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; endedQuote = false;
    } else if (!endedQuote && c !== '"') {
      field += c;
    } else {
      throw new TypeError('malformed CSV quoting');
    }
  }
  if (quoted) throw new TypeError('unterminated CSV quote');
  if (row.length || field !== '' || endedQuote) { row.push(field); rows.push(row); }
  return rows;
}
function euro(value, field, asin) {
  const input = String(value ?? '').trim().replace(/[\u00a0\u202f]/g, ' ').replace(/\s/g, '').replace('€', '');
  if (!input) return null;
  const num = /^\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(input)
    ? input.replace(/\./g, '').replace(',', '.')
    : /^\d+(?:[.,]\d{1,2})?$/.test(input)
      ? input.replace(',', '.') : null;
  if (num === null) throw new TypeError('invalid ' + field + ' for ' + asin);
  const valueNumber = Number(num);
  const cents = Math.round(valueNumber * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new TypeError('invalid positive ' + field + ' for ' + asin);
  }
  return cents;
}
export function readLegacySheetCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length || HEADERS.some((h,i) => rows[0]?.[i] !== h)) {
    throw new TypeError('unsupported Amazon Price Monitor CSV headers');
  }
  const seen = new Set(), results = [];
  for (const row of rows.slice(1)) {
    const asin = (row[0] || '').trim().toUpperCase();
    if (!asin && row.every(x => !x.trim())) continue;
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) {
      throw new TypeError('invalid or duplicate imported ASIN');
    }
    seen.add(asin);
    results.push({
      asin,
      legacyMinimumCents: euro(row[4], 'historical minimum', asin),
      targetCents: euro(row[5], 'target', asin),
      note: row[8] || ''
    });
  }
  return results;
}
