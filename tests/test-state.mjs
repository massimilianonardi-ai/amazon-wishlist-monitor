import assert from 'node:assert/strict';
import { reconcile, wishlistIdentity, validateState } from '../src/state.mjs';

const url = 'https://www.amazon.it/hz/wishlist/ls/SYNTHETIC123?ref_=wl_share';
const identity = wishlistIdentity(url);
const at = '2026-10-12T12:00:00.000Z';
const price = cents => ({ verified: true, currency: 'EUR', cents });
const product = (asin, value) => ({
  asin, title: 'Example ' + asin, url: 'https://www.amazon.it/dp/' + asin,
  purchaseAction: 'add-to-cart', price: value
});
const observation = (checkedAt, items, extra = {}) => ({
  wishlistUrl: url, checkedAt, complete: true, blocked: false,
  failure: null, completionReason: 'stable-bottom',
  itemCount: items.length, items, ...extra
});
const first = reconcile(null, observation(at, [
  product('B012345678', price(3200)),
  product('B987654321', { verified: false, reason: 'price-unavailable' })
]), url, at);
assert.equal(first.wishlistUrl, identity);
assert.equal(first.checks.length, 1);
assert.equal(first.checks[0].items[1].price.reason, 'price-unavailable');
assert.equal(first.lastCheckedAt, at);
validateState(first, identity);

const later = '2026-10-12T16:00:00.000Z';
const second = reconcile(first, observation(later, [
  product('B012345678', price(2900))
]), url, later);
assert.equal(second.checks.length, 2);
assert.equal(first.checks.length, 1);
assert.equal(second.checks[0].items[0].price.cents, 3200);
assert.equal(second.checks[1].items[0].price.cents, 2900);
assert.equal(second.checks[1].itemCount, 1);
assert.equal(second.lastCheckedAt, later);

const reject = (prior, obs, address = url) =>
  assert.throws(() => reconcile(prior, obs, address, later));
reject(first, observation(later, [product('B012345678', price(10))], { complete: false }));
reject(first, observation(later, [product('B012345678', price(10))], { blocked: true }));
reject(first, observation(later, [product('B012345678', price(10))], { failure: { reason: 'page-unavailable' } }));
reject(first, observation(later, [product('B012345678', price(10))], { itemCount: 2 }));
reject(first, observation(later, [product('B012345678', price(10)), product('B012345678', price(12))]));
reject(first, observation(at, [product('B012345678', price(10))]));
reject(first, observation(later, [product('B012345678', price(10))], {
  wishlistUrl: 'https://www.amazon.it/hz/wishlist/ls/OTHER'
}));
reject(first, observation(later, [product('B012345678', { verified: true, currency: 'EUR', cents: -1 })]));
assert.throws(() => validateState({ ...first, lastCheckedAt: later }, identity));
assert.throws(() => validateState(first, wishlistIdentity('https://www.amazon.it/hz/wishlist/ls/OTHER')));
assert.throws(() => wishlistIdentity('https://example.com/hz/wishlist/ls/ABC'));
const s = reconcile(first, observation(later, [product('B012345678', price(3100))], {
  completionReason: 'stable-bottom-spinner-markers'
}), url, later);
assert.equal(s.checks[1].completionReason, 'stable-bottom-spinner-markers');
console.log('monitor state: PASS');
