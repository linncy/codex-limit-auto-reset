import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChirpySender, runNotificationDispatcher } from "../src/chirpy.ts";
import { createNotificationStore } from "../src/notification-store.ts";

describe("Chirpy protocol", () => {
  let status: number;
  let body: string;
  let received: Array<{ token: string; text: string; userAgent: string | undefined }>;
  let server: ReturnType<typeof createServer>;
  let url: string;
  beforeEach(async () => {
    status = 200;
    body = '{"msg":"success"}';
    received = [];
    server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => {
        data += chunk;
      });
      request.on("end", () => {
        received.push({ ...JSON.parse(data), userAgent: request.headers["user-agent"] });
        response.writeHead(status, { "Content-Type": "application/json", Location: "/redirect" });
        response.end(body);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No test address");
    url = `http://127.0.0.1:${address.port}/send_text`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  it("sends token and text with the application User-Agent and preserves Unicode", async () => {
    await createChirpySender({ url, token: "test-token" })("测试🙂".repeat(500), new AbortController().signal);
    expect(received).toHaveLength(1);
    expect(received[0]?.token).toBe("test-token");
    expect(received[0]?.userAgent).toBe("codex-limit-auto-reset/0.1.0");
    expect(Buffer.byteLength(received[0]?.text ?? "")).toBeLessThanOrEqual(1800);
    expect(received[0]?.text).not.toContain("�");
  });
  it.each([
    [500, '{"msg":"success"}'],
    [302, '{"msg":"success"}'],
    [200, '{"msg":"invalid messenger token"}'],
    [200, "invalid JSON"],
    [200, "[]"],
  ])("rejects HTTP/application errors %s %s", async (httpStatus, responseBody) => {
    status = httpStatus as number;
    body = responseBody as string;
    await expect(
      createChirpySender({ url, token: "test-token" })("notice", new AbortController().signal),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  });
  it("honors shutdown without sending", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createChirpySender({ url, token: "test-token" })("notice", controller.signal)).rejects.toThrow();
    expect(received).toHaveLength(0);
  });
  it("times out an unresponsive messenger", async () => {
    server.removeAllListeners("request");
    server.on("request", () => {});
    await expect(
      createChirpySender({ url, token: "test-token", timeoutMs: 50 })("notice", new AbortController().signal),
    ).rejects.toThrow();
  });
});

it("retries failed delivery independently and only acknowledges a successful send", async () => {
  const store = createNotificationStore(":memory:");
  let currentTime = 100_000;
  store.enqueue({
    id: "result-1",
    creditId: "credit-1",
    kind: "reset_failed",
    outcome: "nothingToReset",
    message: "重置失败",
    createdAt: currentTime,
    validUntil: null,
  });
  const controller = new AbortController();
  const send = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue(undefined);
  const logger = { log: vi.fn(), warn: vi.fn() };
  try {
    await runNotificationDispatcher({
      store,
      send,
      signal: controller.signal,
      now: () => currentTime,
      logger,
      sleep: async () => {
        if (send.mock.calls.length === 1) {
          expect(store.pending(currentTime)).toBeUndefined();
          expect(logger.log).not.toHaveBeenCalled();
          currentTime += 5_000;
          expect(store.pending(currentTime)?.attempts).toBe(1);
        } else controller.abort();
      },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
    expect(store.pending(currentTime)).toBeUndefined();
  } finally {
    store.close();
  }
});
