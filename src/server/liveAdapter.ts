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

import type { LiveOrderIntent } from "@/lib/types";

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
): Promise<{ orderId: string }> {
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
  return { orderId: res?.orderID ?? res?.orderId ?? "unknown" };
}

export async function cancelLiveOrder(clobOrderId: string): Promise<void> {
  const client = await buildClient();
  await client.cancelOrder({ orderID: clobOrderId });
}
