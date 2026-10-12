import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'amazon-wishlist-monitor-'));
const state = path.join(temp, 'monitor.json');
const extractor = path.join(temp, 'fake-extractor');
const url = 'https://www.amazon.it/hz/wishlist/ls/SYNTHETIC123';
const first = '2026-10-12T10:00:00.000Z';
const later = '2026-10-12T14:00:00.000Z';
const make = (checkedAt, cents, extra = {}) => ({
  checkedAt, wishlistUrl: url, complete: true, blocked: false,
  completionReason: 'stable-bottom', failure: null,
  itemCount: 1, items: [{
    asin: 'B012345678', title: 'Test item',
    url: 'https://www.amazon.it/dp/B012345678',
    purchaseAction: 'add-to-cart',
    price: { verified: true, currency: 'EUR', cents }
  }], ...extra
});
try {
  await fs.writeFile(extractor,
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_EXTRACT_JSON || "");\n', { mode: 0o755 });
  const run = (obs, args = [url, state]) => spawnSync(process.execPath,
    [path.join(root, 'src', 'monitor.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, AMAZON_WISHLIST_EXTRACT_COMMAND: extractor,
        FAKE_EXTRACT_JSON: JSON.stringify(obs) }
    });
  let r = run(make(first, 3200));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).historyLength, 1);
  r = run(make(later, 2900));
  assert.equal(r.status, 0, r.stderr);
  const content = await fs.readFile(state, 'utf8');
  const history = JSON.parse(content);
  assert.equal(history.checks.length, 2);
  assert.equal(history.checks[0].items[0].price.cents, 3200);
  assert.equal(history.checks[1].items[0].price.cents, 2900);
  assert.equal(history.lastCheckedAt, later);
  r = run(make('2026-10-12T18:00:00.000Z', 10, { complete: false }));
  assert.equal(r.status, 1);
  assert.equal(await fs.readFile(state, 'utf8'), content);
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'https://www.amazon.it/hz/wishlist/ls/OTHER', state
  ]);
  assert.equal(r.status, 1);
  assert.equal(await fs.readFile(state, 'utf8'), content);
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'target', state, 'B012345678', '25,99'
  ]);
  assert.equal(r.status, 0, r.stderr);
  let edited = JSON.parse(await fs.readFile(state, 'utf8'));
  assert.equal(edited.products.B012345678.targetCents, 2599);
  assert.equal(edited.products.B012345678.targetGapCents, 301);
  assert.equal(edited.checks.length, 2);
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'note', state, 'B012345678', 'Sconto interessante'
  ]);
  assert.equal(r.status, 0, r.stderr);
  edited = JSON.parse(await fs.readFile(state, 'utf8'));
  assert.equal(edited.products.B012345678.note, 'Sconto interessante');
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'target', state, 'B012345678', 'wrong'
  ]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(await fs.readFile(state, 'utf8')).products.B012345678.targetCents, 2599);
  const headers = [
    'ASIN', 'Descrizione', 'Prezzo attuale (€)',
    'Differenza dal precedente (€)', 'Prezzo minimo monitorato (€)',
    'Target (€)', 'Scostamento (€)', 'Stato', 'Nota Amazon',
    'URL Amazon', 'Ultimo controllo', 'Target notificato (€)'
  ];
  const csv = path.join(temp, 'import.csv');
  const cells = ['B012345678', 'A product', '€ 31,00', '',
    '€ 20,00', '€ 27,50', '', '', 'Note, speciali', '', '', ''];
  const encode = c => '"' + String(c).replaceAll('"','""') + '"';
  await fs.writeFile(csv, [headers.map(encode).join(','),
    cells.map(encode).join(',')].join('\r\n') + '\r\n');
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'import-sheet', state, csv
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).imported, 1);
  edited = JSON.parse(await fs.readFile(state, 'utf8'));
  assert.equal(edited.products.B012345678.targetCents, 2750);
  assert.equal(edited.products.B012345678.lowestPriceCents, 2000);
  assert.equal(edited.products.B012345678.lowestPriceSource, 'legacy-sheet');
  assert.equal(edited.products.B012345678.note, 'Note, speciali');
  assert.equal(edited.checks.length, 2);
  r = run(make('2026-10-12T18:00:00.000Z', 10), [
    'baseline', state, 'B012345678', '18,00'
  ]);
  assert.equal(r.status, 0, r.stderr);
  edited = JSON.parse(await fs.readFile(state, 'utf8'));
  assert.equal(edited.products.B012345678.lowestPriceCents, 1800);
  const contentAfterEdits = await fs.readFile(state, 'utf8');
  const lock = state + '.lock';
  await fs.writeFile(lock, 'busy');
  r = run(make('2026-10-12T18:00:00.000Z', 10));
  assert.equal(r.status, 1);
  assert.equal(await fs.readFile(state, 'utf8'), contentAfterEdits);
  await fs.unlink(lock);
  assert.equal((await fs.stat(state)).mode & 0o077, 0);
  console.log('monitor CLI persistence: PASS');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
