import { describe, expect, it } from "vitest";

import { EspnClient, EspnHttpError } from "../src/espn/client.ts";
import { LeagueService } from "../src/espn/league.ts";
import { LEAGUE_ID, MY_SWID, MY_TEAM_ID, NOW, OPP_TEAM_ID, SEASON, TNF_KICKOFF, WEEK } from "./fixtures/league.ts";
import { createMockEspn } from "./fixtures/mockFetch.ts";

function service(opts: { now?: Date; swid?: string; teamId?: number; s2?: string } = {}) {
  const espn = createMockEspn();
  const client = new EspnClient({
    season: SEASON,
    leagueId: LEAGUE_ID,
    credentials: { s2: opts.s2 ?? "s2-cookie-value", swid: MY_SWID },
    fetch: espn.fetch,
  });
  const league = new LeagueService({ client, swid: opts.swid ?? MY_SWID, teamIdOverride: opts.teamId, timezone: "America/Denver", now: () => opts.now ?? NOW });
  return { espn, client, league };
}

describe("EspnClient", () => {
  it("sends cookies and views, and unwraps array responses", async () => {
    const { espn, client } = service();
    await client.leagueGet({ views: ["mTeam", "mRoster"], scoringPeriodId: 7 });
    const call = espn.calls[0]!;
    expect(call.url).toContain(`/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mTeam&view=mRoster&scoringPeriodId=7`);
    expect(call.headers.cookie).toBe(`espn_s2=s2-cookie-value; SWID=${MY_SWID}`);
    expect(call.headers["x-fantasy-source"]).toBe("kona");
  });

  it("raises a descriptive auth error on 401", async () => {
    const { client } = service({ s2: "" });
    await expect(client.leagueGet({ views: ["mTeam"] })).rejects.toBeInstanceOf(EspnHttpError);
    try {
      await client.leagueGet({ views: ["mTeam"] });
    } catch (err) {
      const e = err as EspnHttpError;
      expect(e.status).toBe(401);
      expect(e.isAuthError).toBe(true);
      expect(e.message).toMatch(/cookies/);
    }
  });

  it("retries reads once on 5xx and never retries writes", async () => {
    const { espn, client } = service();
    let n = 0;
    espn.failReadsWith = { status: 503, body: { messages: ["down"] } };
    await expect(client.leagueGet({ views: ["mTeam"] })).rejects.toThrow(/HTTP 503/);
    expect(espn.calls.length).toBe(2);
    espn.writeResponder = () => {
      n++;
      return { status: 500, body: { messages: ["boom"] } };
    };
    await expect(client.postTransaction({ type: "ROSTER" })).rejects.toThrow(/HTTP 500/);
    expect(n).toBe(1);
  });

  it("parses ESPN error details", async () => {
    const { espn, client } = service();
    espn.writeResponder = () => ({ status: 400, body: { messages: ["Invalid"], details: [{ type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE", message: "Roster limit exceeded." }] } });
    try {
      await client.postTransaction({ type: "FREEAGENT" });
      throw new Error("should fail");
    } catch (err) {
      const e = err as EspnHttpError;
      expect(e.status).toBe(400);
      expect(e.details[0]?.type).toBe("TRAN_ROSTER_LIMIT_EXCEEDED_ONE");
      expect(e.message).toContain("TRAN_ROSTER_LIMIT_EXCEEDED_ONE");
    }
  });
});

describe("LeagueService snapshot", () => {
  it("finds my team from the SWID and normalises roster/settings", async () => {
    const { league } = service();
    const snap = await league.getSnapshot();
    expect(snap.myTeam.id).toBe(MY_TEAM_ID);
    expect(snap.myTeam.name).toBe("Mile High Maulers");
    expect(snap.myTeam.owners).toEqual(["piperdaniel"]);
    expect(snap.myTeam.record).toMatchObject({ wins: 3, losses: 3, pointsFor: 701.3 });
    expect(snap.myTeam.faabRemaining).toBe(63);
    expect(snap.scoringPeriodId).toBe(WEEK);
    expect(snap.settings.scoringFormat).toBe("PPR");
    expect(snap.settings.rosterLimit).toBe(16);
    expect(snap.settings.irSlots).toBe(1);
    expect(snap.settings.lineupSlots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "D/ST": 1, K: 1, BE: 7, IR: 1, FLEX: 1 });
    expect(Object.values(snap.settings.startingSlotCounts).reduce((a, b) => a + b, 0)).toBe(9);
    expect(snap.settings.waivers).toMatchObject({ usesFaab: true, budget: 100, processDays: ["WEDNESDAY"] });
    expect(snap.settings.trades.deadlinePassed).toBe(false);
    expect(snap.settings.positionLimits).toEqual({ QB: 4, RB: 8, WR: 8, TE: 3, K: 3, "D/ST": 3 });
    expect(snap.myTeam.roster).toHaveLength(17);
    expect(league.rosterCapacity(snap)).toMatchObject({ activeCount: 16, rosterLimit: 16, openSpots: 0, irCount: 1 });
  });

  it("derives game info, byes, projections and lock status", async () => {
    const { league } = service();
    const snap = await league.getSnapshot();
    const byId = new Map(snap.myTeam.roster.map((p) => [p.id, p]));
    const alpha = byId.get(101)!;
    expect(alpha.position).toBe("QB");
    expect(alpha.proTeam).toBe("DEN");
    expect(alpha.projectedWeek).toBe(19.5);
    expect(alpha.seasonPoints).toBe(118.2);
    expect(alpha.weeklyPoints).toEqual({ "5": 22.1, "6": 17.4 });
    expect(alpha.game).toMatchObject({ opponent: "NYJ", home: true, started: false, bye: false });
    expect(alpha.game.kickoff).toMatch(/Sun, Oct 18, 2026, 11:00 AM MDT/);
    expect(alpha.locked).toBe(false);
    const echo = byId.get(105)!;
    expect(echo.game.bye).toBe(true);
    const charlie = byId.get(103)!;
    expect(charlie.injuryStatus).toBe("OUT");
    const golf = byId.get(107)!;
    expect(golf.game.kickoff).toMatch(/Thu, Oct 15, 2026, 6:15 PM MDT/);
    expect(golf.eligibleSlots).toEqual(["RB/WR", "WR", "WR/TE", "OP", "BE", "IR", "FLEX"]);
  });

  it("marks players locked once their game has kicked off", async () => {
    const { league } = service({ now: new Date(TNF_KICKOFF + 60_000) });
    const snap = await league.getSnapshot();
    const golf = snap.myTeam.roster.find((p) => p.id === 107)!;
    expect(golf.locked).toBe(true);
    expect(golf.game.started).toBe(true);
    expect(snap.myTeam.roster.find((p) => p.id === 101)!.locked).toBe(false);
  });

  it("honours ESPN_TEAM_ID and explains SWID mismatches", async () => {
    const other = service({ teamId: OPP_TEAM_ID });
    expect((await other.league.getSnapshot()).myTeam.name).toBe("Opponent Owls");
    const bad = service({ swid: "{NOBODY}" });
    await expect(bad.league.getSnapshot()).rejects.toThrow(/No team in this league is owned by SWID/);
    const badId = service({ teamId: 99 });
    await expect(badId.league.getSnapshot()).rejects.toThrow(/not a team in this league/);
  });

  it("summarises the schedule with my matchup", async () => {
    const { league } = service();
    const snap = await league.getSnapshot();
    const mine = snap.schedule.filter((m) => m.involvesMe);
    expect(mine.length).toBe(14);
    const thisWeek = mine.find((m) => m.matchupPeriod === WEEK)!;
    expect([thisWeek.home.teamId, thisWeek.away?.teamId]).toContain(OPP_TEAM_ID);
    expect(thisWeek.winner).toBe("UNDECIDED");
  });
});

describe("LeagueService players", () => {
  it("lists free agents sorted and filtered", async () => {
    const { league, espn } = service();
    const all = await league.getFreeAgents();
    expect(all.players[0]!.name).toBe("Sierra Streak");
    expect(all.players[0]!.availability).toBe("WAIVERS");
    const filterHeader = JSON.parse(espn.calls.find((c) => c.url.includes("kona_player_info"))!.headers["x-fantasy-filter"]!);
    expect(filterHeader.players.filterStatus.value).toEqual(["FREEAGENT", "WAIVERS"]);
    expect(filterHeader.players.filterSlotIds.value).toEqual([0, 2, 4, 6, 16, 17]);
    expect(filterHeader.players.filterStatsForTopScoringPeriodIds.additionalValue).toContain(`11${SEASON}${WEEK}`);

    const rbs = await league.getFreeAgents({ positions: ["RB"] });
    expect(rbs.players.map((p) => p.name)).toEqual(["Romeo Rookie"]);

    const byProj = await league.getFreeAgents({ sort: "projected_week", includeWaivers: false });
    expect(byProj.players[0]!.name).toBe("Victor Vet");
    expect(byProj.players.every((p) => p.availability === "FREEAGENT")).toBe(true);

    const owned = await league.getFreeAgents({ minPercentOwned: 40 });
    expect(owned.players.map((p) => p.name).sort()).toEqual(["Romeo Rookie", "Sierra Streak", "Victor Vet"]);
  });

  it("fetches players by id with league availability", async () => {
    const { league } = service();
    const [sierra, alpha] = await league.getPlayers([202, 101]);
    expect(sierra!.availability).toBe("WAIVERS");
    expect(alpha!.availability).toBe("ONTEAM");
    expect(alpha!.onTeamName).toBe("Mile High Maulers");
  });

  it("searches the player universe by partial name", async () => {
    const { league } = service();
    const sierra = await league.searchPlayers("sierra");
    expect(sierra[0]!.id).toBe(202);
    const romeo = await league.searchPlayers("romeo rook");
    expect(romeo[0]!.id).toBe(201);
    expect(await league.searchPlayers("zzzz")).toEqual([]);
  });
});

describe("LeagueService transactions & activity", () => {
  it("lists transactions with names, ownership and trade flags", async () => {
    const { league } = service();
    const txs = await league.getTransactions();
    expect(txs.map((t) => t.id).sort()).toEqual(["tx-fa-1", "tx-trade-1", "tx-waiver-1"]);
    const waiver = txs.find((t) => t.id === "tx-waiver-1")!;
    expect(waiver).toMatchObject({ isMine: true, pending: true, bidAmount: 12, team: "Mile High Maulers" });
    expect(waiver.items.map((i) => i.player)).toEqual(["Sierra Streak", "Papa Punt"]);
    const trade = txs.find((t) => t.id === "tx-trade-1")!;
    expect(trade.awaitingMyResponse).toBe(true);
    expect(trade.isMine).toBe(false);
    expect(trade.expires).toMatch(/Oct 16, 2026/);
    const fa = txs.find((t) => t.id === "tx-fa-1")!;
    expect(fa.pending).toBe(false);
    expect(fa.items[0]!.player).toBe("Xray Xtra");
  });

  it("reads the activity feed", async () => {
    const { league } = service();
    const items = await league.getRecentActivity();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ action: "FA ADDED", player: "Xray Xtra", team: "Gator Gang" });
    expect(items[1]).toMatchObject({ action: "DROPPED", player: "Yankee Yard", team: "Gator Gang" });
  });
});

describe("LeagueService lineup validation", () => {
  it("accepts a legal swap and computes from-slots", async () => {
    const { league } = service();
    const snap = await league.getSnapshot();
    const v = league.validateLineupMoves(snap, [
      { playerId: 103, toSlot: "BE" },
      { playerId: 110, toSlot: "RB" },
    ]);
    expect(v.errors).toEqual([]);
    expect(v.moves).toEqual([
      { playerId: 103, fromSlot: 2, toSlot: 20 },
      { playerId: 110, fromSlot: 20, toSlot: 2 },
    ]);
  });

  it("rejects over-full slots, ineligible slots, unknown players and locked players", async () => {
    const { league } = service({ now: new Date(TNF_KICKOFF + 1000) });
    const snap = await league.getSnapshot();
    const full = league.validateLineupMoves(snap, [{ playerId: 110, toSlot: "RB" }]);
    expect(full.errors.join("\n")).toMatch(/RB would hold 3 players but the league allows 2/);
    const inel = league.validateLineupMoves(snap, [{ playerId: 109, toSlot: "RB" }]);
    expect(inel.errors.join("\n")).toMatch(/not eligible for RB/);
    const unknown = league.validateLineupMoves(snap, [{ playerId: 999, toSlot: "BE" }]);
    expect(unknown.errors.join("\n")).toMatch(/not on your roster/);
    const locked = league.validateLineupMoves(snap, [{ playerId: 107, toSlot: "BE" }]);
    expect(locked.errors.join("\n")).toMatch(/locked/);
    const badSlot = league.validateLineupMoves(snap, [{ playerId: 110, toSlot: "QBX" }]);
    expect(badSlot.errors.join("\n")).toMatch(/Unknown slot/);
    const ir = league.validateLineupMoves(snap, [{ playerId: 110, toSlot: "IR" }]);
    // Juliet is eligible for IR slot id 21 per fixture, but IR already holds 1 player.
    expect(ir.errors.join("\n")).toMatch(/IR would hold 2 players/);
  });

  it("treats same-slot moves as warnings, not errors", async () => {
    const { league } = service();
    const snap = await league.getSnapshot();
    const v = league.validateLineupMoves(snap, [{ playerId: 101, toSlot: "QB" }]);
    expect(v.errors).toEqual([]);
    expect(v.moves).toEqual([]);
    expect(v.warnings[0]).toMatch(/already in QB/);
  });
});
