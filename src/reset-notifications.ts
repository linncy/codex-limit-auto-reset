import type { RateLimitCredits } from "./codex-schemas.ts";
import type { NotificationStore } from "./notification-store.ts";

export const REMINDER_HOURS = [48, 24, 12, 6, 1] as const;
type Credit = { id: string; expiresAtMs: number };

export const describeUsage = (snapshot: RateLimitCredits | undefined) => {
  const limits = snapshot?.rateLimitsByLimitId?.codex ?? snapshot?.rateLimits;
  if (!limits || (limits.limitId && limits.limitId !== "codex")) return "剩余额度：未知，无法判断 80% 重置条件。";
  const windows = [limits.primary, limits.secondary].filter((window) => window != null);
  if (!windows.length) return "剩余额度：未知，无法判断 80% 重置条件。";
  const lines = windows.map((window, index) => {
    const minutes = window.windowDurationMins;
    const label =
      minutes === 10080 ? "每周" : minutes === 300 ? "5 小时" : minutes ? `${minutes} 分钟` : `窗口 ${index + 1}`;
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return `${label}：剩余 ${Number(remaining.toFixed(2))}%（已用 ${window.usedPercent}%）${remaining >= 80 ? "；注意：剩余 ≥80%，存在无法重置的限制" : ""}`;
  });
  return lines.join("\n");
};

export const createResetNotifications = (
  store: Pick<NotificationStore, "enqueue">,
  { timeZone = "America/Los_Angeles", now = Date.now } = {},
) => {
  const formatTime = (time: number) =>
    `${new Date(time).toLocaleString("zh-CN", { timeZone, hour12: false })} (${timeZone})`;
  return {
    reminders(snapshot: RateLimitCredits, credits: Credit[]) {
      const checkedAt = now();
      let nextInMs = Infinity;
      for (const credit of credits) {
        if (credit.expiresAtMs <= checkedAt) continue;
        // After downtime send only the most recent crossed threshold, rather
        // than a burst of five stale reminders. Future thresholds still fire.
        let due: number | undefined;
        for (const hours of REMINDER_HOURS) {
          const until = credit.expiresAtMs - hours * 3_600_000 - checkedAt;
          if (until > 0) nextInMs = Math.min(nextInMs, until);
          else due = hours;
        }
        if (due === undefined) continue;
        const nextHours = REMINDER_HOURS.find((hours) => hours < due);
        store.enqueue({
          id: `reminder:${credit.id}:${credit.expiresAtMs}:${due}`,
          creditId: credit.id,
          kind: "expiry_reminder",
          outcome: `${due}h`,
          createdAt: checkedAt,
          validUntil: credit.expiresAtMs - (nextHours ?? 0) * 3_600_000,
          message: [
            `【Codex 重置券到期提醒｜${due} 小时】`,
            `券：${credit.id}`,
            `到期：${formatTime(credit.expiresAtMs)}`,
            `当前剩余约 ${Math.ceil((credit.expiresAtMs - checkedAt) / 60_000)} 分钟。`,
            describeUsage(snapshot),
            `检查时间：${formatTime(checkedAt)}`,
          ].join("\n"),
        });
      }
      return nextInMs;
    },
    result(credit: Credit, key: string, outcome: string, snapshot: RateLimitCredits | undefined, detail?: string) {
      const succeeded = outcome === "reset" || outcome === "alreadyRedeemed";
      const checkedAt = now();
      const reason =
        outcome === "nothingToReset"
          ? "重置失败：服务器返回 nothingToReset，未重置额度、未消耗重置券。剩余额度 ≥80% 时无法重置。"
          : outcome === "noCredit"
            ? "重置失败：服务器返回 noCredit，无可用重置券。"
            : outcome === "alreadyRedeemed"
              ? "服务器确认该券此前已兑换（alreadyRedeemed）。"
              : outcome === "reset"
                ? "服务器确认重置成功（reset）。"
                : "本次重置请求失败，结果尚未确认；将使用原请求标识重试核实。";
      store.enqueue({
        id: `result:${credit.id}:${key}:${outcome}`,
        creditId: credit.id,
        kind: succeeded ? "reset_succeeded" : "reset_failed",
        outcome,
        createdAt: checkedAt,
        validUntil: null,
        message: [
          `【Codex 重置${succeeded ? "成功" : "失败"}】`,
          `券：${credit.id}`,
          reason,
          ...(detail ? [`错误：${detail.slice(0, 200)}`] : []),
          `到期：${formatTime(credit.expiresAtMs)}`,
          `请求前额度：\n${describeUsage(snapshot)}`,
          `时间：${formatTime(checkedAt)}`,
        ].join("\n"),
      });
    },
  };
};

export type ResetNotifications = ReturnType<typeof createResetNotifications>;
