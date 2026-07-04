// Standalone background worker: continuous market scanning, signal
// generation, autopilot ticks, paper-order settlement and portfolio
// snapshots — independent of web traffic. The autopilot tick runs inside
// scanOnce.
//
// OPERATIONAL CONTRACT — exactly one scheduler:
//   - This worker requires STORAGE_DRIVER=prisma. With the memory store the
//     worker and the web server would each hold a private in-memory state and
//     clobber each other's .data JSON file (last-writer-wins data loss).
//   - Set DISABLE_EMBEDDED_SCANNER=true on the web process so this worker is
//     the only scheduler; otherwise the autopilot runs twice.

import { scanOnce } from "../src/server/scanner";

if (process.env.STORAGE_DRIVER !== "prisma" || !process.env.DATABASE_URL) {
  console.error(
    "[worker] refusing to start: the dedicated worker requires STORAGE_DRIVER=prisma and DATABASE_URL.\n" +
      "[worker] With the memory store, run the embedded scanner in the web process instead (it starts automatically).",
  );
  process.exit(1);
}
if (process.env.DISABLE_EMBEDDED_SCANNER !== "true") {
  console.warn(
    "[worker] WARNING: set DISABLE_EMBEDDED_SCANNER=true on the web process — otherwise both processes schedule scans and the autopilot double-executes.",
  );
}

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
