# ERRORLOG — the living defect registry

This file is the durable errors log for EVENTQUANT Terminal, tracked on
GitHub so every found defect, its diagnosis and its fixing commit are
permanent history. It is fed from two directions:

1. **Runtime capture** — every caught failure in the scanner / foundry /
   autopilot / strategy pipeline lands in the runtime error log
   (`src/server/errorLog.ts`, surfaced at `GET /api/errors` and on
   `/foundry`), deduped with counts. Recurring or diagnosed entries graduate
   into this file.
2. **Code review** — findings from review sweeps are recorded here with a
   severity, the concrete failure scenario, and their status.

Workflow: new row (status `open`) → diagnose → fix → row gets the fixing
commit hash and flips to `fixed`. Rows judged not-a-bug flip to `invalid`
with the reason. Rows are never deleted.

Severity: **critical** = wrong trading decisions, data corruption, or gate
bypass; **major** = wrong numbers/behavior a user would act on; **minor** =
degraded honesty/UX with a safe fallback.

## Open

| id | found | severity | area | description | status |
|----|-------|----------|------|-------------|--------|
| E-030 | 2026-07-05 | major | prisma store | `setJsonSetting` find-then-create races under concurrency, and Postgres treats NULL userId as distinct in the `@@unique([userId,key])` index → duplicate `kv:*`/`account:*` rows possible on the prisma driver; `adjustCash` is a non-atomic read-modify-write there (memory driver unaffected). Needs upsert on a non-null key + transactional increment (schema migration). PrismaStore contract tests are the tracked backlog item. | open |
| E-031 | 2026-07-05 | major | live portfolio | Live portfolio hard-codes `cash: 0` (no venue balance adapter), so every live BUY is structurally blocked by `cash_available`. Fail-CLOSED (safe direction) but means the live entry pipeline cannot function until a venue balance adapter exists; the per-intent reason string is the only surfacing. | open |
| E-032 | 2026-07-05 | major | execution | `confirmLiveIntent` re-checks the live gate and (since a343c22) intent expiry, but does not RE-RUN the full risk assessment at confirm time — an intent confirmed within its TTL uses its creation-time sizing/exposure evaluation. | open |
| E-033 | 2026-07-05 | minor | exposure cache | Intra-tick exposure race: `invalidateExposure` refreshes asynchronously, so two same-tick autopilot entries can both pass `cash_available` against pre-fill state. Partially mitigated by the tick-level notional budget walk (a343c22); a synchronous refresh between entries would close it fully. | open |
| E-034 | 2026-07-05 | minor | wallet radar | Cross-scheduler lost-update window (milliseconds) on the wallets KV blob between the scanner's forward-evidence flush and foundry wallet tasks — both re-read before write-back, but the read→write pairs are not mutually serialized. An in-process mutex over wallet-blob writes would close it. | open |
| E-035 | 2026-07-05 | minor | stores | Driver-divergent list caps: memory `listFills` 5000 vs prisma 2000; prisma `listOrders` take:500 vs memory unbounded; memory never caps orders/intents arrays; prisma `addSignals` is non-transactional per batch. | open |
| E-036 | 2026-07-05 | minor | autopilot | Session notional ledger accrues the PROPOSED entry size, not the filled size (paper IOC may fill less) — conservative direction, but the ledger overstates deployed notional. | open |
| E-037 | 2026-07-05 | minor | tv datafeed | `/api/tv/[fn]?history` can return HTTP 500 instead of TradingView's `{s:"error"}` envelope when the upstream candle fetch throws. | open |
| E-038 | 2026-07-05 | note | outcomes | After E-013's fix, b5s captures are honestly MISSED until a faster-than-scan price path exists (registry refreshes on the ~30s scan cadence). The prosecutor's latency test therefore runs on b30s/no data — insufficient-evidence rather than fabricated-zero, which is the honest state; a WS-driven price path is the real fix. | open |

## Fixed

