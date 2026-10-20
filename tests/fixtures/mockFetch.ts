/** A fetch() double that answers like ESPN's API for the fixture league. */

import type { RawLeague } from "../../src/espn/types.ts";
import { ALL_PLAYERS, FREE_AGENTS, LEAGUE_ID, SEASON, WEEK, activityFixture, leagueFixture, poolEntryFor, proScheduleFixture, transactionsFixture, universeFixture } from "./league.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockEspn {
  fetch: typeof fetch;
  calls: RecordedCall[];
  writes: Record<string, unknown>[];
  /** Override the response for POST /transactions/. */
  writeResponder: (payload: Record<string, unknown>) => { status: number; body: unknown };
  /** Override league payload (e.g. to lock a player). */
  league: RawLeague;
  failReadsWith?: { status: number; body: unknown };
}

export function createMockEspn(options: { league?: RawLeague } = {}): MockEspn {
  const mock: MockEspn = {
    calls: [],
    writes: [],
    league: options.league ?? leagueFixture(),
    writeResponder: (payload) => ({
      status: 200,
      body: { ...payload, id: `tx-new-${mock.writes.length}`, status: payload.type === "WAIVER" || payload.type === "TRADE_PROPOSAL" ? "PENDING" : "EXECUTED" },
    }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      const h = new Headers(init?.headers);
      h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      mock.calls.push({ url, method, headers, body });
      return respond(mock, url, method, headers, body);
    }) as typeof fetch,
  };
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function respond(mock: MockEspn, urlStr: string, method: string, headers: Record<string, string>, body: unknown): Response {
  const url = new URL(urlStr);
  const views = url.searchParams.getAll("view");
  const filter = headers["x-fantasy-filter"] ? (JSON.parse(headers["x-fantasy-filter"]) as Record<string, any>) : undefined;

  if (!/espn_s2=[^;]+/.test(headers.cookie ?? "") || !/SWID=\{[^;]+\}/.test(headers.cookie ?? "")) {
    return json({ messages: ["You are not authorized to view this League."] }, 401);
  }

  if (method === "POST" && url.pathname.endsWith("/transactions/")) {
    if (!url.hostname.startsWith("lm-api-writes")) return json({ messages: ["wrong host"] }, 404);
    if (headers["content-type"] !== "application/json") return json({ messages: ["Unsupported Media Type"] }, 415);
    const payload = body as Record<string, unknown>;
    mock.writes.push(payload);
    const res = mock.writeResponder(payload);
    return json(res.body, res.status);
  }

  if (mock.failReadsWith) return json(mock.failReadsWith.body, mock.failReadsWith.status);

  if (url.pathname === `/apis/v3/games/ffl/seasons/${SEASON}` && views.includes("proTeamSchedules_wl")) {
    return json(proScheduleFixture());
  }
  if (url.pathname === `/apis/v3/games/ffl/seasons/${SEASON}/players` && views.includes("players_wl")) {
    return json(universeFixture());
  }
  const leaguePath = `/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}`;
  if (!url.pathname.startsWith(leaguePath)) return json({ messages: ["Not found"] }, 404);

  if (url.pathname === `${leaguePath}/communication/`) return json(activityFixture());

  if (views.includes("kona_player_info")) {
    const f = filter?.players ?? {};
    if (f.filterIds?.value) {
      const ids: number[] = f.filterIds.value;
      return json({ id: LEAGUE_ID, players: ids.map(poolEntryFor).filter(Boolean) });
    }
    const statuses: string[] = f.filterStatus?.value ?? ["FREEAGENT", "WAIVERS"];
    const slots: number[] = f.filterSlotIds?.value ?? [];
    const limit: number = f.limit ?? 50;
    const players = FREE_AGENTS.filter((p) => statuses.includes(p.status))
      .filter((p) => slots.length === 0 || p.eligible.some((s) => slots.includes(s)))
      .sort((a, b) => (b.pctOwned ?? 0) - (a.pctOwned ?? 0))
      .slice(0, limit)
      .map((p) => poolEntryFor(p.id)!);
    return json({ id: LEAGUE_ID, players });
  }

  if (views.includes("mTransactions2") || views.includes("mPendingTransactions")) {
    const period = Number(url.searchParams.get("scoringPeriodId") ?? WEEK);
    const txs = transactionsFixture().filter((t) => t.scoringPeriodId === period);
    const types: string[] | undefined = filter?.transactions?.filterType?.value;
    return json({ id: LEAGUE_ID, transactions: types ? txs.filter((t) => types.includes(t.type)) : txs });
  }

  if (views.includes("mTeam") || views.includes("mRoster") || views.includes("mSettings")) {
    // ESPN echoes the requested scoringPeriodId at the top level of the response.
    const requested = url.searchParams.get("scoringPeriodId");
    return json(requested ? { ...mock.league, scoringPeriodId: Number(requested) } : mock.league);
  }

  return json({ messages: ["Unhandled mock route", urlStr] }, 500);
}

export const FIXTURE_PLAYER_COUNT = ALL_PLAYERS.length;
