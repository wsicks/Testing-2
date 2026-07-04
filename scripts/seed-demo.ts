// Seed the demo mode: fetches live markets (falls back to mocks offline),
// generates the labeled sample demo account, and writes a few audit events so
// a fresh install has visible, clearly-marked sample content.

import { demoAccount } from "../src/lib/demo/demoData";
import { getMarkets } from "../src/server/marketData";
import { getStore } from "../src/server/store";
import { genId } from "../src/lib/utils";

async function main() {
  const store = await getStore();
  const { markets, source } = await getMarkets();
  console.log(`[seed] loaded ${markets.length} markets (source: ${source})`);

  const account = demoAccount(markets);
  await store.resetMode("demo");
  for (const p of account.positions) await store.upsertPosition(p);
  await store.addFills(account.fills);
  for (const o of account.orders) await store.createOrder(o);

  await store.addAudit({
    id: genId("aud"),
    ts: Date.now(),
    actor: "system",
    type: "demo_seeded",
    severity: "info",
    message:
      "Demo mode seeded with SAMPLE positions/orders (labeled; not real performance)",
  });

  console.log(
    `[seed] demo account: ${account.positions.length} sample positions, ${account.orders.length} sample orders — all labeled SAMPLE`,
  );
  console.log("[seed] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
