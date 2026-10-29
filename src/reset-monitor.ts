import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { createCodexClient } from "./codex-client.ts";
import type { ConsumeCredit, RateLimitCredits } from "./codex-schemas.ts";
import type { RedemptionStore } from "./redemption-store.ts";
import type { ResetNotifications } from "./reset-notifications.ts";
import { REMINDER_HOURS } from "./reset-notifications.ts";

export const RESCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = 30_000;
export const INITIAL_BACKOFF_MS = 60_000;

type Client = ReturnType<typeof createCodexClient>;
type Logger = Pick<Console, "log" | "warn" | "error">;
type CheckOptions = {
  client: Pick<Client, "refreshAccount" | "readCredits" | "consumeCredit">;
  store: RedemptionStore;
  redeemBeforeMinutes: number;
  now?: () => number;
  logger?: Logger;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: RateLimitCredits) => void;
  notifications?: ResetNotifications;
};

const availableCredits = (snapshot: RateLimitCredits, now: number) =>
  snapshot.rateLimitResetCredits.credits
    .filter(
      (credit) =>
        credit.status === "available" &&
        credit.resetType === "codexRateLimits" &&
        credit.expiresAt !== null &&
        credit.expiresAt * 1000 > now,
    )
    .map((credit) => ({ id: credit.id, expiresAtMs: (credit.expiresAt as number) * 1000 }))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);

