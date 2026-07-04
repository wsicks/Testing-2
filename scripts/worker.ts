// Standalone background worker: continuous market scanning, signal
// generation, paper-order settlement and portfolio snapshots — independent of
// web traffic. Run with `npm run worker` (shares the store with the web app
// when STORAGE_DRIVER=prisma; with the memory store it shares the JSON file).

import { scanOnce } from "../src/server/scanner";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);

async function loop() {
  try {
    const summary = await scanOnce(true);
    console.log(
      `[worker] scanned=${summary.scanned} books=${summary.booksFetched} signals=${summary.signalsCreated} rejected=${summary.signalsRejected}`,
    );
  } catch (err) {
    console.error("[worker] scan failed:", err instanceof Error ? err.message : err);
  }
}

console.log(`[worker] PolyQuant scanner starting (every ${INTERVAL_MS / 1000}s)…`);
loop();
setInterval(loop, INTERVAL_MS);
