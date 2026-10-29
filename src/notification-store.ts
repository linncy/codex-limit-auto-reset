import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type NotificationEvent = {
  id: string;
  creditId: string;
  kind: "expiry_reminder" | "reset_succeeded" | "reset_failed";
  outcome: string;
  message: string;
  createdAt: number;
  validUntil: number | null;
};

// One durable record is both the audit trail and the delivery queue. A unique
// event ID prevents repeats across monitor checks, request replays and restarts.
export const createNotificationStore = (file: string) => {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL,
      valid_until INTEGER, delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, last_error TEXT
    );
  `);
  return {
    enqueue(event: NotificationEvent) {
      db.prepare(`INSERT OR IGNORE INTO notifications
        (id, event, created_at, valid_until, next_attempt_at) VALUES (?, ?, ?, ?, ?)`).run(
        event.id,
        JSON.stringify(event),
        event.createdAt,
        event.validUntil,
        event.createdAt,
      );
    },
    pending(now: number) {
      const row = db
        .prepare(`SELECT id, event, attempts FROM notifications
        WHERE delivered_at IS NULL AND next_attempt_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY created_at, id LIMIT 1`)
        .get(now, now);
      if (!row) return undefined;
      return { event: JSON.parse(String(row.event)) as NotificationEvent, attempts: Number(row.attempts) };
    },
    delivered(id: string, now: number) {
      db.prepare("UPDATE notifications SET delivered_at = ?, last_error = NULL WHERE id = ?").run(now, id);
    },
    failed(id: string, attempts: number, now: number, error: string) {
      const backoff = Math.min(5_000 * 2 ** Math.min(attempts, 6), 300_000);
      db.prepare(`UPDATE notifications SET attempts = attempts + 1,
        next_attempt_at = ?, last_error = ? WHERE id = ?`).run(now + backoff, error, id);
    },
    close: () => db.close(),
  };
};

export type NotificationStore = ReturnType<typeof createNotificationStore>;
