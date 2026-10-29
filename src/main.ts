import { createChirpySender, runNotificationDispatcher } from "./chirpy.ts";
import { createCodexClient } from "./codex-client.ts";
import { parseConfig } from "./config.ts";
import { createNotificationStore } from "./notification-store.ts";
import { createRedemptionStore } from "./redemption-store.ts";
import { runMonitor } from "./reset-monitor.ts";
import { createResetNotifications } from "./reset-notifications.ts";

const config = parseConfig(process.env);
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const notificationStore = createNotificationStore(
  config.NOTIFICATION_STATE_FILE ?? `${config.STATE_FILE}.notifications.sqlite`,
);
const notifications = createResetNotifications(notificationStore, {
  timeZone: config.NOTIFICATION_TIMEZONE ?? "America/Los_Angeles",
});
console.log(`Automatically applying reset credits ${config.REDEEM_BEFORE_MINUTES} minute(s) before expiry.`);
console.log("Chirpy reminders enabled: 48h, 24h, 12h, 6h, 1h before expiry, plus every reset result.");
const jobs: Promise<void>[] = [];
try {
  jobs.push(
    runMonitor({
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
      notifications,
    }),
  );
  jobs.push(
    runNotificationDispatcher({
      store: notificationStore,
      send: createChirpySender({
        ...(config.CHIRPY_URL ? { url: config.CHIRPY_URL } : {}),
        ...(config.CHIRPY_TOKEN ? { token: config.CHIRPY_TOKEN } : {}),
      }),
      signal: controller.signal,
    }),
  );
  await Promise.all(jobs);
} finally {
  controller.abort();
  await Promise.allSettled(jobs);
  notificationStore.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
