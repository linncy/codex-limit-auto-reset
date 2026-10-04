import { z } from "zod";

const configSchema = z.object({
  CODEX_BIN: z.string().min(1).default("codex"),
  REDEEM_BEFORE_MINUTES: z.coerce.number().int().min(1).default(3),
  STATE_FILE: z.string().min(1).default(".reset-state.json"),
});

export const parseConfig = (environment: NodeJS.ProcessEnv) => configSchema.parse(environment);
