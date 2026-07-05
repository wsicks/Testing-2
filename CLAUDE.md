# EVENTQUANT Terminal — working notes for Claude

Next.js 16 App Router · React 19 · TS strict · Tailwind · Prisma 6 (NOT 7 —
v7 removed the classic datasource `url`) · zod 4 · vitest 4 ·
lightweight-charts 5 (`chart.addSeries(CandlestickSeries, opts)` API).

## Verify loop (run all before any commit)

```bash
npx vitest run          # all tests must pass
npx tsc --noEmit
npx eslint src tests scripts   # 0 errors (8 known react-compiler warnings OK)
npm run build
```

Live smoke: `(nohup npm run start > /tmp/server.log 2>&1 &)`, wait for
`/api/settings`, then `POST /api/signals/scan` and hit the routes you touched.
Kill with `pkill -f "next[-]server"` — the `[-]` prevents pkill matching its
own command line (plain pattern self-kills with exit 144). Never chain
`sleep`; use `run_in_background` or until-loops.

## Non-negotiable house rules

- **Never fabricate numbers.** Demo data is labeled SAMPLE, backtests
  HISTORICAL SIMULATION, model outputs carry their assumptions. If a value
  can't be measured honestly, show "—" with the reason, don't invent it.
- **Verify external API shapes live (curl) before writing an adapter.**
  Every adapter in this repo was built against a verified response. Rate
  limits are respected in code (GDELT: 1 req/5s hard; SEC: declared UA).
- **No scraping.** Sources without a permitted structured API are registry
  entries with status `manual_review`/`unavailable`, not adapters.
- **Live trading is multiply gated**: `LIVE_TRADING_ENABLED` env + settings
  opt-in + terms + kill switch clear + per-order confirmation + (for
  autopilot) foundry PROMOTION (prosecutor pass + named human approval) +
  the typed ARM ritual. Never add a path around any gate.
- **Reference data never executes** (CoinGecko, TV datafeed). Touch ("reach
  $X") and terminal ("above $X at close") crypto contracts are different
  instruments — `parseCryptoThreshold` returns `kind`; spot can prove a touch
  happened but never that it didn't.
- **Wallet intelligence**: public addresses + venue pseudonyms only, no
  identity inference; live auto-copy must not exist as a code path.

## Architecture map (server)

- `src/server/scanner.ts` — 30s tick: registry/baseline update → 15
  strategies per market (hot, <20ms p95) → persist top-8/strategy → outcome
  tracking → mimic executor → settlement → autopilot tick. One scheduler
  ever: `DISABLE_EMBEDDED_SCANNER=true` when the worker owns it.
- `src/server/hotpath/` — globalThis singletons: market registry, exposure
  cache (stale = blocks trading), signal ring (`signalCache`), spread/liq
  baselines. Hot reads never hit the store/DB.
- `src/server/alpha/` — the research machine: `foundry.ts` (lifecycle,
  seeds, 5-min ticker with per-task cadences), `prosecutor.ts`,
  `backtester.ts` (+ `src/lib/alpha/walkforward.ts` pure harness),
  `outcomes.ts` (decay buckets; MISSED never backfilled; wallet forward
  updates flushed sequentially), `walletRadar.ts`, `disclosures.ts` (FedReg +
  NWS), `attention.ts` (GDELT), `repo.ts` (typed KV; lists capped).
- `src/server/morphish.ts` — dashboard services, in-memory reads only,
  60s memos for anything store-backed.
- Persistence: Store interface (memory | prisma) + KV for runtime state;
  Prisma tables are the durable schema (43). KV read-modify-write must
  re-read before write-back (see recordWalletForward / approvePromotion
  fixes) — on the Prisma driver every `getKV` returns detached copies.
- Signals: pure `SignalStrategy` plug-ins in `src/lib/engine/signals/`,
  appended to `registry.ts` (tests assert the exact 15-id list). Every
  signal carries a check trail; informational signals use an always-failing
  check to stay `rejected` (= human review). `buildSignal` self-rejects on
  any failed check.

## Lifecycle & evidence conventions

- New data-driven features start as foundry seeds (`FEATURE_SEEDS`) at
  `idea`; they EARN advancement (first successful ingest → `data_connected`;
  strategy code shipping → reconcile upgrades to seed status; never
  downgrade, never touch promoted/degraded/retired/human states).
- Nothing seeds as `promoted`. `liveEligibleStrategies()` gates autopilot
  live routing.
- Outcome evidence rules: direction-adjusted drift; wallet attribution uses
  `walletSign` (+1 follow, −1 fade — a fade that works is negative evidence
  about the faded wallet).

## Known deferred (honest backlog — do not fake)

Econ-calendar features need free keys (`FRED_API_KEY`, `BLS_API_KEY`,
`CONGRESS_GOV_API_KEY`, …— named in the source registry). Live fill tracking
via CLOB user WS, Kalshi WS transport, auth middleware, PrismaStore contract
tests, Monte Carlo web worker. The old Polymarket leaderboard API is dead
(404) — discovery uses large trades + holders.
