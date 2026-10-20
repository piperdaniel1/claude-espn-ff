import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";

import { MY_SWID, MY_TEAM_ID, OPP_TEAM_ID } from "./fixtures/league.ts";
import { ORIGIN, TEST_ENV, createTestApp, type TestApp } from "./helpers.ts";

const EXPECTED_TOOLS = [
  "get_context",
  "get_my_roster",
  "get_lineup_recommendation",
  "set_lineup",
  "apply_recommended_lineup",
  "get_matchup",
  "get_standings",
  "get_team_roster",
  "get_free_agents",
  "search_players",
  "get_player",
  "get_transactions",
  "get_league_activity",
  "get_nfl_schedule",
  "add_free_agent",
  "claim_waiver_player",
  "drop_player",
  "cancel_pending_transaction",
  "propose_trade",
  "respond_to_trade",
  "read_journal",
  "append_journal",
];

async function connect(t: TestApp, mode: "legacy" | "modern" = "legacy") {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: async (url, init) => t.app(new Request(url, init)),
    authProvider: { token: async () => TEST_ENV.DEV_BEARER_TOKEN },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport, mode === "legacy" ? { prior: { kind: "legacy" } } : undefined);
  return client;
}

function parse(result: { content: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { result, data: parse(result), isError: result.isError === true };
}

describe("MCP server end to end", () => {
  let t: TestApp;
  beforeEach(() => {
    t = createTestApp();
  });

  it("lists every tool over the legacy (2025) protocol", async () => {
    const client = await connect(t, "legacy");
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    const setLineup = tools.tools.find((x) => x.name === "set_lineup")!;
    expect(setLineup.inputSchema).toMatchObject({ type: "object" });
    expect(setLineup.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it("also serves the modern protocol handshake", async () => {
    const client = await connect(t, "modern");
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(EXPECTED_TOOLS.length);
    const { data } = await call(client, "get_standings");
    expect(data.standings[0].name).toBe("Dragon Dynasty");
    await client.close();
  });

  it("get_context returns orientation data", async () => {
    const client = await connect(t);
    const { data, isError } = await call(client, "get_context");
    expect(isError).toBe(false);
    expect(data).toMatchObject({ season: 2026, nfl_week: 7, weekday: "Thursday", phase: "regular_season", timezone: "America/Denver" });
    expect(data.now).toMatch(/Thu, Oct 15, 2026, 10:00 AM MDT/);
    expect(data.my_team).toMatchObject({ id: MY_TEAM_ID, name: "Mile High Maulers", record: "3-3", faab_remaining: 63, roster_spots_open: 0 });
    expect(data.this_week_matchup.opponent.id).toBe(OPP_TEAM_ID);
    expect(data.lineup_issues).toEqual(expect.arrayContaining([expect.stringMatching(/Echo End .* BYE/), expect.stringMatching(/Charlie Carrier .* OUT/)]));
    expect(data.locks.my_next_locking_player.name).toBe("Golf Gadget");
    expect(data.locks).toMatchObject({ week_games_not_started: 12, week_games_in_progress: 0, week_games_final: 0 });
    expect(data.pending_transactions.map((x: any) => x.id).sort()).toEqual(["tx-trade-1", "tx-waiver-1"]);
    expect(data.trades_awaiting_my_response).toBe(1);
    expect(data.league.waivers.uses_faab).toBe(true);
    expect(data.league.waivers.next_run).toMatch(/Oct 21, 2026/);
    expect(data.league.waivers.next_run_is_estimate).toBe(false);
    expect(data.this_week_matchup.my_points_so_far).toBe(14.5);
    expect(data.this_week_matchup.opponent_points_so_far).toBe(6);
    expect(data.my_team.standing).toBe("4 of 10");
    await client.close();
  });

  it("recommends and applies the optimal lineup in one ESPN transaction", async () => {
    const client = await connect(t);
    const rec = await call(client, "get_lineup_recommendation");
    expect(rec.data.unchanged).toBe(false);
    expect(rec.data.projected_total_recommended).toBe(103.7);
    expect(rec.data.moves).toHaveLength(4);
    expect(t.espn.writes).toHaveLength(0);

    const past = await call(client, "get_lineup_recommendation", { week: 5 });
    expect(past.isError).toBe(true);
    const future = await call(client, "get_lineup_recommendation", { week: 8 });
    expect(future.isError).toBe(false);
    expect(future.data.starters.every((s: any) => s.locked === false)).toBe(true);
    expect(JSON.stringify(future.data.warnings)).not.toMatch(/out/i);

    const dry = await call(client, "apply_recommended_lineup", { dry_run: true });
    expect(dry.data.dry_run).toBe(true);
    expect(dry.data.payload.type).toBe("ROSTER");
    expect(t.espn.writes).toHaveLength(0);

    const applied = await call(client, "apply_recommended_lineup");
    expect(applied.isError).toBe(false);
    expect(applied.data.outcome).toBe("applied");
    expect(t.espn.writes).toHaveLength(1);
    const payload = t.espn.writes[0]!;
    expect(payload).toMatchObject({ type: "ROSTER", teamId: MY_TEAM_ID, memberId: MY_SWID, scoringPeriodId: 7, executionType: "EXECUTE", isLeagueManager: false });
    const items = payload.items as any[];
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.type === "LINEUP")).toBe(true);
    expect(items.find((i) => i.playerId === 110)).toMatchObject({ fromLineupSlotId: 20, toLineupSlotId: 2 });
    expect(items.find((i) => i.playerId === 103)).toMatchObject({ fromLineupSlotId: 2, toLineupSlotId: 20 });
    const writeCall = t.espn.calls.find((c) => c.method === "POST")!;
    expect(writeCall.url).toBe(`https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456/transactions/`);
    expect(writeCall.headers["content-type"]).toBe("application/json");
    await client.close();
  });

  it("set_lineup validates before sending", async () => {
    const client = await connect(t);
    const bad = await call(client, "set_lineup", { moves: [{ player_id: 110, to_slot: "RB" }] });
    expect(bad.isError).toBe(true);
    expect(bad.data.errors[0]).toMatch(/RB would hold 3/);
    expect(t.espn.writes).toHaveLength(0);

    const good = await call(client, "set_lineup", {
      moves: [
        { player_id: 103, to_slot: "BE" },
        { player_id: 110, to_slot: "RB" },
      ],
    });
    expect(good.isError).toBe(false);
    expect(good.data.submitted).toContain("Charlie Carrier: RB -> BE");
    expect(t.espn.writes).toHaveLength(1);
    await client.close();
  });

  it("add_free_agent refuses waiver players and full rosters, then adds with a drop", async () => {
    const client = await connect(t);
    const waivers = await call(client, "add_free_agent", { add_player_id: 202, drop_player_id: 116 });
    expect(waivers.isError).toBe(true);
    expect(waivers.data.errors.join(" ")).toMatch(/on waivers/);

    const full = await call(client, "add_free_agent", { add_player_id: 201 });
    expect(full.isError).toBe(true);
    expect(full.data.errors.join(" ")).toMatch(/Roster is full/);

    const ok = await call(client, "add_free_agent", { add_player_id: 201, drop_player_id: 116 });
    expect(ok.isError).toBe(false);
    expect(t.espn.writes[0]).toMatchObject({ type: "FREEAGENT" });
    expect((t.espn.writes[0]!.items as any[])).toEqual([
      { playerId: 201, type: "ADD", toTeamId: MY_TEAM_ID },
      { playerId: 116, type: "DROP", fromTeamId: MY_TEAM_ID },
    ]);
    await client.close();
  });

  it("claim_waiver_player enforces FAAB and submits a bid", async () => {
    const client = await connect(t);
    const noBid = await call(client, "claim_waiver_player", { add_player_id: 202, drop_player_id: 116 });
    expect(noBid.isError).toBe(true);
    expect(noBid.data.errors.join(" ")).toMatch(/bid_amount is required/);
    const tooMuch = await call(client, "claim_waiver_player", { add_player_id: 202, drop_player_id: 116, bid_amount: 999 });
    expect(tooMuch.isError).toBe(true);
    expect(tooMuch.data.errors.join(" ")).toMatch(/exceeds remaining FAAB \$63/);
    const ok = await call(client, "claim_waiver_player", { add_player_id: 202, drop_player_id: 116, bid_amount: 20 });
    expect(ok.isError).toBe(false);
    expect(ok.data.outcome).toBe("pending");
    expect(t.espn.writes[0]).toMatchObject({ type: "WAIVER", bidAmount: 20 });
    await client.close();
  });

  it("drop_player, cancel_pending_transaction, propose_trade and respond_to_trade build the right payloads", async () => {
    const client = await connect(t);
    const drop = await call(client, "drop_player", { player_id: 116 });
    expect(drop.isError).toBe(false);
    expect(t.espn.writes[0]).toMatchObject({ type: "ROSTER", items: [{ playerId: 116, type: "DROP", fromTeamId: MY_TEAM_ID }] });

    const cancel = await call(client, "cancel_pending_transaction", { transaction_id: "tx-waiver-1" });
    expect(cancel.isError).toBe(false);
    expect(t.espn.writes[1]).toMatchObject({ type: "WAIVER", executionType: "CANCEL", relatedTransactionId: "tx-waiver-1" });
    const notMine = await call(client, "cancel_pending_transaction", { transaction_id: "tx-fa-1" });
    expect(notMine.isError).toBe(true);

    const trade = await call(client, "propose_trade", { to_team_id: OPP_TEAM_ID, send_player_ids: [112], receive_player_ids: [503], comment: "Lima for Ty?" });
    expect(trade.isError).toBe(false);
    expect(t.espn.writes[2]).toMatchObject({ type: "TRADE_PROPOSAL", comment: "Lima for Ty?" });
    expect((t.espn.writes[2]!.items as any[])).toEqual([
      { playerId: 112, type: "TRADE", fromTeamId: MY_TEAM_ID, toTeamId: OPP_TEAM_ID },
      { playerId: 503, type: "TRADE", fromTeamId: OPP_TEAM_ID, toTeamId: MY_TEAM_ID },
    ]);
    const badTrade = await call(client, "propose_trade", { to_team_id: OPP_TEAM_ID, send_player_ids: [999], receive_player_ids: [503] });
    expect(badTrade.isError).toBe(true);

    const accept = await call(client, "respond_to_trade", { transaction_id: "tx-trade-1", action: "accept" });
    expect(accept.isError).toBe(false);
    expect(t.espn.writes[3]).toMatchObject({ type: "TRADE_ACCEPT", relatedTransactionId: "tx-trade-1" });
    const decline = await call(client, "respond_to_trade", { transaction_id: "tx-waiver-1", action: "decline" });
    expect(decline.isError).toBe(true);
    await client.close();
  });

  it("surfaces ESPN rejections as tool errors with details", async () => {
    t.espn.writeResponder = () => ({ status: 400, body: { messages: ["Invalid"], details: [{ type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE", message: "Roster full" }] } });
    const client = await connect(t);
    const res = await call(client, "drop_player", { player_id: 116 });
    expect(res.isError).toBe(true);
    expect(res.data.espn_status).toBe(400);
    expect(res.data.espn_details).toContain("TRAN_ROSTER_LIMIT_EXCEEDED_ONE");
    await client.close();
  });

  it("reads players, free agents, matchup, schedule, activity and team rosters", async () => {
    const client = await connect(t);
    const fa = await call(client, "get_free_agents", { positions: ["WR"], sort: "projected_week" });
    expect(fa.data.players[0].name).toBe("Sierra Streak");
    expect(fa.data.players[0].availability).toBe("WAIVERS");

    const search = await call(client, "search_players", { query: "victor" });
    expect(search.data.players[0].id).toBe(205);

    const player = await call(client, "get_player", { player_ids: [101, 999999] });
    expect(player.data.players[0].weekly_points).toEqual({ "5": 22.1, "6": 17.4 });
    expect(player.data.players[0].ros_proj).toBeGreaterThan(0);
    expect(player.data.not_found).toEqual([999999]);

    const badPos = await call(client, "get_free_agents", { positions: ["XYZ"] });
    expect(badPos.isError).toBe(true);

    const matchup = await call(client, "get_matchup");
    expect(matchup.data.opponent.id).toBe(OPP_TEAM_ID);
    expect(matchup.data.me.starters).toHaveLength(9);
    expect(matchup.data).toMatchObject({ result: "in_progress", my_points: 14.5, opponent_points: 6 });
    const lastWeek = await call(client, "get_matchup", { week: 5 });
    expect(["won", "lost"]).toContain(lastWeek.data.result);

    const sched = await call(client, "get_nfl_schedule");
    expect(sched.data.games[0]).toMatchObject({ away: "NYG", home: "PHI", status: "scheduled" });
    expect(sched.data.teams_on_bye).toContain("BUF");

    const activity = await call(client, "get_league_activity");
    expect(activity.data.activity[0].action).toBe("FA ADDED");

    const team = await call(client, "get_team_roster", { team_id: OPP_TEAM_ID });
    expect(team.data.team.name).toBe("Opponent Owls");
    expect(team.data.starters.length).toBe(9);

    const txs = await call(client, "get_transactions", { only_mine: true, only_pending: true });
    expect(txs.data.transactions.map((x: any) => x.id).sort()).toEqual(["tx-trade-1", "tx-waiver-1"]);
    expect(txs.data.transactions.find((x: any) => x.id === "tx-trade-1").note).toMatch(/respond before/);
    const standings = await call(client, "get_standings");
    expect(standings.data.standings[0]).toMatchObject({ rank: 1, name: "Dragon Dynasty", playoff_seed: 1 });
    await client.close();
  });

  it("keeps a journal across calls", async () => {
    const client = await connect(t);
    const empty = await call(client, "read_journal");
    expect(empty.data.entries).toEqual([]);
    const saved = await call(client, "append_journal", { kind: "run_summary", text: "Benched Charlie (OUT), started Juliet." });
    expect(saved.data.saved).toMatchObject({ kind: "run_summary", week: 7, season: 2026 });
    const read = await call(client, "read_journal", { kind: "run_summary" });
    expect(read.data.entries).toHaveLength(1);
    expect(read.data.entries[0].text).toContain("Juliet");
    await client.close();
  });
});
