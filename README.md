# amazon-wishlist-monitor

Monitor Amazon.it wishlist prices over time. Uses the independently released **amazon-wishlist-extract** command, without copying its parsing/browser logic. The monitor is responsible for **price analysis and product tracking**, not just raw snapshots. Notifications, notification acknowledgments, Gmail, Sheets writes, scheduling and delivery policy are separate responsibilities.

## Monitoring one wishlist

Requires installed `amazon-wishlist-extract`, Node.js 26, and running `web-control 2`.

```sh
amazon-wishlist-monitor 'https://www.amazon.it/hz/wishlist/ls/<ID>' ./watch-state.json
```

The state JSON is created when absent. Every successful complete extraction updates it. Subsequent runs accept and **migrate existing v0.1.0 (v1) JSON files automatically**, preserving the prior complete history. An incomplete, blocked or failed extraction does not update the state. A different wishlist ID cannot reuse the same state file.

Under `m`:

```sh
pkg install amazon-wishlist-extract amazon-wishlist-monitor
pkg provider default web-control electron-web-control
srv start web-control
amazon-wishlist-monitor 'https://www.amazon.it/hz/wishlist/ls/<ID>' ./watch-state.json
```

## Offline HTML report (v0.3.0)

Every successful wishlist poll generates **two sibling files**:

- `watch-state.json` — authoritative price history, analytics and targets;
- `watch-state.html` — self-contained, read-only dashboard computed from that state.

```sh
amazon-wishlist-monitor 'https://www.amazon.it/hz/wishlist/ls/<ID>' ./watch-state.json
```

The HTML is refreshed after a successful poll **and** after every `target`, `note`, `baseline` or `import-sheet` command, so user-owned changes are visible without another Amazon access. An incomplete or blocked extraction does not change either file. The report displays the verified current quote, change from previous, monitored minimum, target and target gap, target state, last check, 7-/30-day trend and an optional price sparkline. It also shows active/missing/unverified distinctions, notes and expandable detailed stats. Search, filters and sorting work locally. No CSS/JS libraries, CDNs, tracking, external scripts, Google credentials or online calls are required.

To regenerate just the HTML from the saved JSON without contacting Amazon:

```sh
amazon-wishlist-monitor report ./watch-state.json
```

The HTML report is a **derived view**, not the source of product data or notification state. Its rows are deliberately read-only: edit user target/note through the public monitor CLI, not by changing the HTML. The `Target notificato` field of the legacy Google Sheet belongs to the external notification/delivery component and is not invented in this report.

State and HTML are each published by atomic rename, with the state JSON committed first as the authoritative artifact. A rare filesystem failure during HTML publication can leave the prior HTML beside the newer JSON; the command reports a failure and `report <state.json>` rebuilds the HTML without re-extracting. This is not a multi-file atomic transaction.

## Product monitoring model (JSON v2)

`amazon-wishlist-monitor/v2` has two complementary structures:

- `checks[]`: complete timestamped extraction snapshots, preserving the original ASIN membership and the verified/unverified price for **every successful check**. Previous checks are never discarded.
- `products[ASIN]`: current materialized analysis, derived deterministically from those checks and user-owned targets/notes. Products that disappear from a complete wishlist have `active:false` but retain their price history and configuration.

For each ASIN, the monitor calculates:

