import { createCodexClient } from "./codex-client.ts";
import { parseConfig } from "./config.ts";
import { createRedemptionStore } from "./redemption-store.ts";
import { runMonitor } from "./reset-monitor.ts";

const config = parseConfig(process.env);
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`Automatically applying reset credits ${config.REDEEM_BEFORE_MINUTES} minutes before expiry.`);
try {
  await runMonitor({
    createClient: () =>
      createCodexClient({
        command: config.CODEX_BIN,
        clientInfo: {
          name: "codex_limit_auto_reset",
          title: "Codex Limit Auto Reset",
          version: "0.1.0",
        },
      }),
    store: createRedemptionStore(config.STATE_FILE),
    redeemBeforeMinutes: config.REDEEM_BEFORE_MINUTES,
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
