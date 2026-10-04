import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const redemptionSchema = z.object({
  idempotencyKey: z.uuid(),
  expiresAtMs: z.number().int().positive(),
  completed: z.boolean(),
});
const stateSchema = z.record(z.string(), redemptionSchema);

export type Redemption = z.infer<typeof redemptionSchema>;
export type RedemptionStore = {
  get: (creditId: string) => Promise<Redemption | undefined>;
  list: () => Promise<Array<Redemption & { creditId: string }>>;
  put: (creditId: string, redemption: Redemption) => Promise<void>;
  remove: (creditId: string) => Promise<void>;
  prune: (now: number) => Promise<void>;
};

// Persist a request key before sending it, so an uncertain result can be retried
// with the same key even after a process or app-server restart.
export const createRedemptionStore = (file: string): RedemptionStore => {
  let state: Map<string, Redemption> | undefined;
  const load = async () => {
    if (!state) {
      try {
        const data = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
        state = new Map(Object.entries(data));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = new Map();
      }
    }
    return state;
  };

  const save = async (next: Map<string, Redemption>) => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(Object.fromEntries(next))}\n`, { mode: 0o600, flush: true });
      await rename(temporary, file);
      state = next;
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };

  return {
    get: async (creditId) => (await load()).get(creditId),
    list: async () => [...(await load())].map(([creditId, redemption]) => ({ ...redemption, creditId })),
    put: async (creditId, redemption) => {
      const next = new Map(await load());
      next.set(creditId, redemptionSchema.parse(redemption));
      await save(next);
    },
    remove: async (creditId) => {
      const next = new Map(await load());
      if (next.delete(creditId)) await save(next);
    },
    prune: async (now) => {
      const current = await load();
      const next = new Map([...current].filter(([, redemption]) => redemption.expiresAtMs > now));
      if (next.size !== current.size) await save(next);
    },
  };
};
