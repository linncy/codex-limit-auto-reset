import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

it("runs the real entrypoint and RPC client at the deadline without contacting Codex services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-reset-process-"));
  const server = join(directory, "mock-codex.mjs");
  const requests = join(directory, "requests.jsonl");
  const state = join(directory, "state.json");
  await writeFile(
    server,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const expiresAt = Math.floor(Date.now() / 1000) + 181;
let redeemed = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.MOCK_REQUESTS, JSON.stringify({ ...request, time: Date.now(), expiresAt }) + "\\n");
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize": result = { userAgent: "mock" }; break;
    case "account/read": result = { account: { type: "chatgpt" } }; break;
    case "account/rateLimits/read": result = {
      rateLimitResetCredits: {
        availableCount: redeemed ? 0 : 1,
        credits: redeemed ? [] : [{
          id: "integration-credit", status: "available", resetType: "codexRateLimits",
          grantedAt: expiresAt - 86400, expiresAt,
        }],
      },
    }; break;
    case "account/rateLimitResetCredit/consume":
      if (Date.now() < expiresAt * 1000 - 180000 || Date.now() >= expiresAt * 1000) {
        throw Error("Redemption outside the permitted window");
      }
      redeemed = true;
      result = { outcome: "reset" };
      break;
    default: throw Error("Unexpected RPC method " + request.method);
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    cwd: directory,
    env: {
      ...process.env,
      CODEX_BIN: server,
      REDEEM_BEFORE_MINUTES: "3",
      STATE_FILE: state,
      MOCK_REQUESTS: requests,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  try {
    await vi.waitFor(
      async () => {
        const saved = JSON.parse(await readFile(state, "utf8"));
        expect(saved["integration-credit"]?.completed).toBe(true);
        const calls = (await readFile(requests, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const consume = calls.filter((call) => call.method === "account/rateLimitResetCredit/consume");
        expect(consume).toHaveLength(1);
        expect(consume[0].time).toBeGreaterThanOrEqual(consume[0].expiresAt * 1000 - 180_000);
        expect(consume[0].time).toBeLessThan(consume[0].expiresAt * 1000);
        expect(consume[0].params.idempotencyKey).toBe(saved["integration-credit"].idempotencyKey);
        // Startup read, deadline read, then the required post-reset read.
        expect(calls.filter((call) => call.method === "account/rateLimits/read")).toHaveLength(3);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(output).toContain("integration-credit: reset");
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    expect(await exit).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
