import assert from 'node:assert/strict';
import { reconcile, updateProduct } from '../src/state.mjs';
import { renderHtmlReport, htmlReportPath } from '../src/report.mjs';

const url = 'https://www.amazon.it/hz/wishlist/ls/SYNTHETIC123';
const timestamp = ['2026-10-12T10:00:00.000Z', '2026-10-12T14:00:00.000Z'];
const product = (asin, title, cents, verified = true) => ({
  asin, title,
  url: 'javascript:alert(1)',  // Renderer must never trust extracted URLs.
  purchaseAction: 'add-to-cart',
  price: verified
    ? { verified: true, currency: 'EUR', cents }
    : { verified: false, reason: 'Non disponibile <img src=x onerror=alert(1)>' }
});
const obs = (date, items) => ({
  checkedAt: date, wishlistUrl: url, complete: true, blocked: false,
  failure: null, completionReason: 'stable-bottom',
  itemCount: items.length, items
});
let state = reconcile(null, obs(timestamp[0], [
  product('B012345678', 'Un prodotto <script>alert(1)</script>', 2400),
  product('B987654321', 'Senza prezzo', 0, false),
  product('B000000001', 'Rimosso in seguito', 1200)
]), url, timestamp[0]);
state = updateProduct(state, url, 'B012345678',
  { targetCents: 2600, note: 'Nota: "speciale" <img src=x onerror=alert(1)>' },
  timestamp[0]);
state = updateProduct(state, url, 'B987654321', { targetCents: 999 }, timestamp[0]);
state = reconcile(state, obs(timestamp[1], [
  product('B012345678', 'Un prodotto <script>alert(1)</script>', 2300),
  product('B987654321', 'Senza prezzo', 0, false),
  product('B000000002', 'Nessun target', 3000)
]), url, timestamp[1]);
const html = renderHtmlReport(state);
assert.match(html, /^<!doctype html>/);
assert.match(html, /<html lang="it">/);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /Amazon Price Monitor/);
for (const text of ['Prezzo non verificato','Fuori wishlist','Target raggiunto',
  'Target non impostato','Δ precedente','Minimo','Target','Δ target',
  '7 giorni','30 giorni','Ultimo controllo','Dettagli prezzi','Apri su Amazon.it']) {
  assert.ok(html.includes(text), 'missing HTML label ' + text);
}
assert.match(html, /data-status="reached"/);
assert.match(html, /data-status="unverified"/);
assert.match(html, /data-status="no-target"/);
assert.match(html, /data-status="missing"/);
assert.ok(html.includes('€'), 'prices should be localized');
assert.match(html, /data-sort="price"/);
assert.match(html, /id="search"/);
assert.match(html, /<svg class="spark"/);
assert.match(html, /href="https:\/\/www\.amazon\.it\/dp\/B012345678"/);
assert.ok(!html.includes('href="javascript:'), 'untrusted product URL leaked');
assert.ok(!html.includes('<script>alert(1)</script>'), 'script injection leaked');
assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'HTML injection leaked');
assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.match(html, /data-filter="reached"/);
assert.equal(htmlReportPath('/tmp/watch-state.json'), '/tmp/watch-state.html');
assert.equal(htmlReportPath('/tmp/watch-state'), '/tmp/watch-state.html');
assert.throws(() => renderHtmlReport({}), TypeError);
console.log('monitor standalone HTML dashboard: PASS');