export const checkCredits = async ({
  client,
  store,
  redeemBeforeMinutes,
  now = Date.now,
  logger = console,
  signal,
  onSnapshot,
  notifications,
}: CheckOptions): Promise<number> => {
  const redeemBeforeMs = redeemBeforeMinutes * 60_000;
  await store.prune(now());
  await client.refreshAccount();
  const readCredits = async () => {
    const result = await client.readCredits();
    onSnapshot?.(result);
    return result;
  };
  let snapshot = await readCredits();

  while (true) {
    signal?.throwIfAborted();
    const candidates = new Map<string, { id: string; expiresAtMs: number }>();
    for (const credit of availableCredits(snapshot, now())) {
      if (!(await store.get(credit.id))?.completed) candidates.set(credit.id, credit);
    }
    const reminderDelay = notifications?.reminders(snapshot, [...candidates.values()]) ?? Infinity;
    // An uncertain request must be replayed with its original key even when
    // the service omits the credit or reports it as redeeming/redeemed. The
    // available-credit list alone cannot confirm an in-flight redemption.
    for (const pending of await store.list()) {
      if (pending.completed || pending.expiresAtMs <= now()) continue;
      const current = snapshot.rateLimitResetCredits.credits.find((credit) => credit.id === pending.creditId);
      const expiresAtMs = Math.min(pending.expiresAtMs, (current?.expiresAt ?? Infinity) * 1000);
      if (expiresAtMs > now()) candidates.set(pending.creditId, { id: pending.creditId, expiresAtMs });
      else candidates.delete(pending.creditId);
    }
    const credits = [...candidates.values()].sort((a, b) => a.expiresAtMs - b.expiresAtMs);
    const credit = credits[0];
    if (!credit || credit.expiresAtMs - redeemBeforeMs > now()) {
      if (snapshot.rateLimitResetCredits.availableCount > 0 && !snapshot.rateLimitResetCredits.credits.length) {
        logger.warn("Reset credits exist, but expiry details are unavailable; cannot schedule them safely.");
      }
      // Sleep locally until the exact known deadline; do not poll every minute.
      return Math.max(
        1,
        Math.min(RESCAN_INTERVAL_MS, reminderDelay, ...credits.map((c) => c.expiresAtMs - redeemBeforeMs - now())),
      );
    }

    const previous = await store.get(credit.id);
    const redemption = previous ?? {
      idempotencyKey: randomUUID(),
      expiresAtMs: credit.expiresAtMs,
      completed: false,
    };
    if (!previous) await store.put(credit.id, redemption);

    // Disk writes and account reads can take time. Never initiate a redemption
    // after expiry or after shutdown was requested.
    signal?.throwIfAborted();
    if (credit.expiresAtMs <= now() || credit.expiresAtMs - redeemBeforeMs > now()) continue;

    let outcome: ConsumeCredit["outcome"];
    try {
      ({ outcome } = await client.consumeCredit(credit.id, redemption.idempotencyKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`Credit ${credit.id}: reset request failed; result unconfirmed: ${detail}`);
      notifications?.result(credit, redemption.idempotencyKey, "requestFailed", snapshot, detail);
      throw error;
    }
    // Persist the result/outbox before completing/removing the request key.
    // On a crash the same key is replayed, and the event ID deduplicates delivery.
    notifications?.result(credit, redemption.idempotencyKey, outcome, snapshot);
    if (outcome === "reset" || outcome === "alreadyRedeemed") {
      await store.put(credit.id, { ...redemption, completed: true });
      logger.log(`Credit ${credit.id}: ${outcome}; reset succeeded.`);
      // Read new quota windows before considering another credit.
      snapshot = await readCredits();
    } else {
      // A definitive non-redemption ends this logical attempt. Use a new key
      // next time, rather than replaying a cached unsuccessful result.
      await store.remove(credit.id);
      logger.error(
        `Credit ${credit.id}: reset FAILED (${outcome}); retrying in 30 seconds while the credit remains valid.`,
      );
      return Math.max(1, Math.min(RETRY_INTERVAL_MS, reminderDelay, credit.expiresAtMs - now()));
    }
  }
};

type MonitorOptions = Omit<CheckOptions, "client" | "onSnapshot"> & {
  createClient: () => Client;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export const runMonitor = async ({
  createClient,
  store,
  redeemBeforeMinutes,
  signal,
  now = Date.now,
  logger = console,
  notifications,
  sleep = async (milliseconds, abortSignal) => {
    await delay(milliseconds, undefined, { signal: abortSignal });
  },
}: MonitorOptions) => {
  let client: Client | undefined;
  let lastSnapshot: RateLimitCredits | undefined;
  let lastSnapshotAt = 0;
  let backoff = INITIAL_BACKOFF_MS;
  try {
    while (!signal.aborted) {
      let nextCheckInMs: number;
      try {
        if (!client) {
          client = createClient();
          await client.initialize();
        }
        nextCheckInMs = await checkCredits({
          client,
          store,
          redeemBeforeMinutes,
          signal,
          now,
          logger,
          ...(notifications ? { notifications } : {}),
          onSnapshot: (snapshot) => {
            lastSnapshot = snapshot;
            lastSnapshotAt = now();
          },
        });
        backoff = INITIAL_BACKOFF_MS;
        logger.log(
          `Account check succeeded; ${lastSnapshot?.rateLimitResetCredits.availableCount ?? 0} available reset credits. Next check: ${new Date(now() + nextCheckInMs).toISOString()} (local timer).`,
        );
      } catch (error) {
        if (signal.aborted) break;
        client?.close();
        client = undefined;
        nextCheckInMs = backoff;
        backoff = Math.min(backoff * 2, RESCAN_INTERVAL_MS);
        try {
          const pending = (await store.list()).filter((entry) => !entry.completed && entry.expiresAtMs > now());
          const known = [];
          if (lastSnapshot) {
            for (const credit of availableCredits(lastSnapshot, now())) {
              if (!(await store.get(credit.id))?.completed) known.push(credit);
            }
          }
          for (const credit of [...pending, ...known]) {
            const timeUntilDue = credit.expiresAtMs - redeemBeforeMinutes * 60_000 - now();
            nextCheckInMs = Math.min(nextCheckInMs, timeUntilDue > 0 ? timeUntilDue : RETRY_INTERVAL_MS);
            if (notifications) {
              for (const hours of REMINDER_HOURS) {
                const deadline = credit.expiresAtMs - hours * 3_600_000;
                if (deadline > lastSnapshotAt) {
                  nextCheckInMs = Math.min(nextCheckInMs, deadline > now() ? deadline - now() : RETRY_INTERVAL_MS);
                }
              }
            }
          }
        } catch {
          // Keep backing off if local state cannot be read. Do not redeem
          // without a durable request key.
        }
        logger.error(`Reset check failed; reconnecting in ${nextCheckInMs / 1000} seconds:`, error);
      }
      if (signal.aborted) break;
      try {
        await sleep(Math.max(1, nextCheckInMs), signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    client?.close();
  }
};
