import path from 'node:path';
import { validateState, wishlistIdentity } from './state.mjs';

/* Self-contained, read-only HTML derived from authoritative monitor JSON. */
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const decimal = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('it-IT', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome'
});
const esc = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = cents => cents == null ? '—' : euro.format(cents / 100);
const date = value => value ? dateFormat.format(new Date(value)) : '—';
const percentage = value => value == null ? '—' : decimal.format(value) + '%';
const signedMoney = value => value == null ? '—' :
  (value > 0 ? '+' : '') + money(value);
const signedPercent = value => value == null ? '—' :
  (value > 0 ? '+' : '') + percentage(value);

function status(product) {
  if (!product.active) return { code: 'missing', label: 'Fuori wishlist', weight: 5 };
  if (product.currentPriceCents === null) {
    return { code: 'unverified', label: 'Prezzo non verificato', weight: 4 };
  }
  if (product.targetCents === null) {
    return { code: 'no-target', label: 'Target non impostato', weight: 3 };
  }
  if (product.targetReached) return { code: 'reached', label: 'Target raggiunto', weight: 0 };
  return { code: 'above', label: 'Sopra target', weight: 2 };
}

function sparkline(series, asin) {
  const observations = series.slice(-40);
  if (!observations.length) {
    return '<span class="muted" title="Nessun prezzo verificato">—</span>';
  }
  const summary = 'Ultimi ' + observations.length + ' prezzi verificati: ' +
    money(observations[0].cents) + ' → ' + money(observations.at(-1).cents);
  const width = 104, height = 30, inset = 3;
  const values = observations.map(x => x.cents);
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const earliest = Date.parse(observations[0].at);
  const latest = Date.parse(observations.at(-1).at);
  const points = observations.map((value, index) => {
    const currentTime = Date.parse(value.at);
    const x = latest === earliest ? width / 2 :
      inset + (currentTime - earliest) / (latest - earliest) * (width - 2 * inset);
    const y = maximum === minimum ? height / 2 :
      height - inset - (value.cents - minimum) / (maximum - minimum) * (height - 2 * inset);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const drawing = observations.length === 1
    ? '<circle cx="' + points[0].split(',')[0] + '" cy="' +
        points[0].split(',')[1] + '" r="2.8"></circle>'
    : '<polyline points="' + points.join(' ') + '"></polyline>';
  return '<svg class="spark" viewBox="0 0 ' + width + ' ' + height +
    '" role="img" aria-label="' + esc('Andamento ASIN ' + asin + ': ' + summary) +
    '"><title>' + esc(summary) + '</title>' + drawing + '</svg>';
}

function rangeDetails(product) {
  const range = (label, x) => '<div class="metric"><dt>' + label +
    '</dt><dd>' + esc(money(x)) + '</dd></div>';
  const windowBlock = (label, window) =>
    '<div class="metric"><dt>' + label + '</dt><dd>' +
    esc(window.samples ? signedPercent(window.differencePercent) + ' · ' +
      window.samples + ' rilevazioni · media ' + money(window.averageCents)
      : 'Dati insufficienti') + '</dd></div>';
  return '<details class="details"><summary>Dettagli prezzi</summary><dl>' +
    range('Prezzo medio', product.averagePriceCents) +
    range('Massimo osservato', product.highestPriceCents) +
    range('Ultimo verificato', product.lastVerifiedPriceCents) +
    range('Minimo osservato', product.lowestObservedPriceCents) +
    windowBlock('Ultimi 7 giorni', product.windows['7d']) +
    windowBlock('Ultimi 30 giorni', product.windows['30d']) +
    '<div class="metric"><dt>Rilevazioni valide</dt><dd>' + product.verifiedCount +
    ' · variazioni ' + product.priceChangeCount + '</dd></div>' +
    '<div class="metric"><dt>Prima comparsa</dt><dd>' + esc(date(product.firstSeenAt)) +
    '</dd></div>' +
    '<div class="metric"><dt>Minimo noto</dt><dd>' +
    esc(product.lowestPriceSource === 'legacy-sheet'
      ? 'Importato dal foglio, data sconosciuta'
      : product.lowestPriceAt ? date(product.lowestPriceAt) : 'Non disponibile') +
    '</dd></div>' +
    '</dl></details>';
}

function itemRow(product, history) {
  const st = status(product);
  const link = 'https://www.amazon.it/dp/' + product.asin;
  const reason = product.active && product.currentPriceCents == null
    ? (product.latestObservation?.reason || 'Prezzo non verificato') : '';
  const title = product.title || 'Prodotto ' + product.asin;
  const note = product.note ? '<div class="note">' + esc(product.note) + '</div>' : '';
  const plot = sparkline(history, product.asin);
  const cell = (value, klass = '') => '<td' + (klass ? ' class="' + klass + '"' : '') +
    '>' + value + '</td>';
  const trendClass = product.priceDifferenceCents == null ? '' :
    product.priceDifferenceCents < 0 ? 'good' :
      product.priceDifferenceCents > 0 ? 'bad' : '';
  return '<tr data-status="' + st.code + '" data-search="' +
    esc((product.asin + ' ' + title + ' ' + product.note).toLocaleLowerCase('it-IT')) +
    '" data-price="' + (product.currentPriceCents ?? '') +
    '" data-target="' + (product.targetCents ?? '') +
    '" data-gap="' + (product.targetGapCents ?? '') +
    '" data-change="' + (product.priceDifferenceCents ?? '') +
    '" data-status-rank="' + st.weight +
    '" data-title="' + esc(title.toLocaleLowerCase('it-IT')) + '">' +
    cell('<div class="product"><a href="' + link +
      '" target="_blank" rel="noopener noreferrer">' + esc(title) +
      '</a><small>' + esc(product.asin) +
      (product.active ? '' : ' · Non più nella wishlist') +
      '</small>' + note + rangeDetails(product) + '</div>') +
    cell('<strong>' + esc(money(product.currentPriceCents)) + '</strong>' +
      (reason ? '<small class="warning">' + esc(reason) + '</small>' : ''), 'numeric') +
    cell('<span class="' + trendClass + '">' +
      esc(signedMoney(product.priceDifferenceCents)) +
      '<small>' + esc(signedPercent(product.priceDifferencePercent)) +
      '</small></span>', 'numeric') +
    cell(esc(money(product.lowestPriceCents)) +
      (product.lowestPriceSource === 'legacy-sheet'
        ? '<small title="Minimo importato dal foglio, data non disponibile">Da foglio</small>'
        : ''), 'numeric') +
    cell(esc(money(product.targetCents)), 'numeric') +
    cell('<span class="' + (product.targetReached ? 'good' : '') + '">' +
      esc(signedMoney(product.targetGapCents)) + '</span>', 'numeric') +
    cell('<span class="status status-' + st.code + '">' + esc(st.label) + '</span>') +
    cell(plot, 'spark-cell') +
    cell(esc(signedPercent(product.windows['7d'].differencePercent)), 'numeric') +
    cell(esc(signedPercent(product.windows['30d'].differencePercent)), 'numeric') +
    cell('<span class="date">' + esc(date(product.lastSeenAt)) + '</span>') +
    '</tr>';
}

const css = String.raw`
:root{color-scheme:light;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
--text:#1d2939;--muted:#667085;--border:#e5e7eb;--surface:#ffffff;--bg:#f5f7fb;
--green:#157f4e;--red:#b42318;--blue:#255dd9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}
main{max-width:1640px;margin:auto;padding:30px 24px 56px}
h1{font-size:clamp(23px,3vw,35px);margin:0 0 8px;font-weight:760;letter-spacing:-.025em}
.subtitle{color:var(--muted);margin:0 0 24px;line-height:1.6;overflow-wrap:anywhere}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:15px 17px}
.card span{font-size:12px;color:var(--muted);display:block}.card strong{font-size:27px;display:block;margin-top:6px;font-variant-numeric:tabular-nums}
.toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:15px}
input[type=search]{font:inherit;flex:1 1 270px;padding:11px 13px;border:1px solid #cdd5df;
border-radius:9px;background:white;color:var(--text);min-width:180px}
button{font:inherit;cursor:pointer;border:1px solid #d0d7e2;background:white;color:#344054;
border-radius:9px;padding:9px 11px}button[aria-pressed=true]{background:#e8f0ff;
border-color:#a8c6ff;color:#164dc0}button:hover{border-color:#7c97c6}
.table-scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--border);
border-radius:13px;box-shadow:0 3px 16px #1118270b}
table{width:100%;border-collapse:separate;border-spacing:0;min-width:1250px}
thead th{position:sticky;top:0;background:#f0f3f9;text-align:left;color:#475467;font-weight:650;
font-size:12px;padding:11px 12px;white-space:nowrap;border-bottom:1px solid var(--border)}
thead button{padding:0;border:0;background:none;border-radius:0;font-size:inherit;font-weight:inherit;
color:inherit}thead button:focus-visible{outline:2px solid #346ada;outline-offset:4px}
tbody td{padding:12px;border-bottom:1px solid #eef0f3;vertical-align:top;font-size:13px}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fafbfd}
tbody tr[hidden]{display:none}.product{min-width:295px;max-width:420px}.product a{color:#184cb4;
font-weight:650;text-decoration:none;line-height:1.45;display:block}
.product a:hover{text-decoration:underline}
small{display:block;font-size:11px;color:var(--muted);margin-top:5px;line-height:1.4}
.numeric{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.numeric small{text-align:right}.good{color:var(--green);font-weight:650}.bad{color:var(--red);font-weight:650}
.warning{color:#a55b0c;max-width:160px;white-space:normal}
.date{font-variant-numeric:tabular-nums;white-space:nowrap}
.status{display:inline-block;padding:5px 8px;border-radius:6px;white-space:nowrap;
background:#eef1f5;color:#525d6d;font-size:11px;font-weight:600}
.status-reached{background:#ddf7e9;color:#11693e}.status-above{background:#fff1da;color:#885300}
.status-unverified{background:#fcebdc;color:#92400e}
.status-missing{background:#edf0f5;color:#667085}
.status-no-target{background:#e9efff;color:#3356a3}
.spark-cell{text-align:center}.spark{width:104px;height:30px;stroke:#3668c8;stroke-width:2;
fill:none;stroke-linecap:round;stroke-linejoin:round;overflow:visible}
.spark circle{fill:#3668c8}.note{margin-top:7px;color:#805600;font-size:12px;white-space:normal}
.details{margin-top:8px;color:var(--muted);font-size:11px}
.details summary{cursor:pointer;display:list-item;width:max-content}
.details dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:9px 0;padding:9px;
background:#f5f7fb;border-radius:7px}
.metric{min-width:0}.metric dt{font-weight:500}.metric dd{font-weight:600;color:#344054;margin:2px 0 0}
.muted{color:var(--muted)}.footer{margin-top:17px;font-size:12px;line-height:1.6;color:var(--muted)}
.visually-hidden{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;white-space:nowrap}
@media(max-width:700px){main{padding:18px 12px 35px}.cards{grid-template-columns:repeat(2,1fr)}
.card{padding:12px}.card strong{font-size:22px}table{min-width:1190px}}
@media print{body{background:white}main{padding:0}.toolbar{display:none}.table-scroll{overflow:visible;border:0}
table{min-width:0;font-size:10px}thead th{position:static}tbody td{padding:6px}.details{display:none}}
`;

const script = String.raw`
(() => {
  const tbody = document.querySelector('#products tbody');
  const rows = [...tbody.rows];
  const search = document.querySelector('#search');
  const count = document.querySelector('#filtered-count');
  const filterButtons = [...document.querySelectorAll('[data-filter]')];
  let active = 'all';
  function refresh() {
    const query = search.value.trim().toLocaleLowerCase('it-IT');
    let visible = 0;
    for (const row of rows) {
      const matches = !query || row.dataset.search.includes(query);
      const matchesStatus = active === 'all' || row.dataset.status === active;
      row.hidden = !(matches && matchesStatus);
      if (!row.hidden) visible++;
    }
    count.textContent = visible + ' prodotti visualizzati su ' + rows.length;
  }
  search.addEventListener('input', refresh);
  for (const button of filterButtons) button.addEventListener('click', () => {
    active = button.dataset.filter;
    for (const candidate of filterButtons) {
      candidate.setAttribute('aria-pressed', String(candidate === button));
    }
    refresh();
  });
  let previousSort = '', ascending = true;
  const numericKeys = new Set(['price', 'change', 'target', 'gap', 'statusRank']);
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      ascending = previousSort === key ? !ascending : true;
      previousSort = key;
      const sorted = [...rows].sort((a, b) => {
        const av = a.dataset[key], bv = b.dataset[key];
        if (av === '' || bv === '') return av === bv ? 0 : av === '' ? 1 : -1;
        const result = numericKeys.has(key) ? Number(av) - Number(bv) :
          av.localeCompare(bv, 'it', { sensitivity: 'base' });
        return (ascending ? 1 : -1) * result;
      });
      tbody.replaceChildren(...sorted);
      rows.splice(0, rows.length, ...sorted);
      button.setAttribute('aria-label', 'Ordinato per ' + button.textContent +
        (ascending ? ' crescente' : ' decrescente'));
    });
  }
  refresh();
})();
`;

export function htmlReportPath(stateFilename) {
  const filename = path.resolve(stateFilename);
  return filename.toLocaleLowerCase('en-US').endsWith('.json')
    ? filename.slice(0, -5) + '.html' : filename + '.html';
}

export function renderHtmlReport(state) {
  if (!state || state.format !== 'amazon-wishlist-monitor/v2') {
    throw new TypeError('HTML report requires v2 monitoring state');
  }
  validateState(state, wishlistIdentity(state.wishlistUrl));
  const summaries = state.summary;
  const histories = new Map();
  for (const check of state.checks) {
    for (const item of check.items) {
      if (item.price?.verified !== true) continue;
      if (!histories.has(item.asin)) histories.set(item.asin, []);
      histories.get(item.asin).push({ at: check.checkedAt, cents: item.price.cents });
    }
  }
  const products = Object.values(state.products);
  products.sort((a, b) =>
    status(a).weight - status(b).weight ||
    (a.targetGapCents ?? Infinity) - (b.targetGapCents ?? Infinity) ||
    a.title.localeCompare(b.title, 'it', { sensitivity: 'base' }));
  const cards = [
    ['Nella wishlist', summaries.listedCount],
    ['Prezzi verificati', summaries.verifiedCurrentCount],
    ['Target raggiunti', summaries.atOrBelowTargetCount],
    ['Prezzi non verificati', summaries.unverifiedCurrentCount],
    ['Fuori wishlist', summaries.missingProductsCount]
  ].map(([label, value]) =>
    '<div class="card"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>'
  ).join('');
  const heads = [
    ['Prodotto', 'title'],
    ['Attuale', 'price'],
    ['Δ precedente', 'change'],
    ['Minimo', null],
    ['Target', 'target'],
    ['Δ target', 'gap'],
    ['Stato', 'statusRank'],
    ['Andamento', null],
    ['7 giorni', null],
    ['30 giorni', null],
    ['Ultimo controllo', null]
  ].map(([label, sort]) =>
    '<th scope="col">' + (sort ? '<button type="button" data-sort="' + sort +
      '" title="Ordina per ' + esc(label) + '">' + esc(label) + '</button>' : esc(label)) +
    '</th>').join('');
  const rows = products.map(product => itemRow(product, histories.get(product.asin) || [])).join('\n');
  const linkToWishlist = esc(state.wishlistUrl);
  const extra = state.checks.at(-1).completionReason === 'stable-bottom-spinner-markers'
    ? ' · Attenzione: il controllo si è concluso con indicatori di caricamento residui.'
    : '';
  return '<!doctype html>\n<html lang="it"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; ' +
    'script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; ' +
    'img-src &#39;none&#39;; connect-src &#39;none&#39;; object-src &#39;none&#39;; base-uri &#39;none&#39;">' +
    '<title>Amazon Price Monitor · ' + esc(date(state.lastCheckedAt)) + '</title>' +
    '<style>' + css + '</style></head><body><main>' +
    '<h1>Amazon Price Monitor</h1>' +
    '<p class="subtitle">Wishlist: <a href="' + linkToWishlist +
    '" target="_blank" rel="noopener noreferrer">Apri su Amazon.it</a>' +
    ' · Ultimo controllo: <strong>' + esc(date(state.lastCheckedAt)) +
    '</strong> (Europe/Rome) · ' + state.checks.length + ' controlli' + esc(extra) + '</p>' +
    '<section class="cards" aria-label="Riepilogo">' + cards + '</section>' +
    '<div class="toolbar" role="group" aria-label="Filtra prodotti">' +
    '<label for="search" class="visually-hidden">Cerca prodotti, ASIN o note</label>' +
    '<input id="search" type="search" placeholder="Cerca per nome, ASIN o nota…" autocomplete="off">' +
    '<button type="button" data-filter="all" aria-pressed="true">Tutti</button>' +
    '<button type="button" data-filter="reached" aria-pressed="false">Target raggiunto</button>' +
    '<button type="button" data-filter="above" aria-pressed="false">Sopra target</button>' +
    '<button type="button" data-filter="no-target" aria-pressed="false">Senza target</button>' +
    '<button type="button" data-filter="unverified" aria-pressed="false">Non verificati</button>' +
    '<button type="button" data-filter="missing" aria-pressed="false">Fuori wishlist</button>' +
    '</div><p id="filtered-count" class="muted" aria-live="polite">' +
    products.length + ' prodotti</p><div class="table-scroll">' +
    '<table id="products"><thead><tr>' + heads + '</tr></thead><tbody>' + rows +
    '</tbody></table></div><p class="footer">Importi in euro. Le variazioni confrontano ' +
    'solo prezzi verificati; i grafici mostrano fino a 40 rilevazioni verificate. ' +
    'I prezzi mancanti non vengono sostituiti con valori storici. ' +
    'Minimi importati dal foglio senza data sono indicati separatamente. ' +
    'Il report è un documento locale, senza richieste a servizi esterni; ' +
    'non invia notifiche e non modifica la wishlist Amazon.</p>' +
    '</main><script>' + script + '</script></body></html>\n';
}
