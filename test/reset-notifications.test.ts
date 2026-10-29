import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RateLimitCredits } from "../src/codex-schemas.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createResetNotifications, describeUsage, REMINDER_HOURS } from "../src/reset-notifications.ts";

const START = 1_800_000_000_000;
const HOUR = 3_600_000;
const credit = { id: "credit-1", expiresAtMs: START + 50 * HOUR };
const usage = (usedPercent: number): RateLimitCredits => ({
  rateLimitResetCredits: { availableCount: 1, credits: [] },
  rateLimits: { limitId: "codex", primary: { usedPercent, windowDurationMins: 10080 } },
});
let directory: string;
let file: string;
let store: ReturnType<typeof createNotificationStore>;
let currentTime: number;
const notifier = () => createResetNotifications(store, { now: () => currentTime, timeZone: "UTC" });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reset-notifications-"));
  file = join(directory, "notifications.sqlite");
  store = createNotificationStore(file);
  currentTime = START;
});
afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe("expiry reminders", () => {
  it("schedules all five exact thresholds, without early or duplicate messages", () => {
    const notifications = notifier();
    expect(notifications.reminders(usage(10), [credit])).toBe(2 * HOUR);
    expect(store.pending(currentTime)).toBeUndefined();
    for (const hours of REMINDER_HOURS) {
      currentTime = credit.expiresAtMs - hours * HOUR - 1;
      expect(notifications.reminders(usage(10), [credit])).toBe(1);
      expect(store.pending(currentTime)).toBeUndefined();
      currentTime += 1;
      notifications.reminders(usage(10), [credit]);
      const pending = store.pending(currentTime);
      expect(pending?.event.outcome).toBe(`${hours}h`);
      expect(pending?.event.message).toContain(
        new Date(credit.expiresAtMs).toLocaleString("zh-CN", { timeZone: "UTC", hour12: false }),
      );
      expect(pending?.event.message).toContain("剩余 90%");
      store.delivered(pending?.event.id as string, currentTime);
      notifications.reminders(usage(10), [credit]);
      expect(store.pending(currentTime)).toBeUndefined();
    }
  });

  it("catches up only the latest threshold after downtime and keeps future ones scheduled", () => {
    currentTime = credit.expiresAtMs - 5 * HOUR;
    expect(notifier().reminders(usage(86), [credit])).toBe(4 * HOUR);
    const pending = store.pending(currentTime);
    expect(pending?.event.outcome).toBe("6h");
    expect(pending?.event.message).toContain("剩余 14%");
    store.delivered(pending?.event.id as string, currentTime);
    expect(store.pending(currentTime)).toBeUndefined();
  });

  it("does not resend delivered reminders after a restart", () => {
    currentTime = credit.expiresAtMs - HOUR;
    notifier().reminders(usage(20), [credit]);
    const pending = store.pending(currentTime);
    store.delivered(pending?.event.id as string, currentTime);
    store.close();
    store = createNotificationStore(file);
    notifier().reminders(usage(20), [credit]);
    expect(store.pending(currentTime)).toBeUndefined();
  });

  it("suppresses stale queued reminders when a newer threshold or expiry is reached", () => {
    currentTime = credit.expiresAtMs - 24 * HOUR;
    notifier().reminders(usage(20), [credit]);
    currentTime = credit.expiresAtMs - 6 * HOUR;
    expect(store.pending(currentTime)).toBeUndefined();
    notifier().reminders(usage(20), [credit]);
    expect(store.pending(currentTime)?.event.outcome).toBe("6h");
    currentTime = credit.expiresAtMs;
    expect(notifier().reminders(usage(20), [credit])).toBe(Infinity);
    expect(store.pending(currentTime)).toBeUndefined();
  });

  it("schedules multiple credits independently", () => {
    currentTime = credit.expiresAtMs - 48 * HOUR;
    const other = { id: "credit-2", expiresAtMs: credit.expiresAtMs + 30_000 };
    expect(notifier().reminders(usage(20), [credit, other])).toBe(30_000);
    const pending = store.pending(currentTime);
    store.delivered(pending?.event.id as string, currentTime);
    currentTime += 30_000;
    notifier().reminders(usage(20), [credit, other]);
    expect(store.pending(currentTime)?.event.creditId).toBe(other.id);
  });
});

describe("remaining usage", () => {
  it.each([0, 19, 20])("warns when used=%s means remaining >=80%%", (used) => {
    expect(describeUsage(usage(used))).toContain("剩余 ≥80%");
  });
  it.each([20.1, 80, 86, 100])("does not invert the remaining threshold for used=%s", (used) => {
    expect(describeUsage(usage(used))).not.toContain("剩余 ≥80%");
  });
  it("uses the codex bucket and includes both quota windows", () => {
    const snapshot = usage(90);
    snapshot.rateLimitsByLimitId = {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 75, windowDurationMins: 10080 },
      },
    };
    expect(describeUsage(snapshot)).toContain("5 小时：剩余 90%");
    expect(describeUsage(snapshot)).toContain("每周：剩余 25%");
  });
  it("reports missing usage as unknown", () => {
    expect(describeUsage(undefined)).toContain("未知");
    expect(describeUsage({ rateLimitResetCredits: { availableCount: 0, credits: [] } })).toContain("未知");
  });
});

describe("durable reset results", () => {
  it("preserves delivery backoff and the event across a restart", () => {
    notifier().result(credit, "request-1", "nothingToReset", usage(10));
    const pending = store.pending(currentTime);
    store.failed(pending?.event.id as string, 0, currentTime, "offline");
    store.close();
    store = createNotificationStore(file);
    expect(store.pending(currentTime + 4_999)).toBeUndefined();
    const retry = store.pending(currentTime + 5_000);
    expect(retry?.event.id).toBe(pending?.event.id);
    expect(retry?.attempts).toBe(1);
  });
  it.each([
    "reset",
    "alreadyRedeemed",
    "nothingToReset",
    "noCredit",
    "requestFailed",
  ])("records and queues %s", (outcome) => {
    const notifications = notifier();
    notifications.result(credit, "request-1", outcome, usage(10), "timeout");
    notifications.result(credit, "request-1", outcome, usage(10), "timeout");
    store.close();
    store = createNotificationStore(file);
    const pending = store.pending(currentTime);
    expect(pending?.event.kind).toBe(
      ["reset", "alreadyRedeemed"].includes(outcome) ? "reset_succeeded" : "reset_failed",
    );
    expect(pending?.event.outcome).toBe(outcome);
    expect(pending?.event.message).toContain(outcome === "requestFailed" ? "尚未确认" : outcome);
    store.delivered(pending?.event.id as string, currentTime);
    expect(store.pending(currentTime)).toBeUndefined();
  });
  it("keeps an undelivered failure after credit expiry, with separate later attempts", () => {
    notifier().result(credit, "request-1", "nothingToReset", usage(10));
    notifier().result(credit, "request-2", "nothingToReset", usage(10));
    currentTime = credit.expiresAtMs + HOUR;
    const first = store.pending(currentTime);
    expect(first?.event.kind).toBe("reset_failed");
    store.delivered(first?.event.id as string, currentTime);
    expect(store.pending(currentTime)?.event.id).not.toBe(first?.event.id);
  });
});
