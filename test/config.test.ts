import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  it("applies defaults when nothing is set", () => {
    expect(parseConfig({})).toEqual({ CODEX_BIN: "codex", REDEEM_BEFORE_MINUTES: 3, STATE_FILE: ".reset-state.json" });
  });

  it("parses values from the environment", () => {
    expect(parseConfig({ CODEX_BIN: "/usr/local/bin/codex", REDEEM_BEFORE_MINUTES: "1" })).toEqual({
      CODEX_BIN: "/usr/local/bin/codex",
      REDEEM_BEFORE_MINUTES: 1,
      STATE_FILE: ".reset-state.json",
    });
  });

  it("accepts a persistent state path and rejects an empty path", () => {
    expect(parseConfig({ STATE_FILE: "/data/reset-state.json" }).STATE_FILE).toBe("/data/reset-state.json");
    expect(() => parseConfig({ STATE_FILE: "" })).toThrow();
  });

  it("rejects an invalid REDEEM_BEFORE_MINUTES", () => {
    expect(() => parseConfig({ REDEEM_BEFORE_MINUTES: "0" })).toThrow();
    expect(() => parseConfig({ REDEEM_BEFORE_MINUTES: "abc" })).toThrow();
  });
});
