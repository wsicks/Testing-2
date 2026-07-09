// Live CLOB adapter — bring-your-own credentials.
//
// This module is only reachable through confirmLiveIntent(), which enforces:
// LIVE_TRADING_ENABLED=true, live mode enabled in settings, terms accepted,
// kill switch off, risk approval, and typed confirmation above the threshold.
//
// SECURITY: the app never stores private keys. The adapter reads
// operator-provided environment configuration at call time. The recommended
// deployment signs orders browser-side instead; POLY_SIGNER_PRIVATE_KEY exists
// only for isolated operational wallets and is strongly discouraged.

import type { LiveOrderIntent, LiveOrderSnapshot } from "@/lib/types";

function requiredEnv(): {
  key: string;
  secret: string;
  passphrase: string;
  funder: string;
  signerKey: `0x${string}`;
} | null {
  const key = process.env.POLY_API_KEY;
  const secret = process.env.POLY_API_SECRET;
  const passphrase = process.env.POLY_API_PASSPHRASE;
  const funder = process.env.POLY_FUNDER_ADDRESS;
  const signerKey = process.env.POLY_SIGNER_PRIVATE_KEY;
  if (!key || !secret || !passphrase || !funder || !signerKey) return null;
  return {
    key,
    secret,
    passphrase,
    funder,
    signerKey: signerKey as `0x${string}`,
  };
}

async function buildClient() {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "Live CLOB adapter is not configured. Set POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE / POLY_FUNDER_ADDRESS and a signer (see README — Live trading). No order was sent.",
    );
  }
  // Official Polymarket TypeScript client (v5, viem-based). Loaded lazily so
  // trading code paths never execute unless the operator configured creds.
  const { ClobClient } = await import("@polymarket/clob-client");
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  const account = privateKeyToAccount(env.signerKey);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });
  return new ClobClient(
    process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
    137,
    walletClient,
    { key: env.key, secret: env.secret, passphrase: env.passphrase },
    2, // signature type 2: Polymarket proxy wallet
    env.funder,
  );
}

export async function submitLiveOrder(
  intent: LiveOrderIntent,
): Promise<LiveOrderSnapshot> {
  const client = await buildClient();
  const { Side, OrderType } = await import("@polymarket/clob-client");
  const order = await client.createOrder({
    tokenID: intent.tokenId,
    price: intent.price,
    side: intent.side === "BUY" ? Side.BUY : Side.SELL,
    size: intent.size,
  });
  const res = await client.postOrder(order, OrderType.GTC);
  if (res?.success === false || res?.error) {
    throw new Error(`CLOB rejected order: ${res?.errorMsg ?? res?.error ?? "unknown error"}`);
  }
  return snapshotFromPostResponse(res, intent);
}

export async function cancelLiveOrder(clobOrderId: string): Promise<void> {
  const client = await buildClient();
  await client.cancelOrder({ orderID: clobOrderId });
}

export async function fetchLiveOrderSnapshot(
  intent: LiveOrderIntent,
): Promise<LiveOrderSnapshot> {
  if (!intent.clobOrderId) {
    throw new Error("Cannot reconcile live order before the venue order id is known");
  }
  const client = await buildClient();
  const order = await client.getOrder(intent.clobOrderId);
  return snapshotFromOpenOrder(order, intent);
}

function snapshotFromPostResponse(
  res: Record<string, unknown>,
  intent: LiveOrderIntent,
): LiveOrderSnapshot {
  const status = normalizeVenueStatus(String(res.status ?? "submitted"));
  const orderId =
    stringish(res.orderID) ?? stringish(res.orderId) ?? stringish(res.id);
  return {
    orderId,
    status,
    filledSize: status === "filled" ? intent.size : 0,
    error: stringish(res.errorMsg) ?? stringish(res.error),
  };
}

function snapshotFromOpenOrder(
  order: {
    id?: string;
    status?: string;
    size_matched?: string;
    price?: string;
  },
  intent: LiveOrderIntent,
): LiveOrderSnapshot {
  const filledSize = clampFilled(intent.size, numeric(order.size_matched));
  let status = normalizeVenueStatus(order.status ?? "open");
  if (filledSize >= intent.size) status = "filled";
  else if (filledSize > 0 && status === "open") status = "partially_filled";
  return {
    orderId: order.id ?? intent.clobOrderId,
    status,
    filledSize,
  };
}

function normalizeVenueStatus(status: string): LiveOrderSnapshot["status"] {
  const s = status.toLowerCase();
  if (s.includes("fill") || s.includes("match")) return "filled";
  if (s.includes("partial")) return "partially_filled";
  if (s.includes("cancel")) return "canceled";
  if (s.includes("reject") || s.includes("fail")) return "rejected";
  if (s.includes("expir")) return "expired";
  if (s.includes("open") || s.includes("live")) return "open";
  return "submitted";
}

function numeric(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stringish(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampFilled(size: number, value: number): number {
  return Math.min(size, Math.max(0, value));
}
