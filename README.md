# POLYQUANT Terminal

A real-time **Polymarket trading analytics terminal** with a fully automated
trading engine: dense quant-style dashboard, live market scanner, order-book
analytics, explainable signal engine, hard-limit risk engine, autonomous
autopilot with a Thompson-sampling strategy allocator, full paper-trading
loop, backtesting, Monte Carlo sizing, sub-20ms instrumented hot path, and an
end-to-end audit trail.

> **Honesty by construction** — the app never fabricates performance. Demo mode
> shows deterministic, deliberately-unimpressive data labeled `SAMPLE`;
> backtests are labeled `HISTORICAL SIMULATION`; the Monte Carlo panel is a
> risk display, not a profit claim; live trading ships **locked**; the bandit
> allocator learns only from *realized* fills, never asserted edges.

---

## Quick start (zero configuration)

```bash
npm install
npm run dev            # → http://localhost:3000
```

That's it. With no environment configured the terminal runs in **demo mode**:

- **Market data is real** — active Polymarket markets via the public Gamma,
  CLOB and Data APIs (order books, prices, history, trade tape).
- **Account data is sample** — a seeded, clearly-labeled demo portfolio.
- If the Polymarket APIs are unreachable, the app degrades to labeled
  `MOCK` markets/books so the UI stays fully explorable offline.

First launch shows an **eligibility & terms acknowledgment** screen; acceptance
is recorded in the audit log.

Optional: `npm run seed` regenerates the labeled demo account.

## Enabling paper mode

Paper mode trades **simulated fills against the real order book** with a
simulated cash balance (default $10,000).

1. Acknowledge the terms screen (first launch).
2. Click **`paper`** in the top-right of the nav bar.
3. Pick a market → order ticket → **preview order & run risk checks** →
   place. Marketable orders fill immediately against live book depth
   (walking levels, partial fills, average pricing, fees); passive orders
   rest and are re-matched on every scanner tick until filled or expired.

Positions, PnL, win rate, drawdown and the daily loss budget on the status
bar are all computed from your actual paper fills — never invented.
Reset anytime under **Settings → API/Wallet → reset paper account**.

## Enabling live mode (locked by default)

Live trading requires **all** of the following, deliberately:

1. **Server opt-in** — `LIVE_TRADING_ENABLED=true` in the environment.
2. **User opt-in** — Settings → API/Wallet → *live mode opt-in* (shows a risk
   warning).
3. **Terms acknowledged** — recorded timestamp required.
4. **Kill switch clear.**
5. **Per-order confirmation** — every live order goes through the preview
   modal; orders at/above the configured threshold (default $100) require
   typing `CONFIRM`. Nothing is ever auto-submitted.

Even then, submission needs CLOB credentials configured server-side
(`POLY_API_KEY/SECRET/PASSPHRASE`, `POLY_FUNDER_ADDRESS`, and a signer).
Without them, confirmed intents are recorded and rejected with a clear error —
the full workflow (intent → risk check → confirmation → audit) is exercisable
without touching real funds. Live trading supports **limit orders first**, via
the official `@polymarket/clob-client`.

**Key policy:** the app never stores private keys. Prefer browser-side signing
or an isolated operational wallet. `POLY_SIGNER_PRIVATE_KEY` exists for the
latter only and is strongly discouraged for anything else. Credentials live in
environment variables, never in the database.

## Autopilot — completely automated trading

The autopilot (`/autopilot`) runs the entire Detect → Validate → Size →
Execute → Monitor loop with no human in the loop, inside a hard safety
envelope. Four modes:

| mode | behavior |
|---|---|
| `off` | engine idle (default) |
| `observe` | full decision pipeline runs and narrates itself; nothing executes |
| `paper` | **fully automated simulated trading** against real books |
| `live` | automated live trading — only while explicitly **ARMED** |

Every tick (30s, alongside the scanner):

1. **Exits first, always** — target / hard stop / trailing stop / time stop /
   pre-close flatten, evaluated per managed lot. Exits are risk-reducing, so
   the risk engine relaxes entry-side microstructure blocks to warnings for
   them (kill switch still halts everything).
2. **Circuit breaker** — session realized loss beyond the configured budget
   halts entries (exits keep running) and auto-disarms live mode.
3. **Entries** — recent signals → policy (score floor, regime gating,
   per-market dedupe, hourly rate cap, session notional budget) → Thompson
   ranking → independent risk-engine approval → IOC execution (unfilled
   remainder canceled immediately). Sizing uses **uncertainty-shrunk Kelly**:
   the Beta-posterior lower bound of the strategy's win rate, so unproven
   strategies size tiny and only scale with realized proof.
