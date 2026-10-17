import type { AppConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { createApp, type FetchHandler } from "../src/http/router.ts";
import { MemoryStore, type KeyValueStore } from "../src/journal/store.ts";
import { LEAGUE_ID, MY_SWID, NOW, SEASON } from "./fixtures/league.ts";
import { createMockEspn, type MockEspn } from "./fixtures/mockFetch.ts";

export const TEST_ENV = {
  ESPN_S2: "s2-cookie-value",
  ESPN_SWID: MY_SWID,
  ESPN_LEAGUE_ID: String(LEAGUE_ID),
  ESPN_SEASON: String(SEASON),
  CONNECTOR_PASSWORD: "correct horse battery",
  CONNECTOR_SECRET: "0123456789abcdef0123456789abcdef",
  DEV_BEARER_TOKEN: "dev-token-for-tests-1234567890",
  TIMEZONE: "America/Denver",
};

export const ORIGIN = "https://ff.example.test";

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides }, NOW);
}

export interface TestApp {
  app: FetchHandler;
  espn: MockEspn;
  store: KeyValueStore;
  config: AppConfig;
}

export function createTestApp(opts: { env?: Record<string, string | undefined>; now?: () => Date; store?: KeyValueStore } = {}): TestApp {
  const espn = createMockEspn();
  const store = opts.store ?? new MemoryStore();
  const config = testConfig(opts.env);
  const app = createApp({ loadConfig: () => config, fetch: espn.fetch, store, now: opts.now ?? (() => NOW), version: "test" });
  return { app, espn, store, config };
}

export function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

export async function jsonOf<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Persistent in-memory store (so replay protection can be exercised). */
export class PersistentMemoryStore extends MemoryStore {
  override readonly persistent = true;
  override readonly description = "persistent test store";
}
