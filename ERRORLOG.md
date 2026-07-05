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

## Fixed

| id | found | severity | area | description | fixed in |
|----|-------|----------|------|-------------|----------|
| E-001 | 2026-07-05 | critical | outcomes | Outcome tracker recorded Coinbase ASSET-row dollar moves as probability drift (−741c bucket); binary-only gate + hydrate healing added | `38eb8fa` |
| E-002 | 2026-07-05 | major | foundry | New concept seeds were never appended to already-seeded stores — four ideas silently missing | `38eb8fa` |
| E-003 | 2026-07-05 | minor | foundry UI | Drift-by-price profile rendered 0 samples until 24h buckets matured — now falls back to 1h captures, visually tagged | `38eb8fa` |
| E-004 | 2026-07-05 | major | morphish UI | Duplicate React keys (`e:cat:*`) in the relationship graph from per-signal edge emission — deduped via edge map | `fc40b54` |

Pre-log history: 20 review findings fixed in `bfa84f8` (wallet-fade sign
inversion, late outcome captures recorded as on-time, seed-synthesized
promotions, concurrent wallet-forward drops, stale KV write-backs, hydrate
race, tailMass complement, fabricated health OK, live-order double counting,
drawdown percent formatting, and more — see that commit's message).
