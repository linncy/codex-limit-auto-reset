import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumeCredit, RateLimitCredits } from "../src/codex-schemas.ts";
import type { Redemption, RedemptionStore } from "../src/redemption-store.ts";
import {
  checkCredits,
  INITIAL_BACKOFF_MS,
  RESCAN_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  runMonitor,
} from "../src/reset-monitor.ts";
import type { ResetNotifications } from "../src/reset-notifications.ts";

type Credit = RateLimitCredits["rateLimitResetCredits"]["credits"][number];
const NOW = 1_800_000_000_000;
const credit = (overrides: Partial<Credit> = {}): Credit => ({
  id: "credit-1",
  status: "available",
  resetType: "codexRateLimits",
  grantedAt: NOW / 1000 - 86_400,
  expiresAt: NOW / 1000 + 60,
  ...overrides,
});
const snapshot = (...credits: Credit[]): RateLimitCredits => ({
  rateLimitResetCredits: { availableCount: credits.length, credits },
});

const harness = (response = snapshot(credit())) => {
  const entries = new Map<string, Redemption>();
  const store: RedemptionStore = {
    get: vi.fn(async (id) => entries.get(id)),
    list: vi.fn(async () => [...entries].map(([creditId, value]) => ({ ...value, creditId }))),
    put: vi.fn(async (id, value) => {
      entries.set(id, value);
    }),
    remove: vi.fn(async (id) => {
      entries.delete(id);
    }),
    prune: vi.fn(async (now) => {
      for (const [id, value] of entries) if (value.expiresAtMs <= now) entries.delete(id);
    }),
  };
  const client = {
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    refreshAccount: vi.fn(async () => {}),
    readCredits: vi.fn(async () => response),
    consumeCredit: vi.fn<(creditId: string, idempotencyKey: string) => Promise<ConsumeCredit>>(async () => ({
      outcome: "reset",
    })),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const check = (notifications?: ResetNotifications) =>
    checkCredits({ client, store, redeemBeforeMinutes: 1, logger, ...(notifications ? { notifications } : {}) });
  return { client, entries, store, logger, check };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("one-minute redemption window", () => {
  it("does not redeem even one millisecond before the deadline", async () => {
    vi.setSystemTime(NOW - 1);
    const h = harness();
    expect(await h.check()).toBe(1);
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });

  it("redeems exactly at the one-minute boundary and reads updated limits", async () => {
    const h = harness();
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
    expect(h.client.consumeCredit.mock.calls[0]?.[0]).toBe("credit-1");
    expect(h.client.consumeCredit.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.client.readCredits).toHaveBeenCalledTimes(2);
    expect(h.entries.get("credit-1")?.completed).toBe(true);
  });

  it("catches up when started within the final minute", async () => {
    vi.setSystemTime(NOW + 30_000);
    const h = harness();
    await h.check();
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
  });

  it.each([
    { expiresAt: NOW / 1000 },
    { expiresAt: NOW / 1000 - 1 },
    { expiresAt: null },
    { status: "redeemed" as const },
    { status: "redeeming" as const },
    { resetType: "unknown" as const },
  ])("does not redeem an ineligible credit: %j", async (overrides) => {
    const h = harness(snapshot(credit(overrides)));
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });

  it("rechecks expiry after saving the request key", async () => {
    const h = harness();
    vi.mocked(h.store.put).mockImplementation(async (id, value) => {
      h.entries.set(id, value);
      vi.setSystemTime(NOW + 60_000);
    });
    await h.check();
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });

  it("cannot send a request if its key could not be persisted", async () => {
    const h = harness();
    vi.mocked(h.store.put).mockRejectedValueOnce(Error("disk full"));
    await expect(h.check()).rejects.toThrow("disk full");
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });

  it("rechecks the deadline if the clock moves backward during a state write", async () => {
    const h = harness();
    vi.mocked(h.store.put).mockImplementation(async (id, value) => {
      h.entries.set(id, value);
      vi.setSystemTime(NOW - 1_000);
    });
    expect(await h.check()).toBe(1_000);
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });
});

describe("redemption outcomes", () => {
  it.each([
    "reset",
    "alreadyRedeemed",
    "nothingToReset",
    "noCredit",
  ] as const)("records and notifies the %s result before finalizing the request", async (outcome) => {
    const h = harness();
    h.client.consumeCredit.mockResolvedValueOnce({ outcome });
    const notifications = { reminders: vi.fn(() => Infinity), result: vi.fn() };
    await h.check(notifications);
    expect(notifications.result).toHaveBeenCalledWith(
      { id: "credit-1", expiresAtMs: NOW + 60_000 },
      expect.any(String),
      outcome,
      expect.any(Object),
    );
    const notificationOrder = notifications.result.mock.invocationCallOrder[0] as number;
    if (outcome === "nothingToReset" || outcome === "noCredit") {
      expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining(`reset FAILED (${outcome})`));
      expect(notificationOrder).toBeLessThan(vi.mocked(h.store.remove).mock.invocationCallOrder[0] as number);
    } else {
      expect(notificationOrder).toBeLessThan(vi.mocked(h.store.put).mock.invocationCallOrder[1] as number);
    }
  });

  it("notifies ambiguous request failures without losing the replay key", async () => {
    const h = harness();
    h.client.consumeCredit.mockRejectedValueOnce(Error("timed out"));
    const notifications = { reminders: vi.fn(() => Infinity), result: vi.fn() };
    await expect(h.check(notifications)).rejects.toThrow("timed out");
    expect(notifications.result).toHaveBeenCalledWith(
      expect.any(Object),
      h.entries.get("credit-1")?.idempotencyKey,
      "requestFailed",
      expect.any(Object),
      "timed out",
    );
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("result unconfirmed"));
  });

  it("retains the request for replay if persisting a successful result fails", async () => {
    const h = harness();
    const notifications = {
      reminders: vi.fn(() => Infinity),
      result: vi.fn<ResetNotifications["result"]>(() => {
        throw Error("disk full");
      }),
    };
    await expect(h.check(notifications)).rejects.toThrow("disk full");
    expect(h.entries.get("credit-1")?.completed).toBe(false);
    const key = h.entries.get("credit-1")?.idempotencyKey;
    notifications.result.mockImplementation(() => {});
    h.client.consumeCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    await h.check(notifications);
    expect(h.client.consumeCredit.mock.calls[1]?.[1]).toBe(key);
    expect(h.entries.get("credit-1")?.completed).toBe(true);
  });
  it.each(["nothingToReset", "noCredit"] as const)("retries %s with a new logical request key", async (outcome) => {
    const h = harness();
    h.client.consumeCredit.mockResolvedValueOnce({ outcome });
    expect(await h.check()).toBe(RETRY_INTERVAL_MS);
    expect(h.entries.size).toBe(0);
    expect(h.logger.log).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + RETRY_INTERVAL_MS);
    await h.check();
    const [first, second] = h.client.consumeCredit.mock.calls;
    expect(first?.[1]).not.toBe(second?.[1]);
    expect(h.logger.log).toHaveBeenCalledOnce();
  });

  it("preserves the request key after a timeout and handles alreadyRedeemed as success", async () => {
    const h = harness();
    h.client.consumeCredit.mockRejectedValueOnce(Error("timed out"));
    await expect(h.check()).rejects.toThrow("timed out");
    expect(h.entries.get("credit-1")?.completed).toBe(false);
    h.client.consumeCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    await h.check();
    expect(h.client.consumeCredit.mock.calls[0]?.[1]).toBe(h.client.consumeCredit.mock.calls[1]?.[1]);
    expect(h.entries.get("credit-1")?.completed).toBe(true);
    await h.check();
    expect(h.client.consumeCredit).toHaveBeenCalledTimes(2);
  });

  it.each([
    "redeeming",
    "redeemed",
    "missing",
  ] as const)("confirms an uncertain redemption when the credit is %s in the next snapshot", async (status) => {
    const h = harness();
    h.client.consumeCredit.mockRejectedValueOnce(Error("timed out"));
    await expect(h.check()).rejects.toThrow("timed out");
    const key = h.entries.get("credit-1")?.idempotencyKey;
    h.client.readCredits.mockResolvedValue(status === "missing" ? snapshot() : snapshot(credit({ status })));
    h.client.consumeCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    await h.check();
    expect(h.client.consumeCredit).toHaveBeenCalledTimes(2);
    expect(h.client.consumeCredit.mock.calls[1]).toEqual(["credit-1", key]);
    expect(h.entries.get("credit-1")?.completed).toBe(true);
  });

  it("does not replay an uncertain request after its known expiry", async () => {
    const h = harness();
    h.client.consumeCredit.mockRejectedValueOnce(Error("timed out"));
    await expect(h.check()).rejects.toThrow("timed out");
    h.client.readCredits.mockResolvedValue(snapshot());
    vi.setSystemTime(NOW + 60_000);
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
  });

  it("respects a shorter expiry returned for an uncertain request", async () => {
    const h = harness();
    h.client.consumeCredit.mockRejectedValueOnce(Error("timed out"));
    await expect(h.check()).rejects.toThrow("timed out");
    h.client.readCredits.mockResolvedValue(snapshot(credit({ status: "redeeming", expiresAt: NOW / 1000 })));
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
  });

  it("stops retrying at expiry instead of sending a late redemption", async () => {
    const h = harness();
    h.client.consumeCredit.mockResolvedValueOnce({ outcome: "nothingToReset" });
    vi.setSystemTime(NOW + 50_000);
    expect(await h.check()).toBe(10_000);
    vi.setSystemTime(NOW + 60_000);
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
  });

  it("tries the soonest-expiring credit first and refreshes before the next credit", async () => {
    const earlier = credit({ id: "earlier", expiresAt: NOW / 1000 + 40 });
    const later = credit({ id: "later" });
    const h = harness(snapshot(later, earlier));
    h.client.readCredits.mockResolvedValueOnce(snapshot(later, earlier)).mockResolvedValueOnce(snapshot(later));
    h.client.consumeCredit
      .mockResolvedValueOnce({ outcome: "reset" })
      .mockResolvedValueOnce({ outcome: "nothingToReset" });
    expect(await h.check()).toBe(RETRY_INTERVAL_MS);
    expect(h.client.consumeCredit.mock.calls.map((call) => call[0])).toEqual(["earlier", "later"]);
    expect(h.client.readCredits.mock.invocationCallOrder[1]).toBeGreaterThan(
      h.client.consumeCredit.mock.invocationCallOrder[0] as number,
    );
    expect(h.client.readCredits.mock.invocationCallOrder[1]).toBeLessThan(
      h.client.consumeCredit.mock.invocationCallOrder[1] as number,
    );
  });

  it("does not blindly redeem a count without expiry details", async () => {
    const h = harness({ rateLimitResetCredits: { availableCount: 2, credits: [] } });
    expect(await h.check()).toBe(RESCAN_INTERVAL_MS);
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledOnce();
  });
});

