import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedemptionStore } from "../src/redemption-store.ts";

let directory: string;
let file: string;
const entry = {
  idempotencyKey: "42e61f48-2a63-4080-b254-b367047e28e4",
  expiresAtMs: 1_800_000_180_000,
  completed: false,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-reset-state-"));
  file = join(directory, "state.json");
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe("durable redemption state", () => {
  it("starts empty when no state file exists", async () => {
    const store = createRedemptionStore(file);
    expect(await store.get("credit-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("preserves an uncertain request key across process restarts", async () => {
    await createRedemptionStore(file).put("credit-1", entry);
    expect(await createRedemptionStore(file).get("credit-1")).toEqual(entry);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("lists credit IDs alongside pending request keys after restart", async () => {
    await createRedemptionStore(file).put("credit-1", entry);
    expect(await createRedemptionStore(file).list()).toEqual([{ ...entry, creditId: "credit-1" }]);
  });

  it("persists success so a stale server snapshot cannot redeem it again", async () => {
    const store = createRedemptionStore(file);
    await store.put("credit-1", entry);
    await store.put("credit-1", { ...entry, completed: true });
    expect((await createRedemptionStore(file).get("credit-1"))?.completed).toBe(true);
  });

  it("removes a definitive failed attempt so the next attempt can get a new key", async () => {
    const store = createRedemptionStore(file);
    await store.put("credit-1", entry);
    await store.remove("credit-1");
    expect(await createRedemptionStore(file).get("credit-1")).toBeUndefined();
  });

  it("prunes only expired entries", async () => {
    const store = createRedemptionStore(file);
    await store.put("expired", entry);
    await store.put("valid", { ...entry, expiresAtMs: entry.expiresAtMs + 1 });
    await store.prune(entry.expiresAtMs);
    const restarted = createRedemptionStore(file);
    expect(await restarted.get("expired")).toBeUndefined();
    expect(await restarted.get("valid")).toBeDefined();
  });

  it.each([
    "broken JSON",
    '{"credit-1":{"idempotencyKey":"invalid"}}',
  ])("fails closed for invalid state: %s", async (content) => {
    await writeFile(file, content);
    const store = createRedemptionStore(file);
    await expect(store.get("credit-1")).rejects.toThrow();
    await expect(store.put("credit-1", entry)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });
});
