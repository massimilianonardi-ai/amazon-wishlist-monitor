import { projectProducts, summarizeProducts, validateSettings } from './analytics.mjs';
const FORMAT = 'amazon-wishlist-monitor/v2';
const LEGACY = 'amazon-wishlist-monitor/v1';
const ASIN = /^[A-Z0-9]{10}$/;
function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('invalid UTC timestamp');
  }
  return value;
}
export function wishlistIdentity(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('invalid wishlist URL'); }
  if (url.protocol !== 'https:' || !/(^|\.)amazon\.it$/i.test(url.hostname)) {
    throw new TypeError('expected an HTTPS Amazon.it wishlist URL');
  }
  const match = /^\/hz\/wishlist\/ls\/([A-Za-z0-9]+)\/?$/i.exec(url.pathname);
  if (!match) throw new TypeError('expected /hz/wishlist/ls/<wishlist-id>');
  return 'https://www.amazon.it/hz/wishlist/ls/' + match[1].toUpperCase();
}
function projectItem(item) {
  if (!item || typeof item !== 'object' || !ASIN.test(item.asin)) {
    throw new TypeError('invalid wishlist ASIN');
  }
  const price = item.price;
  let projectedPrice;
  if (price?.verified === true) {
    if (price.currency !== 'EUR' || !Number.isSafeInteger(price.cents) || price.cents <= 0) {
      throw new TypeError('invalid verified EUR price for ' + item.asin);
    }
    projectedPrice = { verified: true, currency: 'EUR', cents: price.cents };
  } else {
    projectedPrice = {
      verified: false,
      reason: typeof price?.reason === 'string' && price.reason
        ? price.reason : 'price-unverified'
    };
  }
  return {
    asin: item.asin,
    title: typeof item.title === 'string' ? item.title : '',
    url: typeof item.url === 'string' ? item.url : '',
    purchaseAction: typeof item.purchaseAction === 'string'
      ? item.purchaseAction : 'unknown',
    price: projectedPrice
  };
}
function validateCheck(check) {
  if (!check || typeof check !== 'object') throw new TypeError('invalid recorded check');
  utc(check.checkedAt);
  if (!Number.isSafeInteger(check.itemCount) || check.itemCount < 1 ||
      !Array.isArray(check.items) || check.itemCount !== check.items.length ||
      typeof check.completionReason !== 'string') {
    throw new TypeError('invalid recorded item count or check');
  }
  const seen = new Set();
  for (const item of check.items) {
    const p = projectItem(item);
    if (seen.has(p.asin)) throw new TypeError('duplicate recorded ASIN ' + p.asin);
    seen.add(p.asin);
  }
}
export function validateState(state, wishlistUrl) {
  if (state === null) return;
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      ![FORMAT, LEGACY].includes(state.format) || state.wishlistUrl !== wishlistUrl ||
      !Array.isArray(state.checks) || !state.checks.length) {
    throw new TypeError('invalid existing monitor state or mismatched wishlist');
  }
  utc(state.createdAt);
  utc(state.updatedAt);
  let previous = '';
  for (const check of state.checks) {
    validateCheck(check);
    if (previous && check.checkedAt <= previous) {
      throw new TypeError('recorded checks are not strictly chronological');
    }
    previous = check.checkedAt;
  }
  if (state.lastCheckedAt !== previous) throw new TypeError('invalid lastCheckedAt');
  if (state.format === FORMAT) {
    const settings = validateSettings(state.products);
    const expected = projectProducts(state.checks, settings);
    if (JSON.stringify(state.products) !== JSON.stringify(expected) ||
        JSON.stringify(state.summary) !==
        JSON.stringify(summarizeProducts(expected, state.checks.at(-1)))) {
      throw new TypeError('inconsistent derived monitoring data');
    }
  }
}
export function reconcile(previousState, observation, wishlistUrl, updatedAt = new Date().toISOString()) {
  const identity = wishlistIdentity(wishlistUrl);
  utc(updatedAt);
  validateState(previousState, identity);
  if (!observation || typeof observation !== 'object' ||
      wishlistIdentity(observation.wishlistUrl) !== identity ||
      observation.complete !== true || observation.blocked !== false ||
      observation.failure != null ||
      !['stable-bottom', 'stable-bottom-spinner-markers'].includes(observation.completionReason) ||
      !Array.isArray(observation.items) ||
      !Number.isSafeInteger(observation.itemCount) ||
      observation.itemCount < 1 ||
      observation.items.length !== observation.itemCount) {
    throw new Error('extraction incomplete, blocked, failed or inconsistent: state unchanged');
  }
  const checkedAt = utc(observation.checkedAt);
  if (previousState && checkedAt <= previousState.lastCheckedAt) {
    throw new Error('extraction timestamp is not newer than existing history');
  }
  const seen = new Set();
  const items = observation.items.map(item => {
    const projected = projectItem(item);
    if (seen.has(projected.asin)) throw new Error('duplicate extracted ASIN ' + projected.asin);
    seen.add(projected.asin);
    return projected;
  }).sort((a, b) => a.asin.localeCompare(b.asin, 'en'));
  const check = {
    checkedAt,
    completionReason: observation.completionReason,
    itemCount: items.length,
    items
  };
  const checks = previousState ? [...previousState.checks, check] : [check];
  const settings = previousState?.format === FORMAT
    ? validateSettings(previousState.products) : {};
  const products = projectProducts(checks, settings);
  return {
    format: FORMAT,
    wishlistUrl: identity,
    createdAt: previousState?.createdAt || updatedAt,
    checks,
    products,
    summary: summarizeProducts(products, check),
    lastCheckedAt: checkedAt,
    updatedAt
  };
}