describe("request frequency and recovery", () => {
  it("wakes for a reminder sooner than the six-hour rescan without redeeming early", async () => {
    const h = harness(snapshot(credit({ expiresAt: NOW / 1000 + 49 * 3600 })));
    const notifications = { reminders: vi.fn(() => 3_600_000), result: vi.fn() };
    expect(await h.check(notifications)).toBe(3_600_000);
    expect(h.client.consumeCredit).not.toHaveBeenCalled();
  });
  it("waits six hours between routine scans", async () => {
    const h = harness(snapshot());
    const controller = new AbortController();
    const waits: number[] = [];
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      logger: h.logger,
      signal: controller.signal,
      sleep: async (ms) => {
        waits.push(ms);
        vi.setSystemTime(Date.now() + ms);
        if (waits.length === 2) controller.abort();
      },
    });
    expect(waits).toEqual([RESCAN_INTERVAL_MS, RESCAN_INTERVAL_MS]);
    expect(h.client.readCredits).toHaveBeenCalledTimes(2);
    expect(h.client.initialize).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });

  it("uses a local timer for a known deadline without intervening server requests", async () => {
    const h = harness(snapshot(credit({ expiresAt: NOW / 1000 + 65 })));
    const controller = new AbortController();
    const waits: number[] = [];
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      logger: h.logger,
      signal: controller.signal,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 1) {
          expect(h.client.readCredits).toHaveBeenCalledOnce();
          expect(h.client.consumeCredit).not.toHaveBeenCalled();
          vi.setSystemTime(Date.now() + ms);
        } else controller.abort();
      },
    });
    expect(waits).toEqual([5_000, RESCAN_INTERVAL_MS]);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
    expect(h.client.readCredits).toHaveBeenCalledTimes(3);
  });

  it("backs off repeated connection failures rather than polling continuously", async () => {
    const h = harness();
    h.client.initialize.mockRejectedValue(Error("offline"));
    const controller = new AbortController();
    const waits: number[] = [];
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      logger: h.logger,
      signal: controller.signal,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) controller.abort();
      },
    });
    expect(waits).toEqual([INITIAL_BACKOFF_MS, INITIAL_BACKOFF_MS * 2, INITIAL_BACKOFF_MS * 4]);
    expect(h.client.close).toHaveBeenCalledTimes(3);
  });

  it("keeps retries within the known redemption window after a server failure", async () => {
    const h = harness(snapshot(credit({ expiresAt: NOW / 1000 + 80 })));
    h.client.readCredits
      .mockResolvedValueOnce(snapshot(credit({ expiresAt: NOW / 1000 + 80 })))
      .mockRejectedValueOnce(Error("offline"));
    const controller = new AbortController();
    const waits: number[] = [];
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      logger: h.logger,
      signal: controller.signal,
      sleep: async (ms) => {
        waits.push(ms);
        vi.setSystemTime(Date.now() + ms);
        if (waits.length === 2) controller.abort();
      },
    });
    expect(waits).toEqual([20_000, RETRY_INTERVAL_MS]);
  });

  it("uses persisted pending deadlines when initialization fails after restart", async () => {
    const h = harness();
    h.entries.set("credit-1", {
      idempotencyKey: "42e61f48-2a63-4080-b254-b367047e28e4",
      expiresAtMs: NOW + 60_000,
      completed: false,
    });
    h.client.initialize.mockRejectedValue(Error("offline"));
    const controller = new AbortController();
    const sleep = vi.fn(async () => controller.abort());
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      signal: controller.signal,
      logger: h.logger,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(RETRY_INTERVAL_MS, controller.signal);
  });

  it("does not repeatedly retry a completed credit when the post-reset refresh fails", async () => {
    const h = harness();
    h.client.readCredits.mockResolvedValueOnce(snapshot(credit())).mockRejectedValueOnce(Error("offline"));
    const controller = new AbortController();
    const sleep = vi.fn(async () => controller.abort());
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      signal: controller.signal,
      logger: h.logger,
      sleep,
    });
    expect(h.entries.get("credit-1")?.completed).toBe(true);
    expect(sleep).toHaveBeenCalledWith(INITIAL_BACKOFF_MS, controller.signal);
    expect(h.client.consumeCredit).toHaveBeenCalledOnce();
  });

  it("closes the app-server when an aborted sleep rejects", async () => {
    const h = harness(snapshot());
    const controller = new AbortController();
    await runMonitor({
      createClient: () => h.client,
      store: h.store,
      redeemBeforeMinutes: 1,
      logger: h.logger,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw Error("aborted");
      },
    });
    expect(h.client.close).toHaveBeenCalledOnce();
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});
