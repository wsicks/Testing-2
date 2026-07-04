# POLYQUANT Terminal

A real-time **Polymarket trading analytics terminal**: dense quant-style
dashboard, live market scanner, order-book analytics, explainable signal
engine, hard-limit risk engine, full paper-trading loop, backtesting, Monte
Carlo sizing, and an end-to-end audit trail.

> **Honesty by construction** — the app never fabricates performance. Demo mode
> shows deterministic, deliberately-unimpressive data labeled `SAMPLE`;
> backtests are labeled `HISTORICAL SIMULATION`; the Monte Carlo panel is a
> risk display, not a profit claim; live trading ships **locked**.

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

## Kill switch

The red **kill** button (nav bar) or Settings → API/Wallet: disables all
trading, cancels open paper orders and live intents, and stops the scanners.
Both engage and release are audit-logged.

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

### Data sources (official Polymarket APIs)

| API | Used for |
|---|---|
| `gamma-api.polymarket.com` | events, markets, tags, outcomes, liquidity, volume, best bid/ask, price changes |
| `clob.polymarket.com` | order books, midpoints, spreads, price history |
| `data-api.polymarket.com` | public trade tape, read-only wallet positions/value |
| `ws-subscriptions-clob.polymarket.com` | market channel (client-side live updates) |

All server-side reads are cached (in-memory, optionally Redis) with TTLs to
respect upstream rate limits. Endpoint shapes were verified against the live
production APIs; see the adapters in `src/lib/polymarket/`.

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

### Background workers

The scanner runs in-process (30s cadence, started lazily) and can also run as
a dedicated process:

```bash
npm run worker          # continuous scan → signals → order settlement → snapshots
```

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

Add a strategy: implement `SignalStrategy`, append it to `STRATEGIES`.

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

## Testing

```bash
npm test                # 73 tests: unit (signals, risk, kelly, paper engine,
                        # monte carlo, backtester) + integration (Gamma/CLOB/
                        # Data API adapters with recorded fixtures, offline)
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
