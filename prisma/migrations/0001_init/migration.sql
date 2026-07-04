-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 137,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "conditionId" TEXT NOT NULL,
    "gammaId" TEXT,
    "slug" TEXT,
    "question" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "negRisk" BOOLEAN NOT NULL DEFAULT false,
    "liquidity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volumeTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("conditionId")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_snapshots" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "yesPrice" DOUBLE PRECISION,
    "noPrice" DOUBLE PRECISION,
    "bestBid" DOUBLE PRECISION,
    "bestAsk" DOUBLE PRECISION,
    "midpoint" DOUBLE PRECISION,
    "spread" DOUBLE PRECISION,
    "liquidity" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,

    CONSTRAINT "market_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_books" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hash" TEXT,
    "bids" JSONB NOT NULL,
    "asks" JSONB NOT NULL,

    CONSTRAINT "order_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "marketId" TEXT,
    "conditionId" TEXT,
    "tokenId" TEXT,
    "direction" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_checks" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "detail" TEXT,

    CONSTRAINT "signal_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_orders" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT,
    "marketTitle" TEXT,
    "category" TEXT,
    "origin" TEXT,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'limit',
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "filledSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgFillPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'created',
    "signalId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "paper_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_order_intents" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT,
    "marketTitle" TEXT,
    "origin" TEXT,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'limit',
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "filledSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'created',
    "confirmationText" TEXT,
    "approvedAt" TIMESTAMP(3),
    "clobOrderId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "live_order_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "intentId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "tokenId" TEXT NOT NULL,
    "conditionId" TEXT,
    "outcome" TEXT,
    "marketTitle" TEXT,
    "category" TEXT,
    "side" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnlDelta" DOUBLE PRECISION,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT,
    "marketTitle" TEXT,
    "category" TEXT,
    "size" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "exposure" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL,
    "dailyPnl" DOUBLE PRECISION NOT NULL,
    "drawdown" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_snapshots" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "dailyLossUsed" DOUBLE PRECISION NOT NULL,
    "exposurePct" DOUBLE PRECISION NOT NULL,
    "liquidityRiskScore" DOUBLE PRECISION NOT NULL,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "marketConcentration" JSONB,
    "categoryConcentration" JSONB,

    CONSTRAINT "risk_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "publicDataEnabled" BOOLEAN NOT NULL DEFAULT true,
    "privateDataEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paperTradingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "liveTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthCheck" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "venueId" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "encryptedCredentialRef" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "venue_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "normalized_markets" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "venueMarketId" TEXT NOT NULL,
    "ticker" TEXT,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "closeTime" TIMESTAMP(3),
    "resolutionRules" TEXT,
    "tradable" BOOLEAN NOT NULL DEFAULT true,
    "referenceOnly" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "normalized_markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cross_venue_links" (
    "id" TEXT NOT NULL,
    "sourceVenueId" TEXT NOT NULL,
    "sourceMarketId" TEXT NOT NULL,
    "targetVenueId" TEXT NOT NULL,
    "targetMarketId" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION NOT NULL,
    "matchStatus" TEXT NOT NULL,
    "ruleComparison" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cross_venue_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_prices" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "bid" DOUBLE PRECISION,
    "ask" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "freshnessMs" INTEGER NOT NULL,

    CONSTRAINT "reference_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_health" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "restStatus" TEXT NOT NULL DEFAULT 'unknown',
    "websocketStatus" TEXT NOT NULL DEFAULT 'unknown',
    "latencyP50" DOUBLE PRECISION,
    "latencyP95" DOUBLE PRECISION,
    "latencyP99" DOUBLE PRECISION,
    "errorRate" DOUBLE PRECISION,
    "rateLimitRemaining" INTEGER,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_address_key" ON "wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "markets_gammaId_key" ON "markets"("gammaId");

-- CreateIndex
CREATE INDEX "markets_active_closed_idx" ON "markets"("active", "closed");

-- CreateIndex
CREATE INDEX "markets_endDate_idx" ON "markets"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_tokenId_key" ON "outcomes"("tokenId");

-- CreateIndex
CREATE INDEX "market_snapshots_marketId_ts_idx" ON "market_snapshots"("marketId", "ts");

-- CreateIndex
CREATE INDEX "order_books_tokenId_ts_idx" ON "order_books"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "price_history_tokenId_idx" ON "price_history"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "price_history_tokenId_ts_key" ON "price_history"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "signals_strategy_createdAt_idx" ON "signals"("strategy", "createdAt");

-- CreateIndex
CREATE INDEX "signals_status_idx" ON "signals"("status");

-- CreateIndex
CREATE INDEX "paper_orders_status_idx" ON "paper_orders"("status");

-- CreateIndex
CREATE INDEX "paper_orders_tokenId_idx" ON "paper_orders"("tokenId");

-- CreateIndex
CREATE INDEX "live_order_intents_status_idx" ON "live_order_intents"("status");

-- CreateIndex
CREATE INDEX "fills_tokenId_ts_idx" ON "fills"("tokenId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "positions_tokenId_mode_key" ON "positions"("tokenId", "mode");

-- CreateIndex
CREATE INDEX "portfolio_snapshots_mode_ts_idx" ON "portfolio_snapshots"("mode", "ts");

-- CreateIndex
CREATE INDEX "risk_snapshots_mode_ts_idx" ON "risk_snapshots"("mode", "ts");

-- CreateIndex
CREATE INDEX "audit_events_ts_idx" ON "audit_events"("ts");

-- CreateIndex
CREATE INDEX "audit_events_type_idx" ON "audit_events"("type");

-- CreateIndex
CREATE INDEX "normalized_markets_venueId_idx" ON "normalized_markets"("venueId");

-- CreateIndex
CREATE INDEX "cross_venue_links_sourceMarketId_idx" ON "cross_venue_links"("sourceMarketId");

-- CreateIndex
CREATE INDEX "cross_venue_links_targetMarketId_idx" ON "cross_venue_links"("targetMarketId");

-- CreateIndex
CREATE INDEX "reference_prices_source_symbol_timestamp_idx" ON "reference_prices"("source", "symbol", "timestamp");

-- CreateIndex
CREATE INDEX "venue_health_venueId_lastUpdated_idx" ON "venue_health"("venueId", "lastUpdated");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_userId_key_key" ON "app_settings"("userId", "key");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("conditionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("conditionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("conditionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_checks" ADD CONSTRAINT "signal_checks_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "paper_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "live_order_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_credentials" ADD CONSTRAINT "venue_credentials_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_health" ADD CONSTRAINT "venue_health_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