/**
 * User-owned target and annotation update. No extraction, new price observation,
 * threshold policy or delivery side effect. Also promotes legacy v1 state.
 */
export function updateProduct(state, wishlistUrl, asin, changes, updatedAt = new Date().toISOString()) {
  const identity = wishlistIdentity(wishlistUrl);
  utc(updatedAt);
  validateState(state, identity);
  if (!state || !ASIN.test(asin) || !changes || typeof changes !== 'object') {
    throw new TypeError('valid existing state, ASIN and changes required');
  }
  const currentSettings = state.format === FORMAT ? validateSettings(state.products) : {};
  const known = state.checks.some(check => check.items.some(item => item.asin === asin));
  if (!known) throw new Error('unknown monitored ASIN ' + asin);
  const next = { ...currentSettings[asin] };
  if (Object.hasOwn(changes, 'targetCents')) {
    const target = changes.targetCents;
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) {
      throw new TypeError('targetCents must be positive integer cents or null');
    }
    next.targetCents = target;
  }
  if (Object.hasOwn(changes, 'legacyMinimumCents')) {
    const minimum = changes.legacyMinimumCents;
    if (minimum !== null && (!Number.isSafeInteger(minimum) || minimum <= 0)) {
      throw new TypeError('legacyMinimumCents must be positive cents or null');
    }
    // Never replace a smaller known historic minimum with a larger value.
    next.legacyMinimumCents = minimum === null ? null :
      Math.min(minimum, next.legacyMinimumCents ?? minimum);
  }
  if (Object.hasOwn(changes, 'note')) {
    if (typeof changes.note !== 'string') throw new TypeError('note must be a string');
    next.note = changes.note;
  }
  const products = projectProducts(state.checks, { ...currentSettings, [asin]: next });
  return {
    ...state,
    format: FORMAT,
    products,
    summary: summarizeProducts(products, state.checks.at(-1)),
    updatedAt
  };
}


/** Import historical target, minimum and notes without importing membership.
 * Unknown ASINs are counted/skipped: only Amazon extraction adds products. */
export function importSettings(state, wishlistUrl, rows, updatedAt = new Date().toISOString()) {
  const identity = wishlistIdentity(wishlistUrl);
  utc(updatedAt);
  validateState(state, identity);
  if (!state || !Array.isArray(rows)) throw new TypeError('existing state and rows required');
  const currentSettings = state.format === FORMAT ? validateSettings(state.products) : {};
  const known = new Set(state.checks.flatMap(check => check.items.map(item => item.asin)));
  const changes = { ...currentSettings };
  const seen = new Set();
  let imported = 0, skipped = 0;
  for (const row of rows) {
    if (!row || !ASIN.test(row.asin) || seen.has(row.asin)) {
      throw new TypeError('invalid or duplicate imported ASIN');
    }
    seen.add(row.asin);
    if (!known.has(row.asin)) { skipped++; continue; }
    const prev = changes[row.asin] || {};
    const next = { ...prev };
    for (const field of ['targetCents', 'legacyMinimumCents']) {
      if (row[field] === null || row[field] === undefined) continue;
      if (!Number.isSafeInteger(row[field]) || row[field] <= 0) {
        throw new TypeError('invalid imported ' + field);
      }
      next[field] = field === 'legacyMinimumCents'
        ? Math.min(row[field], prev[field] ?? row[field])
        : row[field];
    }
    if (row.note) {
      if (typeof row.note !== 'string') throw new TypeError('invalid imported note');
      next.note = row.note;
    }
    changes[row.asin] = next;
    imported++;
  }
  const products = projectProducts(state.checks, changes);
  return {
    state: {
      ...state, format: FORMAT, products,
      summary: summarizeProducts(products, state.checks.at(-1)),
      updatedAt
    },
    imported, skipped
  };
}
