/**
 * Small persistence layer. In production this is Netlify Blobs (included on
 * every Netlify plan); in tests and when Blobs is unavailable it degrades to
 * an in-memory map so the connector keeps working, just without memory
 * between runs.
 */

import type { UsedTokenStore } from "../auth/oauth.ts";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  readonly persistent: boolean;
  readonly description: string;
}

export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  readonly persistent: boolean = false;
  readonly description: string = "in-memory (not persisted between runs)";
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

interface BlobStoreLike {
  get(key: string, opts?: { type: "text" }): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/** Netlify Blobs-backed store, loaded lazily so local tooling never needs it. */
export class NetlifyBlobStore implements KeyValueStore {
  private store: BlobStoreLike | null | undefined;
  private failure: string | undefined;
  readonly persistent = true;
  constructor(private readonly storeName = "espn-ff-connector") {}

  get description(): string {
    return this.failure ? `Netlify Blobs unavailable (${this.failure})` : `Netlify Blobs store "${this.storeName}"`;
  }

  private async resolve(): Promise<BlobStoreLike | null> {
    if (this.store !== undefined) return this.store;
    try {
      const mod = (await import("@netlify/blobs")) as { getStore: (name: string) => BlobStoreLike };
      this.store = mod.getStore(this.storeName);
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      this.store = null;
    }
    return this.store;
  }

  async get(key: string): Promise<string | null> {
    const store = await this.resolve();
    if (!store) return null;
    try {
      return (await store.get(key, { type: "text" })) ?? null;
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const store = await this.resolve();
    if (!store) return;
    try {
      await store.set(key, value);
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
    }
  }
}

/** A store that tries Blobs first and falls back to memory when Blobs is missing. */
export class FallbackStore implements KeyValueStore {
  private readonly memory = new MemoryStore();
  constructor(private readonly primary: KeyValueStore) {}
  get persistent(): boolean {
    return this.primary.persistent && !this.primary.description.includes("unavailable");
  }
  get description(): string {
    return this.primary.description;
  }
  async get(key: string): Promise<string | null> {
    const v = await this.primary.get(key);
    return v ?? (await this.memory.get(key));
  }
  async set(key: string, value: string): Promise<void> {
    await this.primary.set(key, value);
    await this.memory.set(key, value);
  }
}

export interface JournalEntry {
  /** ISO timestamp (UTC). */
  at: string;
  season: number;
  week: number | null;
  kind: string;
  text: string;
}

export const JOURNAL_MAX_ENTRIES = 250;

export class Journal {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string,
  ) {}

  get storageDescription(): string {
    return this.store.description;
  }

  get persistent(): boolean {
    return this.store.persistent;
  }

  async readAll(): Promise<JournalEntry[]> {
    const raw = await this.store.get(this.key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
    } catch {
      return [];
    }
  }

  async read(limit = 10, kind?: string): Promise<JournalEntry[]> {
    const all = await this.readAll();
    const filtered = kind ? all.filter((e) => e.kind === kind) : all;
    return filtered.slice(-limit);
  }

  async append(entry: Omit<JournalEntry, "at"> & { at?: string }): Promise<JournalEntry> {
    const all = await this.readAll();
    const full: JournalEntry = { at: entry.at ?? new Date().toISOString(), season: entry.season, week: entry.week, kind: entry.kind, text: entry.text };
    all.push(full);
    while (all.length > JOURNAL_MAX_ENTRIES) all.shift();
    await this.store.set(this.key, JSON.stringify(all));
    return full;
  }
}

/** Replay protection for OAuth codes / refresh tokens on top of the KV store. */
export class KvUsedTokenStore implements UsedTokenStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async markUsed(id: string, expiresAtSeconds: number): Promise<boolean> {
    if (!this.store.persistent) return false; // cannot detect replays without persistence
    const key = `used:${id}`;
    const existing = await this.store.get(key);
    if (existing) {
      try {
        const { exp } = JSON.parse(existing) as { exp: number };
        if (exp > this.nowSeconds()) return true;
      } catch {
        return true;
      }
    }
    await this.store.set(key, JSON.stringify({ exp: expiresAtSeconds }));
    return false;
  }
}
