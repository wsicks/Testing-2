import { NextRequest, NextResponse } from "next/server";
import { listWallets } from "@/server/alpha/repo";
import { getWalletTrades } from "@/server/alpha/walletRadar";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await params;
  const id = wallet.toLowerCase();
  const record = (await listWallets()).find((w) => w.walletId === id);
  if (!record) return NextResponse.json({ error: "not tracked" }, { status: 404 });
  const [trades, store] = await Promise.all([getWalletTrades(id), getStore()]);
  const signals = (await store.listSignals({ limit: 200 })).filter(
    (s) => s.meta?.walletId === id,
  );
  return NextResponse.json({
    wallet: record,
    trades: [...trades].reverse().slice(0, 100),
    signals: signals.slice(0, 40),
  });
}