| id | found | severity | area | description | fixed in |
|----|-------|----------|------|-------------|----------|
| E-001 | 2026-07-05 | critical | outcomes | Outcome tracker recorded Coinbase ASSET-row dollar moves as probability drift (−741c bucket); binary-only gate + hydrate healing added | `38eb8fa` |
| E-002 | 2026-07-05 | major | foundry | New concept seeds were never appended to already-seeded stores — four ideas silently missing | `38eb8fa` |
| E-003 | 2026-07-05 | minor | foundry UI | Drift-by-price profile rendered 0 samples until 24h buckets matured — now falls back to 1h captures, visually tagged | `38eb8fa` |
| E-004 | 2026-07-05 | major | morphish UI | Duplicate React keys (`e:cat:*`) in the relationship graph from per-signal edge emission — deduped via edge map | `fc40b54` |
| E-005 | 2026-07-05 | critical | api | `POST /api/killswitch` with empty/malformed body silently DISENGAGED the kill switch (`Boolean(undefined)`) — now zod-required `{engaged: boolean}`, 400 otherwise | `a343c22` |
| E-006 | 2026-07-05 | critical | parser | Past-tense touch phrasings ("have reached", "dropped below", "fallen under") parsed as TERMINAL contracts — ECL could bet against touches spot can never disprove; direction+touch regexes now accept all inflections, regression tests added | `a343c22` |
| E-007 | 2026-07-05 | critical | autopilot | A rejected/failed LIVE exit intent was counted as executed → live lot silently dropped from exit management (stops/trails never retried). Only a `submitted` intent closes now; failures stay managed and retry | `a343c22` |
| E-008 | 2026-07-05 | critical | execution | One unreachable venue book aborted the entire scan-tick housekeeping chain BEFORE the autopilot exit sweep → all exits disabled while the dead order lived. Settlement now isolates per-order book failures and the scanner isolates each housekeeping step | `a343c22` |
| E-009 | 2026-07-05 | critical | market data | Real Polymarket tokens fell back to a fabricated MOCK book on CLOB failure — mock depth fed live-intent risk checks and matched paper fills (which train the bandit). Books now fail CLOSED for all real tokens; mock only for demo tokens | `a343c22` |
| E-010 | 2026-07-05 | critical | market data | `getHistory` served a seeded random walk as price history for REAL markets on CLOB failure, flowing into backtests/charts unlabeled — now returns empty (no data is honest; invented data is not) | `a343c22` |
| E-011 | 2026-07-05 | major | signals | `price_movement`, `dislocation`, `microstructure`, `liquidity_spread` had no outcomeType gate and fired on Coinbase spot rows — sub-$1 assets (DOGE) passed every probability-band check and emitted PROPOSED directional signals with dollar prices as fabricated win probabilities. All gated to binary; regression test asserts no strategy proposes on an asset row | `a343c22` |
| E-012 | 2026-07-05 | major | favorite_convergence | The adverse-flow gate ignored `RecentTrade.outcome`, so aggressive NO-token buying (the favorite collapsing) counted as SUPPORTING flow. Tape now normalized to YES-equivalent pressure like the microstructure read; test added | `a343c22` |
| E-013 | 2026-07-05 | major | outcomes | 5s/30s timer captures read the SAME registry row the entry mid came from (registry refreshes on the ~30s scan cadence) → every b5s "drift" was a fabricated 0.0c, permanently blinding the prosecutor's latency gate. Timer buckets now require a price fetched AFTER signal creation, else honestly MISSED | `a343c22` |
| E-014 | 2026-07-05 | major | outcomes | A single failed hydration cached its rejection forever, wedging outcome tracking + mimic + foundry reads until restart — failed hydration now resets for retry | `a343c22` |
| E-015 | 2026-07-05 | major | foundry | Decay monitor wrote the whole feature list back from a pre-loop snapshot (audit awaits inside the loop) — a concurrent human approval/retire could be silently erased. Verdicts now apply to a fresh re-read, respecting states that moved on | `a343c22` |
| E-016 | 2026-07-05 | major | foundry | `approvePromotion` had no status guard — retired/rejected (graveyard) features could be promoted directly with failure records attached. Server refuses; UI hides the button | `a343c22` |
| E-017 | 2026-07-05 | major | wallet radar | Daily rescore included `manuallyAdded` wallets regardless of status and rewrote them `tracked` — silently reverting a human's archive decision. Rescore now selects status `tracked` only | `a343c22` |
| E-018 | 2026-07-05 | major | disclosures | `refreshDisclosures` wrote back a snapshot read from BEFORE its multi-second network sweep, destroying concurrent disclosure writes (e.g. GDELT spike records) — re-reads and merges by id before saving | `a343c22` |
| E-019 | 2026-07-05 | major | attention | Stale attention topics (up to 48h old) were re-emitted as NEW spike records every 6h window with `filingDate: now` — spikes now mint only from the topic fetched THIS cycle | `a343c22` |
| E-020 | 2026-07-05 | major | memory store | `getKV` returned live references — a read-only route's in-place `.sort()` permanently reordered persisted wallet state, and the repo's tail-cap would then evict the BEST wallets. `getKV` returns detached copies (matching the prisma contract) | `a343c22` |
| E-021 | 2026-07-05 | major | autopilot | Every live exit fed the Thompson bandit as a realized $0 LOSS (outcome unknown — live fills aren't tracked), fabricating negative evidence against promoted strategies. Bandit learns from paper realized exits only | `a343c22` |
| E-022 | 2026-07-05 | major | policy | Session notional budget was checked per-candidate against the static pre-tick figure — one tick could overshoot `maxSessionNotionalUsd` by (maxOpenPositions−1)×perTradeUsd. Budget now walks the tick's accepted set | `a343c22` |
| E-023 | 2026-07-05 | major | mimic | Mimic limit orders were not IOC — a remainder resting in the book could fill via settlement minutes later as an orphaned position no exit sweep covered. Unfilled remainder now canceled immediately | `a343c22` |
| E-024 | 2026-07-05 | major | execution | `confirmLiveIntent` never consulted `expiresAt` — a days-old intent was confirmable at a stale price/assessment. Expired intents now flip to `expired` at confirm | `a343c22` |
| E-025 | 2026-07-05 | major | exposure | The "stale exposure blocks trading" rule was informational only — no trading caller read the `stale` flag, so a store outage meant entries kept passing risk checks against frozen cash. Stale exposure now BLOCKS entries (exits still pass, risk-reducing) in both paper and live paths | `a343c22` |
| E-026 | 2026-07-05 | major | ecl | Kelly sizing used `pShadow` for BUY_NO signals instead of `1−pShadow` — every NO-side ECL signal suggested $0 test size | `a343c22` |
| E-027 | 2026-07-05 | major | foundry | Prosecutor charged compile-time default slippage and omitted fees — an edge that dies under the user's configured costs could pass the promotion gate. Now charges live settings slippage+fees | `a343c22` |
| E-028 | 2026-07-05 | minor | scoring | `spread_vs_edge` mimic block switched off exactly at zero remaining edge, and walletShadow's lockup check passed on `remainingEdge === 0` — a fully-drifted follow could still place a paper mimic. Both gates now block at zero edge | `a343c22` |
| E-029 | 2026-07-05 | minor | many | Batch of verified minors: ARM/CONFIRM rituals exact-match (were case-insensitive); manual scan 409s under worker ownership; worker respects scannersEnabled; PATCH settings killSwitch routes through setKillSwitch side effects; Kalshi no-price trades dropped not invented as 0c; Coinbase/data-api NaN rows filtered; limit params NaN-safe; malformed JSON → 400 on all zod routes; morphish summary mode validated (memo map growth); source-health probe results applied to a fresh read + 10-min cooldown; rejected wallet candidates no longer persist orphaned trade blobs; re-tracking preserves forward evidence; candles span clamped; CoinGecko toggle honored; graph edges can't dangle past the node cap; merged mimic lots take the newest exit plan; MC fan chart covers the full horizon; UI honesty batch (no fabricated zeros/OKs, paper PnL labeled, 7d badge states real span, profit factor ∞ not "null", graph pins by edge id, UTC clock + persisted store hydrate post-mount, order-submit errors surfaced) | `a343c22` |

Pre-log history: 20 review findings fixed in `bfa84f8` (wallet-fade sign
inversion, late outcome captures recorded as on-time, seed-synthesized
promotions, concurrent wallet-forward drops, stale KV write-backs, hydrate
race, tailMass complement, fabricated health OK, live-order double counting,
drawdown percent formatting, and more — see that commit's message).
