// Coinbase live execution adapter — SHIPS LOCKED.
//
// Live Coinbase trading requires user-scoped Advanced Trade API credentials
// (COINBASE_API_KEY_NAME + COINBASE_API_PRIVATE_KEY, minimum scopes), the
// per-venue live flag in settings, and its own confirmation flow. Coinbase
// is never used as an automatic hedge unless the user explicitly enables
// hedge automation (not implemented). Submission fails closed.

import type { LiveOrderIntent } from "@/lib/types";

export async function submitCoinbaseOrder(_intent: LiveOrderIntent): Promise<{ orderId: string }> {
  throw new Error(
    "Coinbase live trading is not configured. It requires scoped Advanced Trade API credentials (COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY) and the per-venue live flag in Settings (see README — Venues). No order was sent.",
  );
}

export async function cancelCoinbaseOrder(_orderId: string): Promise<void> {
  throw new Error("Coinbase live trading is not configured — nothing to cancel upstream.");
}
