import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureBackgroundScanner } from "@/server/scanner";
import { getMarkets } from "@/server/marketData";
import {
  discoverWallets,
  refreshWalletIntel,
  rescoreTrackedWallets,
  scoreWallet,
  walletIntelInfo,
} from "@/server/alpha/walletRadar";
import { listWallets, upsertWallet } from "@/server/alpha/repo";
import { audit } from "@/server/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  const wallets = await listWallets();
  return NextResponse.json({
    // copy before sorting: on the memory store this array IS persisted state,
    // and reordering it in place would let the repo's tail-cap evict the
    // best-scored wallets instead of the stalest
    wallets: [...wallets].sort((a, b) => (b.candidateScore ?? 0) - (a.candidateScore ?? 0)),
    intel: walletIntelInfo(),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover") }),
  z.object({ action: z.literal("rescore") }),
  z.object({ action: z.literal("intel") }),
  z.object({
    action: z.literal("track"),
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  }),
  z.object({
    action: z.literal("archive"),
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  }),
]);

export async function POST(req: NextRequest) {
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid action", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
  switch (body.action) {
    case "discover": {
      const { markets } = await getMarkets();
      const top = markets
        .filter((m) => m.venueId === "polymarket")
        .sort((a, b) => b.volume24h - a.volume24h);
      return NextResponse.json({ result: await discoverWallets(top) });
    }
    case "rescore":
      return NextResponse.json({ rescored: await rescoreTrackedWallets() });
    case "intel":
      return NextResponse.json({ markets: await refreshWalletIntel() });
    case "track": {
      // pass the existing record through so re-tracking a known wallet
      // preserves its accumulated forward evidence and firstSeen
      const existing = (await listWallets()).find(
        (x) => x.walletId === body.wallet.toLowerCase(),
      );
      const { record } = await scoreWallet(body.wallet.toLowerCase(), {
        manuallyAdded: true,
        existing,
      });
      await upsertWallet(record);
      await audit("user", "wallet_tracked", `Manually tracking public wallet ${body.wallet}`, {});
      return NextResponse.json({ wallet: record });
    }
    case "archive": {
      const wallets = await listWallets();
      const w = wallets.find((x) => x.walletId === body.wallet.toLowerCase());
      if (!w) return NextResponse.json({ error: "unknown wallet" }, { status: 404 });
      w.status = "archived";
      await upsertWallet(w);
      return NextResponse.json({ wallet: w });
    }
  }
}