4. **Learning** — realized exits update each strategy's Beta(α,β) posterior;
   the **Thompson-sampling bandit** shifts future allocation toward what is
   actually working. Posteriors, W/L records and realized PnL per strategy are
   shown on the autopilot page — computed, never asserted.

Every decision — including every skip — is recorded with its reason in the
decision tape, the live feed, and the audit log.

**Live arming ritual.** Setting mode to `live` does not trade. The user must
additionally type `ARM LIVE AUTOPILOT` with a TTL (5min–8h). While armed, the
engine may submit live limit orders inside the envelope without per-order
prompts — the arming ritual is the standing confirmation, recorded as such in
the audit trail. The breaker or TTL expiry disarms automatically; arming is
held in memory only and never survives a restart. All existing gates
(`LIVE_TRADING_ENABLED`, settings opt-in, terms, kill switch, CLOB
credentials) still apply, and the risk engine still vets every order.

## Kill switch

The red **kill** button (nav bar) or Settings → API/Wallet: disables all
trading (including the autopilot), cancels open paper orders and live
intents, and stops the scanners. Both engage and release are audit-logged.

---

## Architecture

```
src/
├── app/                      # Next.js App Router
│   ├── api/                  # route handlers (REST + SSE)
│   ├── (pages)/              # dashboard, scanner, market/[id], positions,
│   │                         # orders, signals, backtesting, settings, audit
├── components/
│   ├── ui/                   # dense terminal primitives (shadcn-style)
│   └── terminal/             # StatusBar, Scanner, OrderTicket, DecisionTree,
│                             # ExecutionCycle, LiveFeed, RobustnessGrid, MC…
├── hooks/                    # TanStack Query hooks + SSE feed hook
├── store/                    # Zustand terminal state (mode, selection, ack)
├── lib/
│   ├── polymarket/           # Gamma / CLOB / Data API adapters (typed,
│   │                         # injectable fetch, offline-testable)
│   ├── engine/
│   │   ├── signals/          # 5 plug-in strategies + registry
│   │   ├── risk/             # risk engine, Kelly sizing, market grading
│   │   ├── execution/        # paper matching engine (pure functions)
│   │   ├── backtest/         # bar-by-bar simulator (no look-ahead)
│   │   └── montecarlo/       # seeded Monte Carlo simulator
│   └── demo/                 # labeled sample data (deterministic seeds)
└── server/                   # store (memory|prisma), cache (memory|redis),
                              # scanner, portfolio, execution, audit, SSE bus,
                              # live CLOB adapter (env-gated)
prisma/                       # PostgreSQL schema + migrations (17 tables)
scripts/                      # background worker + demo seeder
tests/                        # unit (engines) + integration (adapters)
```

### Venues & data sources (all official APIs — nothing scraped)

The terminal is multi-venue: every source lives behind the `VenueAdapter`
contract (`src/lib/venues/`), execution logic is never shared across venues,
and a signal on one venue is never assumed tradable on another without
explicit mapping, liquidity/fee/settlement checks, and user approval.

| Venue | Class | Data | Trading |
|---|---|---|---|
| **Polymarket** (Gamma/CLOB/Data APIs + market WS) | event-market outcome tokens | markets, books, history, tape | paper ✓ · live locked behind 5 gates |
| **Kalshi** (official trade-api/v2) | regulated US event contracts | events, markets, books (YES asks derived from NO bids), tape | paper ✓ · live adapter ships locked (needs API key + RSA signing + venue terms; demo env separate) |
| **Coinbase** (Advanced Trade public) | crypto spot (`outcomeType: "asset"`) | products, books, native candles, tape | paper ✓ · live adapter ships locked (needs scoped credentials) |
| **CoinGecko** (free API) | **reference-only** | prices, 24h vol/change | never — reference data cannot execute |

Every source exposes a transparency record on **/sources**: license/terms
note, update cadence, rate-limit posture, live request/failure counters,
last success/failure, freshness, and data class (tradable vs reference-only).
Internal market keys are venue-prefixed (`ks:TICKER`, `cb:BTC-USD`;
Polymarket keeps raw condition ids), so keys never collide and token-prefix
routing picks the owning venue for books, tapes, candles and execution.

