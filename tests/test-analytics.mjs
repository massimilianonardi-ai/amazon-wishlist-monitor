import assert from 'node:assert/strict';
import { reconcile, updateProduct, validateState, wishlistIdentity } from '../src/state.mjs';
import { projectProducts } from '../src/analytics.mjs';

const url = 'https://www.amazon.it/hz/wishlist/ls/SYNTHETIC123';
const identity = wishlistIdentity(url);
const time = [
  '2026-09-01T12:00:00.000Z',
  '2026-10-02T12:00:00.000Z',
  '2026-10-10T12:00:00.000Z',
  '2026-10-11T12:00:00.000Z',
  '2026-10-12T12:00:00.000Z'
];
const item = (asin, cents, verified = true) => ({
  asin, title: 'Example ' + asin, url: 'https://www.amazon.it/dp/' + asin,
  purchaseAction: 'add-to-cart',
  price: verified
    ? { verified: true, currency: 'EUR', cents }
    : { verified: false, reason: 'price-unavailable' }
});
const observe = (date, items) => ({
  wishlistUrl: url, checkedAt: date, complete: true, blocked: false,
  failure: null, completionReason: 'stable-bottom',
  itemCount: items.length, items
});

let state = reconcile(null, observe(time[0], [
  item('B012345678', 4000), item('B987654321', 1000)
]), url, time[0]);
assert.equal(state.format, 'amazon-wishlist-monitor/v2');
assert.equal(state.summary.listedCount, 2);
assert.equal(state.products.B012345678.lowestPriceCents, 4000);

state = updateProduct(state, url, 'B012345678',
  { targetCents: 3000, note: 'Aspettare saldi' }, time[0]);
assert.equal(state.products.B012345678.targetCents, 3000);
assert.equal(state.products.B012345678.note, 'Aspettare saldi');
assert.equal(state.checks.length, 1);
validateState(state, identity);
state = reconcile(state, observe(time[1], [
  item('B012345678', 3500), item('B987654321', 1000)
]), url, time[1]);
state = reconcile(state, observe(time[2], [
  item('B012345678', 2800), item('B987654321', 900)
]), url, time[2]);
let p = state.products.B012345678;
assert.equal(p.currentPriceCents, 2800);
assert.equal(p.previousVerifiedPriceCents, 3500);
assert.equal(p.priceDifferenceCents, -700);
assert.equal(p.priceDifferencePercent, -20);
assert.equal(p.lowestPriceCents, 2800);
assert.equal(p.highestPriceCents, 4000);
assert.equal(p.averagePriceCents, 3433);
assert.equal(p.priceChangeCount, 2);
assert.equal(p.targetGapCents, -200);
assert.equal(p.targetReached, true);
assert.equal(p.windows['7d'].samples, 1);
assert.equal(p.windows['30d'].samples, 2);
assert.equal(p.windows['30d'].differenceCents, -700);
assert.equal(state.summary.atOrBelowTargetCount, 1);
assert.equal(state.summary.verifiedCurrentCount, 2);

state = reconcile(state, observe(time[3], [
  item('B012345678', 0, false)
]), url, time[3]);
p = state.products.B012345678;
assert.equal(p.currentPriceCents, null);
assert.equal(p.lastVerifiedPriceCents, 2800);
assert.equal(p.previousVerifiedPriceCents, null);
assert.equal(p.targetReached, null);
assert.equal(p.latestObservation.reason, 'price-unavailable');
assert.equal(p.targetCents, 3000);
assert.equal(p.note, 'Aspettare saldi');
assert.equal(state.products.B987654321.active, false);
assert.equal(state.products.B987654321.currentPriceCents, null);
assert.equal(state.products.B987654321.lastVerifiedPriceCents, 900);
assert.equal(state.summary.missingProductsCount, 1);
assert.equal(state.summary.unverifiedCurrentCount, 1);

state = reconcile(state, observe(time[4], [
  item('B012345678', 2700), item('B987654321', 850)
]), url, time[4]);
p = state.products.B012345678;
assert.equal(p.previousVerifiedPriceCents, 2800);
assert.equal(p.priceDifferenceCents, -100);
assert.equal(p.targetReached, true);
assert.equal(state.products.B987654321.active, true);
assert.equal(state.checks.length, 5);
assert.equal(state.checks[0].items[0].price.cents, 4000);
validateState(state, identity);

const legacy = {
  format: 'amazon-wishlist-monitor/v1',
  wishlistUrl: identity, createdAt: time[0], updatedAt: time[0],
  checks: [state.checks[0]], lastCheckedAt: time[0]
};
validateState(legacy, identity);
const upgraded = reconcile(legacy, observe(time[1], [
  item('B012345678', 3500), item('B987654321', 1000)
]), url, time[1]);
assert.equal(upgraded.format, 'amazon-wishlist-monitor/v2');
assert.equal(upgraded.checks.length, 2);
assert.equal(upgraded.products.B012345678.priceDifferenceCents, -500);
assert.equal(legacy.format, 'amazon-wishlist-monitor/v1');
const migratedTarget = updateProduct(legacy, url, 'B012345678',
  { targetCents: 2999 }, time[1]);
assert.equal(migratedTarget.products.B012345678.targetCents, 2999);
assert.equal(migratedTarget.checks.length, 1);

assert.throws(() => updateProduct(state, url, 'B000000000',
  { targetCents: 100 }));
assert.throws(() => updateProduct(state, url, 'B012345678',
  { targetCents: -1 }));
assert.throws(() => updateProduct(state, url, 'B012345678',
  { note: 4 }));
assert.throws(() => validateState({
  ...state, products: {
    ...state.products,
    B012345678: { ...state.products.B012345678, lowestPriceCents: 1 }
  }
}, identity));
const clean = projectProducts(state.checks, {
  B012345678: { targetCents: 3000, note: 'Aspettare saldi' }
});
assert.equal(clean.B012345678.lowestPriceCents, 2700);
console.log('monitor detailed price analytics, targets and v1 migration: PASS');
