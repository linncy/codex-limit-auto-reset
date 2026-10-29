import { z } from "zod";

const configSchema = z.object({
  CODEX_BIN: z.string().min(1).default("codex"),
  REDEEM_BEFORE_MINUTES: z.coerce.number().int().min(1).default(1),
  STATE_FILE: z.string().min(1).default(".reset-state.json"),
  NOTIFICATION_STATE_FILE: z.string().min(1).optional(),
  NOTIFICATION_TIMEZONE: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid notification timezone")
    .optional(),
  CHIRPY_URL: z.url().optional(),
  CHIRPY_TOKEN: z.string().min(1).optional(),
});

export const parseConfig = (environment: NodeJS.ProcessEnv) => configSchema.parse(environment);
