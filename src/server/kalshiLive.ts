// Kalshi live execution adapter — SHIPS LOCKED.
//
// Live Kalshi trading requires: user-provided Kalshi API credentials
// (KALSHI_API_KEY_ID + RSA private key for request signing), the per-venue
// live flag in settings, venue-specific terms acknowledgment, and Kalshi
// eligibility (regulated US event contracts). None of that can be assumed,
// so submission always fails closed with a clear operator message. The demo
// environment (KALSHI_DEMO_API_URL) uses separate credentials and is the
// recommended first step.

import type { LiveOrderIntent } from "@/lib/types";

export async function submitKalshiOrder(_intent: LiveOrderIntent): Promise<{ orderId: string }> {
  throw new Error(
    "Kalshi live trading is not configured. It requires KALSHI_API_KEY_ID and a signing key, the per-venue live flag in Settings, and Kalshi terms/eligibility acknowledgment (see README — Venues). Start with the Kalshi demo environment. No order was sent.",
  );
}

export async function cancelKalshiOrder(_orderId: string): Promise<void> {
  throw new Error("Kalshi live trading is not configured — nothing to cancel upstream.");
}
