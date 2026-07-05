import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    defaultMode: z.enum(["demo", "paper", "live"]),
    maxTradePct: z.number().min(0.05).max(100),
    maxTradeUsd: z.number().min(1).max(1_000_000),
    maxDailyLossUsd: z.number().min(1).max(1_000_000),
    maxMarketExposurePct: z.number().min(0.1).max(100),
    maxCategoryExposurePct: z.number().min(0.1).max(100),
    minLiquidityUsd: z.number().min(0),
    maxSpread: z.number().gt(0).lte(0.5),
    minSignalScore: z.number().min(0).max(100),
    orderExpirationMin: z.number().min(1).max(60 * 24 * 30),
    kellyCap: z.number().gt(0).lte(1),
    feeRateBps: z.number().min(0).max(1_000),
    slippageBps: z.number().min(0).max(5_000),
    typedConfirmThresholdUsd: z.number().min(0),
    staleDataMaxSecs: z.number().min(5).max(3_600),
    closingSoonHours: z.number().min(1).max(24 * 30),
    watchlist: z.array(z.string()).max(500),
    categories: z.array(z.string()).max(100),
    termsAcceptedAt: z.number().optional(),
    liveModeEnabled: z.boolean(),
    killSwitch: z.boolean(),
    scannersEnabled: z.boolean(),
    paperStartingCash: z.number().min(100).max(10_000_000),
    watchWallet: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .or(z.literal(""))
      .optional(),
    venues: z.object({
      polymarket: z.object({
        publicData: z.boolean(),
        paperTrading: z.boolean(),
        liveEnabled: z.boolean(),
      }),
      kalshi: z.object({
        publicData: z.boolean(),
        paperTrading: z.boolean(),
        liveEnabled: z.boolean(),
      }),
      coinbase: z.object({
        publicData: z.boolean(),
        paperTrading: z.boolean(),
        liveEnabled: z.boolean(),
      }),
      coingecko: z.object({ publicData: z.boolean() }),
    }),
    alpha: z.object({
      foundryEnabled: z.boolean(),
      walletFollowMode: z.enum(["watch_only", "confirm_only", "paper_mimic", "paper_fade"]),
      walletLiveEnabled: z.boolean(),
      maxCopyDriftCents: z.number().min(0.5).max(10),
      maxWalletEntryAgeMin: z.number().min(5).max(60 * 24 * 7),
      minWalletSampleSize: z.number().min(5).max(500),
      minWalletForwardSamples: z.number().min(3).max(200),
      testOrderUsd: z.number().min(1).max(25),
    }),
    autopilot: z.object({
      mode: z.enum(["off", "observe", "paper", "live"]),
      enabledStrategies: z.array(z.string()).max(20),
      minScore: z.number().min(0).max(100),
      perTradeUsd: z.number().min(1).max(100_000),
      maxOpenPositions: z.number().min(1).max(100),
      maxTradesPerHour: z.number().min(1).max(600),
      maxSessionNotionalUsd: z.number().min(1).max(1_000_000),
      sessionMaxLossUsd: z.number().min(1).max(1_000_000),
      targetPct: z.number().gt(0).lte(500),
      stopPct: z.number().gt(0).lte(100),
      trailPct: z.number().gt(0).lte(100),
      maxHoldMin: z.number().min(1).max(60 * 24 * 30),
      flattenBeforeCloseMin: z.number().min(0).max(60 * 24),
      requireRegimeMatch: z.boolean(),
    }),
  })
  .partial();

export async function GET() {
  const store = await getStore();
  const settings = await store.getSettings();
  return NextResponse.json({
    settings,
    liveTradingEnv: process.env.LIVE_TRADING_ENABLED === "true",
  });
}

export async function PATCH(req: NextRequest) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid settings", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const store = await getStore();
  const before = await store.getSettings();
  // the kill switch has engage side effects (cancel open orders/intents,
  // stop scanners) that a bare settings write would skip — route it through
  // the one true implementation and patch everything else normally
  const { killSwitch, ...rest } = parsed.data;
  let settings = await store.patchSettings(rest);
  if (killSwitch !== undefined && killSwitch !== before.killSwitch) {
    const { setKillSwitch } = await import("@/server/execution");
    await setKillSwitch(killSwitch);
    settings = await store.getSettings();
  }
  const changed = Object.keys(parsed.data).join(", ");
  await audit("user", "settings_changed", `Settings updated: ${changed}`, {
    data: { changed: parsed.data },
    feedType: "user_action",
  });
  if (parsed.data.liveModeEnabled === true && !before.liveModeEnabled) {
    await audit("user", "live_mode_enabled", "User explicitly ENABLED live mode in settings", {
      severity: "warn",
      feedType: "user_action",
    });
  }
  return NextResponse.json({
    settings,
    liveTradingEnv: process.env.LIVE_TRADING_ENABLED === "true",
  });
}