**Cross-venue intelligence** (`/crossvenue`): the mapping engine compares
markets across venues by parsed structure — crypto thresholds
(`asset/direction/level/date`), close-time windows, categories, stated
resolution sources — never by title similarity alone. Statuses are
conservative: automation caps at `strong_candidate` (`exact` is reserved for
human confirmation), threshold disagreements are `conflict`, event↔spot links
are `reference_only`, and resolution *wording* is always flagged
non-comparable pending human review. Two cross-venue signals build on this:
`reference_price` (Coinbase spot + realized vol vs a crypto-linked market's
implied probability; self-rejects on >5s-stale spot) and `venue_divergence`
(**candidate discrepancies** between rule-comparable Polymarket/Kalshi pairs,
costed with both venues' spreads — never presented as arbitrage). The
autopilot remains Polymarket-only; cross-venue automation has no opt-in path
by design.

**Charting**: TradingView **Lightweight Charts** (Apache-2.0) renders our own
normalized data — native Coinbase candles, probability lines with Coinbase
spot overlays + threshold lines for crypto-linked event markets. A
TradingView **UDF-compatible datafeed** (`/api/tv/{config,search,symbols,history,time}`)
serves `POLYMARKET:<id>` / `KALSHI:<ticker>` / `COINBASE:<product>` symbols
from backend data for operators licensed to use Advanced Charts; no
TradingView data is scraped or proxied.

All server-side reads are cached (in-memory, optionally Redis) with TTLs to
respect upstream rate limits. Endpoint shapes were verified against the live
production APIs of all three venues; see `src/lib/venues/` and
`src/lib/polymarket/`.

### Storage

- **Default (`STORAGE_DRIVER=memory`)** — in-process store persisted to
  `.data/polyquant-store.json`. Zero setup; survives restarts.
- **PostgreSQL (`STORAGE_DRIVER=prisma`)** — full schema in
  `prisma/schema.prisma` (users, wallets, markets, outcomes,
  market_snapshots, order_books, price_history, signals, signal_checks,
  paper_orders, live_order_intents, fills, positions, portfolio_snapshots,
  risk_snapshots, audit_events, app_settings):

```bash
export DATABASE_URL=postgresql://user:pass@host:5432/polyquant
export STORAGE_DRIVER=prisma
npm run db:migrate      # applies prisma/migrations
npm run dev
```

### Background workers — one scheduler, ever

The scanner (and the autopilot tick inside it) runs in-process in the web
server by default (30s cadence, started lazily). For production it can run as
a dedicated process instead:

```bash
# web process: hand scheduling to the worker
DISABLE_EMBEDDED_SCANNER=true npm start
# worker process (requires the shared Prisma store)
STORAGE_DRIVER=prisma DATABASE_URL=… npm run worker
```

The worker **refuses to start on the memory store** — two processes would
each hold private in-memory state and clobber each other's `.data` JSON file.
Never run two schedulers against one store: the autopilot would evaluate and
execute every entry twice. Paper/demo settlement is serialized through a
per-mode mutex inside each process; cross-process serialization is the
single-scheduler rule above.

### Signal engine (plug-in strategies)

Every signal carries a full check trail (`name / passed / value / threshold /
detail`) — nothing is opaque. Registry: `src/lib/engine/signals/registry.ts`.

1. **Liquidity/Spread** — tradability score from spread, depth, volume.
2. **Price Movement** — Δ1h/Δ24h moves with velocity, volatility and
   mean-reversion risk; direction only with volume support.
3. **Complement Probability** — YES+NO sum anomalies beyond a fee+slippage
   +spread cost buffer; always requires independent risk approval.
4. **Cross-Market Relations** — same-event / shared-term / shared-window
   relations; same-event YES-sum inconsistencies; **always** flags
   `resolution_rules_verified: false` for human review (never assumes
   arbitrage).
5. **Closing Soon** — near-resolution markets with liquidity, spread,
   uncertainty and settlement-clarity context.
6. **Fair-Value Dislocation** — a self-scaling **Kalman filter** over each
   market's price series yields a latent fair-value estimate; prints >2σ from
   it (after costs) fire mean-reversion signals, gated to *calm* regimes. The
   filtered fair value doubles as the model win-probability handed to the
   risk engine, so sizing is model-driven.
7. **Microstructure Flow** — **Stoikov micro-price** divergence + near-mid
   book imbalance + aggressor imbalance on the public tape (normalized to the
   YES token) compose a short-horizon pressure score; fires only when the
   components agree on a deep-enough book.

A **volatility/trend regime classifier** (calm / trending / chaotic) gates
which strategy styles may act — mean reversion needs a stable anchor,
momentum needs persistence. Add a strategy: implement `SignalStrategy`,
append it to `STRATEGIES`; the scanner, autopilot, bandit, UI and audit trail
pick it up automatically.

### Risk engine

Pure function (`src/lib/engine/risk/riskEngine.ts`) evaluating every proposal:
entry/target/stop, max loss, EV, required edge after spread+fees+slippage,
full & capped Kelly, suggested size, portfolio/market/category exposure after
trade, liquidity exit risk, resolution ambiguity. Hard blocks (reject) vs
warnings are explicit per check. Defaults: paper-first, live locked, max
1%/trade, 5%/market, 15%/category, and no trade on wide spread, thin
liquidity, ambiguous rules, or stale data. If you don't supply your own win
probability the engine prices EV off the market-implied probability — which is
negative after costs, and it will tell you exactly that.

### Backtesting

`POST /api/backtest` — momentum / mean-reversion / closing-drift over real CLOB
price history. Look-ahead is prevented structurally (signals see bars `≤ i`,
execution at bar `i+1`), the cost model (spread, slippage, fees) is applied
per side, position sizing compounds on equity at entry, and every result is
labeled **HISTORICAL SIMULATION** with its assumptions list.

## Performance architecture

The app is split into an instrumented **hot path** and an async **cold path**.
Internal hot-path operations on in-memory data are held to a **<20ms p95**
budget; external Polymarket/wallet/chain latency is measured separately and
carries **no latency promise** — the app never fakes speed by hiding stale
data or skipping risk checks.

Hot path (in-memory, measured):
- **Market registry** — O(1) lookups by condition id / token id / slug with a
  precomputed token→price map, rebuilt on each upstream refresh.
- **Exposure cache** — order previews and risk checks read portfolio/exposure
  state from memory (no store/DB round-trip); fills, cancels and resets
  invalidate it asynchronously; a stale cache **blocks** trading until
  refreshed rather than being silently served.
- **Settings cache** — 3s read-through cache so previews never hit the DB
  under the prisma driver.
- Pure filter/sort pipeline for the scanner table (`src/lib/scannerQuery.ts`).

Cold path (async, never blocks trading):
- Audit log persistence (append-only batch queue), portfolio snapshots,
  backtests, Monte Carlo, historical analytics.

Frontend:
- Virtualized scanner table (TanStack Virtual) with memoized rows — a single
  tick never re-renders the table.
- One shared SSE connection per tab with requestAnimationFrame-batched
  delivery; overflow drops oldest events (latest state authoritative) and
  counts them.
- Live order-book **WebSocket deltas** for the selected market, applied
  incrementally and flushed once per frame.
- Heavy panels (React Flow decision tree, Monte Carlo) load lazily outside
  the dashboard's critical bundle.

Observability (`/perf` + `/api/perf`):
- p50/p95/p99 ring-buffer histograms for every `hot.*`, `upstream.*` and
  cold-path metric, with budget pass/fail per row.
- Cache hit rate, exposure-cache reads/invalidations, audit queue depth,
  registry size/age, client SSE ingest/drop counts and flush p95.
- Every `measure()` also opens an **OpenTelemetry** span
  (`@opentelemetry/api` facade — no-op until an operator wires an SDK, full
  tracing when they do).

Benchmarks (`tests/perf/hotpath.test.ts`, run in `npm test`) enforce the
budget: scanner filter+sort over 1,000 and 10,000 synthetic markets, full
risk-check evaluation, 7-strategy single-market re-score, Kalman filtering,
registry rebuilds, and a simulated 1,000-updates/second ingest — all asserted
<20ms p95.

## Testing

```bash
npm test                # 113 tests: unit (signals, risk, kelly, paper engine,
                        # monte carlo, backtester, kalman/microstructure/regime,
                        # bandit/policy/exits) + integration (API adapters with
                        # recorded fixtures) + hot-path perf benchmarks
npx tsc --noEmit        # strict type-check
npm run build           # production build
```

## Environment

Copy `.env.example` → `.env.local`. Everything is optional; see the file for
full documentation of storage, Redis, endpoint overrides, read-only wallet
analytics, and the live-trading gate.

## Compliance & safety notes

- Analytics tool, not investment advice; event markets can lose 100%.
- You are responsible for your own eligibility and for complying with
  Polymarket's terms; the app will not help bypass region, platform, or
  rate-limit restrictions (server-side caching exists to *respect* limits).
- No market-manipulation features. No scraping of private data.
- No fake profits, rankings, badges, or win rates — anything simulated or
  sampled is labeled as such, everywhere it appears.
- Every signal, preview, approval, order, cancel, fill, settings change,
  kill-switch action and API error is written to the audit log.
