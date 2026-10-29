import { setTimeout as delay } from "node:timers/promises";
import { CHIRPY_TOKEN, CHIRPY_URL } from "./chirpy-defaults.ts";
import type { NotificationStore } from "./notification-store.ts";

export const createChirpySender =
  ({ url = CHIRPY_URL, token = CHIRPY_TOKEN, timeoutMs = 10_000 } = {}) =>
  async (message: string, signal: AbortSignal) => {
    // WeCom's text limit is byte-based; retain whole Unicode characters.
    let text = "";
    let bytes = 0;
    for (const character of message) {
      bytes += Buffer.byteLength(character);
      if (bytes > 1800) break;
      text += character;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "codex-limit-auto-reset/0.1.0",
      },
      body: JSON.stringify({ token, text }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (response.status !== 200) throw Error(`Chirpy HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("msg" in result) || result.msg !== "success") {
      throw Error("Chirpy rejected the notification");
    }
  };

export const runNotificationDispatcher = async ({
  store,
  send,
  signal,
  now = Date.now,
  logger = console,
  sleep = async (ms: number, abortSignal: AbortSignal) => {
    await delay(ms, undefined, { signal: abortSignal });
  },
}: {
  store: NotificationStore;
  send: (message: string, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  now?: () => number;
  logger?: Pick<Console, "log" | "warn">;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) => {
  while (!signal.aborted) {
    const pending = store.pending(now());
    if (pending) {
      let delivered = false;
      try {
        await send(pending.event.message, signal);
        delivered = true;
      } catch (error) {
        if (signal.aborted) break;
        const reason = error instanceof Error ? error.message : String(error);
        store.failed(pending.event.id, pending.attempts, now(), reason);
        logger.warn(`Chirpy delivery failed; queued for retry: ${pending.event.id}: ${reason}`);
      }
      if (delivered) {
        store.delivered(pending.event.id, now());
        logger.log(`Chirpy notification delivered: ${pending.event.id}`);
      }
    }
    try {
      await sleep(1_000, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
};
