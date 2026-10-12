/**
 * Materialized, deterministic product-price analysis derived from recorded checks.
 * A missing/unverified quote is never promoted into a verified current price.
 * Targets/notes are user-owned; detection and delivery of alerts are separate.
 */
const validCents = value => Number.isSafeInteger(value) && value > 0;
const roundPercent = value => Math.round(value * 10000) / 100;

function statistics(points) {
  if (!points.length) {
    return { samples: 0, minimumCents: null, maximumCents: null,
      averageCents: null, firstCents: null, lastCents: null,
      differenceCents: null, differencePercent: null };
  }
  const first = points[0].cents, last = points.at(-1).cents;
  const total = points.reduce((sum, point) => sum + point.cents, 0);
  return {
    samples: points.length,
    minimumCents: Math.min(...points.map(p => p.cents)),
    maximumCents: Math.max(...points.map(p => p.cents)),
    averageCents: Math.round(total / points.length),
    firstCents: first,
    lastCents: last,
    differenceCents: points.length > 1 ? last - first : null,
    differencePercent: points.length > 1 ? roundPercent((last - first) / first) : null
  };
}

export function projectProducts(checks, settings = {}) {
  if (!Array.isArray(checks) || !checks.length) throw new TypeError('checks required');
  const products = {};
  const observations = new Map();
  for (const check of checks) {
    for (const item of check.items) {
      if (!observations.has(item.asin)) observations.set(item.asin, []);
      observations.get(item.asin).push({ checkedAt: check.checkedAt, item });
    }
  }
  const latest = checks.at(-1);
  const present = new Set(latest.items.map(item => item.asin));
  const cutoffs = Object.fromEntries([7, 30].map(days => [
    days + 'd', Date.parse(latest.checkedAt) - days * 86400000
  ]));
  for (const asin of [...observations.keys()].sort()) {
    const series = observations.get(asin);
    const last = series.at(-1);
    const quoted = last.item.price.verified === true;
    const prices = series.filter(x => x.item.price.verified === true)
      .map(x => ({ checkedAt: x.checkedAt, cents: x.item.price.cents }));
    const recent = present.has(asin) ? last : null;
    const current = recent && quoted ? last.item.price.cents : null;
    const previous = current !== null && prices.length >= 2
      ? prices.at(-2).cents : null;
    const lowest = prices.length ? prices.reduce((a,b) => b.cents < a.cents ? b : a) : null;
    const highest = prices.length ? prices.reduce((a,b) => b.cents > a.cents ? b : a) : null;
    const recentPrice = prices.at(-1) || null;
    let changes = 0, lastChangeAt = null;
    for (let i = 1; i < prices.length; ++i) {
      if (prices[i].cents !== prices[i-1].cents) {
        changes++;
        lastChangeAt = prices[i].checkedAt;
      }
    }
    const user = settings[asin] || {};
    const target = user.targetCents ?? null;
    const gap = current !== null && target !== null ? current - target : null;
    const windows = Object.fromEntries(Object.entries(cutoffs).map(([period, cutoff]) =>
      [period, statistics(prices.filter(p => Date.parse(p.checkedAt) >= cutoff))]));
    products[asin] = {
      asin,
      title: last.item.title,
      url: last.item.url,
      purchaseAction: recent?.item.purchaseAction ?? last.item.purchaseAction,
      active: present.has(asin),
      firstSeenAt: series[0].checkedAt,
      lastSeenAt: last.checkedAt,
      observationCount: series.length,
      latestObservation: recent
        ? { checkedAt: last.checkedAt, verified: quoted, reason: quoted ? null : last.item.price.reason }
        : null,
      currentPriceCents: current,
      previousVerifiedPriceCents: previous,
      priceDifferenceCents: current !== null && previous !== null ? current - previous : null,
      priceDifferencePercent: current !== null && previous !== null
        ? roundPercent((current - previous) / previous) : null,
      lastVerifiedPriceCents: recentPrice?.cents ?? null,
      lastVerifiedAt: recentPrice?.checkedAt ?? null,
      lowestPriceCents: lowest?.cents ?? null,
      lowestPriceAt: lowest?.checkedAt ?? null,
      highestPriceCents: highest?.cents ?? null,
      highestPriceAt: highest?.checkedAt ?? null,
      averagePriceCents: prices.length
        ? Math.round(prices.reduce((sum, price) => sum + price.cents, 0) / prices.length) : null,
      verifiedCount: prices.length,
      priceChangeCount: changes,
      lastPriceChangeAt: lastChangeAt,
      aboveMinimumCents: current !== null && lowest ? current - lowest.cents : null,
      aboveMinimumPercent: current !== null && lowest
        ? roundPercent((current - lowest.cents) / lowest.cents) : null,
      targetCents: target,
      note: user.note ?? '',
      targetGapCents: gap,
      targetReached: gap === null ? null : gap <= 0,
      windows
    };
  }
  return products;
}

export function summarizeProducts(products, check) {
  const values = Object.values(products);
  const active = values.filter(p => p.active);
  return {
    checkedAt: check.checkedAt,
    listedCount: active.length,
    trackedCount: values.length,
    verifiedCurrentCount: active.filter(p => p.currentPriceCents !== null).length,
    unverifiedCurrentCount: active.filter(p => p.currentPriceCents === null).length,
    atOrBelowTargetCount: active.filter(p => p.targetReached === true).length,
    aboveTargetCount: active.filter(p => p.targetReached === false).length,
    withoutTargetCount: active.filter(p => p.targetCents === null).length,
    newProductsCount: active.filter(p => p.firstSeenAt === check.checkedAt).length,
    missingProductsCount: values.filter(p => !p.active).length
  };
}

export function validateSettings(products) {
  if (!products || typeof products !== 'object' || Array.isArray(products)) {
    throw new TypeError('invalid product state');
  }
  const settings = {};
  for (const [asin, product] of Object.entries(products)) {
    if (!/^[A-Z0-9]{10}$/.test(asin) || !product || typeof product !== 'object' ||
        (product.targetCents != null && !validCents(product.targetCents)) ||
        (product.note != null && typeof product.note !== 'string')) {
      throw new TypeError('invalid target/notes for ' + asin);
    }
    settings[asin] = {
      targetCents: product.targetCents ?? null,
      note: product.note ?? ''
    };
  }
  return settings;
}
