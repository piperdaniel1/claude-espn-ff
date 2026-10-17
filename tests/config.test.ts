import { describe, expect, it } from "vitest";

import { ConfigError, defaultSeason, loadConfig, normalizeSwid } from "../src/config.ts";
import { TEST_ENV } from "./helpers.ts";

describe("config", () => {
  it("loads a complete environment", () => {
    const cfg = loadConfig(TEST_ENV, new Date("2026-10-15T00:00:00Z"));
    expect(cfg.espn.leagueId).toBe(123456);
    expect(cfg.espn.season).toBe(2026);
    expect(cfg.espn.swid).toBe("{E5A1B2C3-0000-4000-8000-00000000ABCD}");
    expect(cfg.timezone).toBe("America/Denver");
    expect(cfg.auth.devBearerToken).toBe(TEST_ENV.DEV_BEARER_TOKEN);
  });

  it("lists every missing required variable", () => {
    try {
      loadConfig({ ESPN_S2: "x" });
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(["ESPN_SWID", "ESPN_LEAGUE_ID", "CONNECTOR_PASSWORD"]);
    }
  });

  it("normalises SWID braces and case", () => {
    expect(normalizeSwid("abc-def")).toBe("{ABC-DEF}");
    expect(normalizeSwid("{abc-def}")).toBe("{ABC-DEF}");
    expect(loadConfig({ ...TEST_ENV, ESPN_SWID: "e5a1b2c3-0000-4000-8000-00000000abcd" }).espn.swid).toBe("{E5A1B2C3-0000-4000-8000-00000000ABCD}");
  });

  it("derives the season from the date when ESPN_SEASON is unset", () => {
    expect(defaultSeason(new Date("2026-10-15T00:00:00Z"))).toBe(2026);
    expect(defaultSeason(new Date("2027-01-20T00:00:00Z"))).toBe(2026);
    expect(defaultSeason(new Date("2027-07-01T00:00:00Z"))).toBe(2027);
    const cfg = loadConfig({ ...TEST_ENV, ESPN_SEASON: "" }, new Date("2027-02-01T00:00:00Z"));
    expect(cfg.espn.season).toBe(2026);
  });

  it("rejects weak passwords, short secrets, bad timezones and bad ints", () => {
    expect(() => loadConfig({ ...TEST_ENV, CONNECTOR_PASSWORD: "short" })).toThrow(/at least 8/);
    expect(() => loadConfig({ ...TEST_ENV, CONNECTOR_SECRET: "tiny" })).toThrow(/CONNECTOR_SECRET/);
    expect(() => loadConfig({ ...TEST_ENV, TIMEZONE: "Mars/Olympus" })).toThrow(/timezone/i);
    expect(() => loadConfig({ ...TEST_ENV, ESPN_LEAGUE_ID: "abc" })).toThrow(/integer/);
    expect(() => loadConfig({ ...TEST_ENV, PUBLIC_URL: "nope" })).toThrow(/PUBLIC_URL/);
  });

  it("falls back to a password-derived secret and strips trailing slashes from PUBLIC_URL", () => {
    const cfg = loadConfig({ ...TEST_ENV, CONNECTOR_SECRET: "", PUBLIC_URL: "https://ff.example.com/" });
    expect(cfg.auth.secret.startsWith("derived:")).toBe(true);
    expect(cfg.publicUrl).toBe("https://ff.example.com");
  });
});