| Field | Meaning |
| --- | --- |
| `currentPriceCents` | Latest **verified** quote only if product is present in the latest wishlist; otherwise `null` |
| `previousVerifiedPriceCents` | Previous verified quote for the current product |
| `priceDifferenceCents`, `priceDifferencePercent` | Absolute/percentage change from previous verified quote |
| `lowestPriceCents`, `lowestPriceAt`, `lowestPriceSource` | Lowest known price, date when established by a monitor observation, and provenance |
| `lowestObservedPriceCents` | Lowest **actual extractor-observed** price |
| `highestPriceCents`, `highestPriceAt`, `averagePriceCents` | Observed maximum and sample mean (each verified observation weighted equally) |
| `lastVerifiedPriceCents`, `lastVerifiedAt` | Last known verified quote, retained even when current price is unavailable |
| `verifiedCount`, `priceChangeCount`, `lastPriceChangeAt` | Price observation/change frequency |
| `aboveMinimumCents`, `aboveMinimumPercent` | Latest price distance from lowest known price |
| `targetCents`, `targetGapCents`, `targetReached` | User-defined target and difference/status based only on verified *current* price |
| `note`, `legacyMinimumCents` | User-owned notes and imported historical minimum |
| `active`, `firstSeenAt`, `lastSeenAt`, `latestObservation` | Membership and current price-verification evidence |
| `windows['7d']`, `windows['30d']` | Recent verified sample count, min/max/average, first/last, difference and percent change |

`summary` aggregates current listed/tracked counts, verified and unavailable current quotes, targets reached/above/missing, newly discovered and no-longer-listed products. All prices are integer **EUR cents**. Percentage figures are rounded to two decimal places. Time windows are relative to the most recent successful check.

A product's current quote is **not** silently backfilled from old observations when the extractor cannot verify the latest price. Its last known verified price is preserved separately. Missing products are not treated as purchased or deleted. Historical minima imported from the legacy sheet lack a trusted observation timestamp and are marked `lowestPriceSource:'legacy-sheet'`, with `lowestPriceAt:null`.

`lastCheckedAt` is the observation time; `createdAt` and `updatedAt` describe persisted state lifecycle. No target-reached notification is emitted here; other components determine what to notify and when.

## Set target, note and historical minimum

```sh
amazon-wishlist-monitor target ./watch-state.json B012345678 390,00
amazon-wishlist-monitor note ./watch-state.json B012345678 "Attendere sconto"
amazon-wishlist-monitor baseline ./watch-state.json B012345678 375,00
```

Use `clear` as the amount to unset a target or imported baseline, or as the note text to clear a note. Target and notes survive subsequent extraction cycles. These edit operations **do not** append a price observation. Importing an historical minimum never replaces a smaller already recorded minimum with a larger value.

## Import existing Google Sheet values without depending on Google

The existing "Amazon Price Monitor" spreadsheet has the tabs **Watch** and **Star Wars**. To migrate existing targets, notes and prior monitored minima, export **each tab separately** using the Google Sheets **File → Download → Comma separated values (.csv)** command, then run:

```sh
amazon-wishlist-monitor import-sheet ./watch-state.json ./Watch.csv
```

Use `Star Wars.csv` with the separate Star Wars monitor state. This command reads the known 12-column spreadsheet schema and imports the target (F), prior minimum (E) and notes (I), without importing sheet rows as wishlist membership or writing to Google. It does not import notification acknowledgment (L), because notification delivery remains external. Product ASINs absent from the monitor's observed history are counted as skipped. The previous monitor state is not changed if import validation fails. Only use exports you trust; values are input data, not commands.

The spreadsheet remains unchanged and no online Google access is required when running the monitor. A legacy minimum is historical evidence provided by the user, not a fake Amazon observation, and is tracked separately from the lowest observed price.

## Persistence and safety

Updates are serialized by a sibling `.lock` file and committed through a sibling temporary file and atomic rename. Existing history is preserved in the new JSON document. A crash may leave a stale lock requiring operator review; no automatic unsafe lock-stealing is performed. The monitor does not produce immutable append-only filesystem logs or protect against third-party processes that ignore the lock.

A full snapshot is intentionally stored for each successful check. As history grows, JSON storage and full-history analytics may become costly; compaction/storage-engine redesign is a separate, explicit work item, not an automatic loss of historical detail.

## Development

```sh
npm test
npm run build
```

`mk.json` provides the canonical `check`, `test` and `build` lifecycle. Synthetic extraction and CSV fixtures cover state calculations and file operations; hosted integration exercises the managed CLI. These tests do not claim authenticated live Amazon.it acceptance or migration of the user's actual Sheets without a CSV export.
