# amazon-wishlist-monitor

A deterministic, notification-free Amazon.it wishlist observation-history recorder. This project is separate from amazon-wishlist-extract: it invokes the already released extractor through its public command, never duplicates its HTML/browser implementation.

## Usage

Requires the installed amazon-wishlist-extract command, Node.js 26, and a running web-control 2 service with access to the target Amazon.it wishlist.

    amazon-wishlist-monitor 'https://www.amazon.it/hz/wishlist/ls/<ID>' /path/to/watch-state.json

The JSON state file **need not exist** on the first run. On success, stdout contains a small JSON summary; the history is kept at the supplied pathname.

For an m-managed installation:

    pkg install amazon-wishlist-extract amazon-wishlist-monitor
    pkg provider default web-control electron-web-control
    srv start web-control
    amazon-wishlist-monitor 'https://www.amazon.it/hz/wishlist/ls/<ID>' ./watch-state.json

The extractor is an independent ordinary package, **not** a facility. The catalog cannot declare it as a fake facility dependency. Both packages must be installed. The monitor does not install packages implicitly.

## State

Each successful inspection appends a complete timestamped snapshot to checks. Example:

    {
      "format": "amazon-wishlist-monitor/v1",
      "wishlistUrl": "https://www.amazon.it/hz/wishlist/ls/EXAMPLE",
      "createdAt": "2026-10-12T12:00:00.000Z",
      "checks": [
        {
          "checkedAt": "2026-10-12T12:00:00.000Z",
          "completionReason": "stable-bottom",
          "itemCount": 1,
          "items": [{
            "asin": "B012345678",
            "title": "Example",
            "url": "https://www.amazon.it/dp/B012345678",
            "purchaseAction": "add-to-cart",
            "price": {"verified": true, "currency": "EUR", "cents": 3200}
          }]
        }
      ],
      "lastCheckedAt": "2026-10-12T12:00:00.000Z",
      "updatedAt": "2026-10-12T12:00:00.000Z"
    }

* Old checks are retained unchanged; every successful poll is recorded, even with identical prices.
* Products removed from the wishlist disappear only from later snapshots; historical presence and prices remain available.
* Verified prices are positive integer euro cents. Unverified prices retain verified:false and a reason, never guessed values.
* Only complete, nonblocked, consistent extractions are accepted. A failed/partial/empty extraction, list-identity mismatch, duplicated ASIN, invalid JSON state, or stale timestamp leaves the existing state untouched.
* The extractor's stable-bottom-spinner-markers completion reason remains explicit evidence of residual uncertainty rather than being silently upgraded.
* The file is atomically replaced via a sibling temporary file for each successful append; history is **logically append-only**, not an append-only filesystem stream.
* A sibling .lock file guards against two competing monitor invocations on the same state file. A stale lock after a crash requires human or higher-level operational resolution, not automatic theft of ownership. This is cooperative locking, not protection from unrelated writers.
* Newly created state files and lock files use owner-only permissions (0600). The containing directory should also be chosen appropriately by the caller.

The createdAt and updatedAt metadata are file-history timestamps; the final lastCheckedAt records the extractor's observation time.

## Deliberate boundary

This project does not select notification thresholds, send messages, perform Gmail or Google Sheets I/O, store a delivery acknowledgment, choose a polling cadence, or contact ChatGPT. Another component can consume the JSON history and decide what, when and how to notify.

## Development and evidence

    npm test
    npm run build

The portable release is constructed by scripts/build-release.mjs. mk.json supports canonical check, test, and build goals. The CLI tests exercise real Node subprocess/file writes with a synthetic implementation of the extractor's public command. They do not claim live Amazon.it validation; the real amazon-wishlist-extract project owns the browser integration.
