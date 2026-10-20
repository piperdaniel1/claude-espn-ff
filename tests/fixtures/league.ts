/**
 * Synthetic ESPN fixtures. Structure mirrors the real v3 API closely enough
 * that the parsing code is exercised as it would be in production.
 *
 * Scenario: 2026 season, NFL week 7, "now" is Thursday Oct 15 2026 10:00 MDT
 * (16:00 UTC), before Thursday Night Football.
 */

import type { RawLeague, RawPlayerPoolEntry, RawProSchedule, RawRosterEntry, RawStat, RawTransaction } from "../../src/espn/types.ts";

export const SEASON = 2026;
export const WEEK = 7;
export const LEAGUE_ID = 123456;
export const MY_SWID = "{E5A1B2C3-0000-4000-8000-00000000ABCD}";
export const MY_TEAM_ID = 3;
export const OPP_TEAM_ID = 5;
export const NOW = new Date("2026-10-15T16:00:00Z");

// NFL week 7 kickoffs (UTC)
export const TNF_KICKOFF = Date.parse("2026-10-16T00:15:00Z"); // Thu 8:15pm ET
export const SUN_EARLY = Date.parse("2026-10-18T17:00:00Z"); // Sun 1:00pm ET
export const SUN_LATE = Date.parse("2026-10-18T20:25:00Z"); // Sun 4:25pm ET
export const SNF_KICKOFF = Date.parse("2026-10-19T00:20:00Z"); // Sun 8:20pm ET
export const MNF_KICKOFF = Date.parse("2026-10-20T00:15:00Z"); // Mon 8:15pm ET

// Pro team ids: 7 DEN, 12 KC, 8 DET, 16 MIN, 2 BUF (bye), 25 SF, 21 PHI, 33 BAL, 6 DAL,
// 23 PIT, 14 LAR, 24 LAC, 34 HOU, 9 GB, 11 IND, 29 CAR, 1 ATL, 18 NO, 27 TB, 26 SEA, 3 CHI, 4 CIN, 19 NYG, 20 NYJ
const GAMES: { id: number; date: number; home: number; away: number }[] = [
  { id: 7001, date: TNF_KICKOFF, home: 21, away: 19 }, // PHI vs NYG (TNF)
  { id: 7002, date: SUN_EARLY, home: 7, away: 20 }, // DEN vs NYJ
  { id: 7003, date: SUN_EARLY, home: 12, away: 8 }, // KC vs DET
  { id: 7004, date: SUN_EARLY, home: 16, away: 25 }, // MIN vs SF
  { id: 7005, date: SUN_EARLY, home: 33, away: 6 }, // BAL vs DAL
  { id: 7006, date: SUN_LATE, home: 23, away: 14 }, // PIT vs LAR
  { id: 7007, date: SUN_LATE, home: 24, away: 34 }, // LAC vs HOU
  { id: 7008, date: SNF_KICKOFF, home: 9, away: 11 }, // GB vs IND
  { id: 7009, date: MNF_KICKOFF, home: 29, away: 1 }, // CAR vs ATL
  { id: 7010, date: SUN_EARLY, home: 18, away: 27 }, // NO vs TB
  { id: 7011, date: SUN_LATE, home: 26, away: 3 }, // SEA vs CHI
  { id: 7012, date: SUN_EARLY, home: 4, away: 10 }, // CIN vs TEN
];

const PRO_TEAM_ABBREV: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 14: "LAR", 16: "MIN",
  18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 29: "CAR", 33: "BAL", 34: "HOU",
};

/** Next week's games: every fixture team plays, paired in id order, a week later. */
const WEEK8_IDS = Object.keys(PRO_TEAM_ABBREV).map(Number);
const NEXT_WEEK_GAMES: { id: number; date: number; home: number; away: number }[] = [];
for (let i = 0; i + 1 < WEEK8_IDS.length; i += 2) {
  NEXT_WEEK_GAMES.push({ id: 8000 + i, date: SUN_EARLY + 7 * 86_400_000, home: WEEK8_IDS[i]!, away: WEEK8_IDS[i + 1]! });
}

export function proScheduleFixture(): RawProSchedule {
  const toGame = (g: { id: number; date: number; home: number; away: number }, week: number) => ({
    id: g.id,
    date: g.date,
    homeProTeamId: g.home,
    awayProTeamId: g.away,
    scoringPeriodId: week,
    startTimeTBD: false,
    statsOfficial: false,
    validForLocking: true,
  });
  const proTeams = Object.entries(PRO_TEAM_ABBREV).map(([idStr, abbrev]) => {
    const id = Number(idStr);
    const games = GAMES.filter((g) => g.home === id || g.away === id).map((g) => toGame(g, WEEK));
    const next = NEXT_WEEK_GAMES.filter((g) => g.home === id || g.away === id).map((g) => toGame(g, WEEK + 1));
    const byeWeek = games.length === 0 ? WEEK : 11;
    const proGamesByScoringPeriod: Record<string, ReturnType<typeof toGame>[]> = {};
    if (games.length) proGamesByScoringPeriod[String(WEEK)] = games;
    if (next.length) proGamesByScoringPeriod[String(WEEK + 1)] = next;
    return { id, abbrev, location: abbrev, name: abbrev, byeWeek, proGamesByScoringPeriod };
  });
  return { settings: { proTeams } };
}

export interface FixturePlayer {
  id: number;
  name: string;
  posId: number; // defaultPositionId
  proTeamId: number;
  eligible: number[];
  proj: number;
  season: number;
  injuryStatus?: string;
  pctOwned?: number;
  droppable?: boolean;
  weekly?: Record<number, number>;
  /** Points already scored this week (for live-score tests). */
  actualWeek?: number;
}

const QB_SLOTS = [0, 7, 20, 21];
const RB_SLOTS = [2, 3, 7, 20, 21, 23];
const WR_SLOTS = [3, 4, 5, 7, 20, 21, 23];
const TE_SLOTS = [5, 6, 7, 20, 21, 23];
const K_SLOTS = [17, 20, 21];
const DST_SLOTS = [16, 20, 21];

export const MY_PLAYERS: (FixturePlayer & { slot: number })[] = [
  { id: 101, name: "Alpha Quarterback", posId: 1, proTeamId: 7, eligible: QB_SLOTS, proj: 19.5, season: 118.2, slot: 0, pctOwned: 99, weekly: { 5: 22.1, 6: 17.4 } },
  { id: 102, name: "Bravo Back", posId: 2, proTeamId: 12, eligible: RB_SLOTS, proj: 14.2, season: 84.5, slot: 2, pctOwned: 98 },
  { id: 103, name: "Charlie Carrier", posId: 2, proTeamId: 8, eligible: RB_SLOTS, proj: 11.0, season: 61.0, slot: 2, injuryStatus: "OUT", pctOwned: 90 },
  { id: 104, name: "Delta Deep", posId: 3, proTeamId: 16, eligible: WR_SLOTS, proj: 13.1, season: 77.7, slot: 4, pctOwned: 97 },
  { id: 105, name: "Echo End", posId: 3, proTeamId: 2, eligible: WR_SLOTS, proj: 0, season: 70.2, slot: 4, pctOwned: 95 }, // BUF on bye
  { id: 106, name: "Foxtrot Tight", posId: 4, proTeamId: 25, eligible: TE_SLOTS, proj: 8.7, season: 48.0, slot: 6, pctOwned: 88 },
  { id: 107, name: "Golf Gadget", posId: 3, proTeamId: 21, eligible: WR_SLOTS, proj: 9.9, season: 55.3, slot: 23, pctOwned: 80, actualWeek: 14.5 }, // TNF
  { id: 108, name: "Hotel Defense", posId: 16, proTeamId: 33, eligible: DST_SLOTS, proj: 7.0, season: 51.0, slot: 16, pctOwned: 85 },
  { id: 109, name: "India Kicker", posId: 5, proTeamId: 6, eligible: K_SLOTS, proj: 8.0, season: 52.0, slot: 17, pctOwned: 70 },
  { id: 110, name: "Juliet Jet", posId: 2, proTeamId: 23, eligible: RB_SLOTS, proj: 12.8, season: 58.9, slot: 20, pctOwned: 76 },
  { id: 111, name: "Kilo Keeper", posId: 3, proTeamId: 14, eligible: WR_SLOTS, proj: 10.5, season: 49.2, slot: 20, pctOwned: 66 },
  { id: 112, name: "Lima Lightning", posId: 3, proTeamId: 24, eligible: WR_SLOTS, proj: 7.1, season: 40.0, slot: 20, pctOwned: 40 },
  { id: 113, name: "Mike Mauler", posId: 2, proTeamId: 34, eligible: RB_SLOTS, proj: 6.5, season: 33.0, slot: 20, injuryStatus: "QUESTIONABLE", pctOwned: 35 },
  { id: 114, name: "November Nimble", posId: 4, proTeamId: 9, eligible: TE_SLOTS, proj: 5.0, season: 28.0, slot: 20, pctOwned: 22 },
  { id: 115, name: "Oscar Option", posId: 1, proTeamId: 11, eligible: QB_SLOTS, proj: 15.0, season: 90.0, slot: 20, pctOwned: 60 },
  { id: 116, name: "Papa Punt", posId: 2, proTeamId: 29, eligible: RB_SLOTS, proj: 3.0, season: 12.0, slot: 20, pctOwned: 8, droppable: true },
  { id: 117, name: "Quebec Quiet", posId: 3, proTeamId: 1, eligible: WR_SLOTS, proj: 0, season: 20.0, slot: 21, injuryStatus: "INJURY_RESERVE", pctOwned: 50 },
];

export const OPP_PLAYERS: (FixturePlayer & { slot: number })[] = [
  { id: 501, name: "Sam Signal", posId: 1, proTeamId: 4, eligible: QB_SLOTS, proj: 18.0, season: 100.0, slot: 0, pctOwned: 96 },
  { id: 502, name: "Rex Rusher", posId: 2, proTeamId: 18, eligible: RB_SLOTS, proj: 13.0, season: 80.0, slot: 2, pctOwned: 93 },
  { id: 503, name: "Ty Trotter", posId: 2, proTeamId: 27, eligible: RB_SLOTS, proj: 9.0, season: 50.0, slot: 2, pctOwned: 60 },
  { id: 504, name: "Wes Wideout", posId: 3, proTeamId: 26, eligible: WR_SLOTS, proj: 12.0, season: 75.0, slot: 4, pctOwned: 94 },
  { id: 505, name: "Vic Vertical", posId: 3, proTeamId: 3, eligible: WR_SLOTS, proj: 10.0, season: 60.0, slot: 4, pctOwned: 80 },
  { id: 506, name: "Ted Tightend", posId: 4, proTeamId: 20, eligible: TE_SLOTS, proj: 7.0, season: 40.0, slot: 6, pctOwned: 70 },
  { id: 507, name: "Flo Flex", posId: 3, proTeamId: 19, eligible: WR_SLOTS, proj: 8.0, season: 45.0, slot: 23, pctOwned: 50, actualWeek: 6.0 },
  { id: 508, name: "Dee Fence", posId: 16, proTeamId: 26, eligible: DST_SLOTS, proj: 6.0, season: 45.0, slot: 16, pctOwned: 60 },
  { id: 509, name: "Kay Kicker", posId: 5, proTeamId: 12, eligible: K_SLOTS, proj: 8.5, season: 55.0, slot: 17, pctOwned: 65 },
  { id: 510, name: "Ben Bench", posId: 2, proTeamId: 10, eligible: RB_SLOTS, proj: 5.0, season: 30.0, slot: 20, pctOwned: 30 },
];

export const FREE_AGENTS: (FixturePlayer & { status: "FREEAGENT" | "WAIVERS" })[] = [
  { id: 201, name: "Romeo Rookie", posId: 2, proTeamId: 18, eligible: RB_SLOTS, proj: 9.5, season: 30.1, pctOwned: 45, status: "FREEAGENT" },
  { id: 202, name: "Sierra Streak", posId: 3, proTeamId: 27, eligible: WR_SLOTS, proj: 11.2, season: 44.0, pctOwned: 55, status: "WAIVERS" },
  { id: 203, name: "Tango Tackler", posId: 16, proTeamId: 26, eligible: DST_SLOTS, proj: 6.0, season: 40.0, pctOwned: 20, status: "FREEAGENT" },
  { id: 204, name: "Uniform Util", posId: 4, proTeamId: 3, eligible: TE_SLOTS, proj: 4.0, season: 15.0, pctOwned: 5, status: "FREEAGENT" },
  { id: 205, name: "Victor Vet", posId: 1, proTeamId: 4, eligible: QB_SLOTS, proj: 17.0, season: 95.0, pctOwned: 48, status: "FREEAGENT" },
  { id: 206, name: "Whiskey Wing", posId: 3, proTeamId: 20, eligible: WR_SLOTS, proj: 6.0, season: 25.0, pctOwned: 12, status: "FREEAGENT" },
  { id: -16006, name: "Cowboys D/ST", posId: 16, proTeamId: 6, eligible: DST_SLOTS, proj: 5.5, season: 30.0, pctOwned: 25, status: "FREEAGENT" },
];

export const OTHER_LEAGUE_PLAYERS: FixturePlayer[] = [
  { id: 300, name: "Xray Xtra", posId: 2, proTeamId: 19, eligible: RB_SLOTS, proj: 4.0, season: 10.0, pctOwned: 15 },
  { id: 301, name: "Yankee Yard", posId: 3, proTeamId: 10, eligible: WR_SLOTS, proj: 3.0, season: 9.0, pctOwned: 10 },
];

export const ALL_PLAYERS: FixturePlayer[] = [...MY_PLAYERS, ...OPP_PLAYERS, ...FREE_AGENTS, ...OTHER_LEAGUE_PLAYERS];

function stats(p: FixturePlayer): RawStat[] {
  const out: RawStat[] = [
    { seasonId: SEASON, scoringPeriodId: WEEK, statSourceId: 1, statSplitTypeId: 1, appliedTotal: p.proj, stats: {} },
    { seasonId: SEASON, scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedTotal: p.season, appliedAverage: Math.round((p.season / 6) * 100) / 100, stats: {} },
    { seasonId: SEASON, scoringPeriodId: 0, statSourceId: 1, statSplitTypeId: 0, appliedTotal: Math.round(p.season * 2.8 * 10) / 10, stats: {} },
    { seasonId: SEASON - 1, scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedTotal: Math.round(p.season * 2.5 * 10) / 10, stats: {} },
  ];
  for (const [week, pts] of Object.entries(p.weekly ?? {})) {
    out.push({ seasonId: SEASON, scoringPeriodId: Number(week), statSourceId: 0, statSplitTypeId: 1, appliedTotal: pts, stats: {} });
  }
  if (p.actualWeek !== undefined) {
    out.push({ seasonId: SEASON, scoringPeriodId: WEEK, statSourceId: 0, statSplitTypeId: 1, appliedTotal: p.actualWeek, stats: {} });
  }
  // Next week's projection: slightly lower, and bye-week players get their normal number back.
  out.push({ seasonId: SEASON, scoringPeriodId: WEEK + 1, statSourceId: 1, statSplitTypeId: 1, appliedTotal: Math.round((p.proj || p.season / 6) * 0.9 * 10) / 10, stats: {} });
  return out;
}

export function playerPoolEntry(p: FixturePlayer, onTeamId: number, status: string, extra: Partial<RawPlayerPoolEntry> = {}): RawPlayerPoolEntry {
  return {
    id: p.id,
    onTeamId,
    status,
    lineupLocked: false,
    rosterLocked: false,
    ratings: { "0": { positionalRanking: Math.max(1, Math.round(100 - (p.pctOwned ?? 0))), totalRanking: 100 } },
    player: {
      id: p.id,
      fullName: p.name,
      firstName: p.name.split(" ")[0],
      lastName: p.name.split(" ").slice(1).join(" "),
      defaultPositionId: p.posId,
      proTeamId: p.proTeamId,
      eligibleSlots: p.eligible,
      injuryStatus: p.posId === 16 ? undefined : p.injuryStatus ?? "ACTIVE",
      injured: !!p.injuryStatus && p.injuryStatus !== "ACTIVE",
      active: true,
      droppable: p.droppable ?? true,
      ownership: { percentOwned: p.pctOwned ?? 0, percentStarted: (p.pctOwned ?? 0) * 0.8, percentChange: 1.5 },
      stats: stats(p),
    },
    ...extra,
  };
}

function rosterEntry(p: FixturePlayer & { slot: number }, teamId: number): RawRosterEntry {
  return {
    playerId: p.id,
    lineupSlotId: p.slot,
    acquisitionType: "DRAFT",
    injuryStatus: p.injuryStatus ?? "NORMAL",
    playerPoolEntry: playerPoolEntry(p, teamId, "ONTEAM"),
  };
}

const TEAM_META: { id: number; abbrev: string; name: string; owner: string; wins: number; losses: number; pf: number; pa: number; waiverRank: number; spent: number }[] = [
  { id: 1, abbrev: "AAA", name: "Aardvark Army", owner: "{OWNER-1}", wins: 4, losses: 2, pf: 720.4, pa: 650.1, waiverRank: 7, spent: 20 },
  { id: 2, abbrev: "BBB", name: "Bison Brigade", owner: "{OWNER-2}", wins: 2, losses: 4, pf: 610.0, pa: 700.3, waiverRank: 2, spent: 55 },
  { id: MY_TEAM_ID, abbrev: "MHM", name: "Mile High Maulers", owner: MY_SWID, wins: 3, losses: 3, pf: 701.3, pa: 690.8, waiverRank: 5, spent: 37 },
  { id: 4, abbrev: "DDD", name: "Dragon Dynasty", owner: "{OWNER-4}", wins: 5, losses: 1, pf: 790.9, pa: 600.0, waiverRank: 10, spent: 80 },
  { id: OPP_TEAM_ID, abbrev: "OWL", name: "Opponent Owls", owner: "{OWNER-5}", wins: 3, losses: 3, pf: 680.2, pa: 670.5, waiverRank: 4, spent: 10 },
  { id: 6, abbrev: "FFF", name: "Falcon Force", owner: "{OWNER-6}", wins: 1, losses: 5, pf: 560.0, pa: 740.0, waiverRank: 1, spent: 95 },
  { id: 7, abbrev: "GGG", name: "Gator Gang", owner: "{OWNER-7}", wins: 4, losses: 2, pf: 710.0, pa: 640.0, waiverRank: 8, spent: 30 },
  { id: 8, abbrev: "HHH", name: "Hornet Hive", owner: "{OWNER-8}", wins: 2, losses: 4, pf: 620.0, pa: 690.0, waiverRank: 3, spent: 0 },
  { id: 9, abbrev: "III", name: "Iguana Inc", owner: "{OWNER-9}", wins: 3, losses: 3, pf: 660.0, pa: 660.0, waiverRank: 6, spent: 45 },
  { id: 10, abbrev: "JJJ", name: "Jackal Juggernaut", owner: "{OWNER-10}", wins: 3, losses: 3, pf: 650.0, pa: 655.0, waiverRank: 9, spent: 60 },
];

export function leagueFixture(overrides: Partial<RawLeague> = {}): RawLeague {
  const seedOrder = [...TEAM_META].sort((a, b) => b.wins - a.wins || b.pf - a.pf).map((t) => t.id);
  const teams = TEAM_META.map((t) => {
    let entries: RawRosterEntry[] = [];
    if (t.id === MY_TEAM_ID) entries = MY_PLAYERS.map((p) => rosterEntry(p, t.id));
    else if (t.id === OPP_TEAM_ID) entries = OPP_PLAYERS.map((p) => rosterEntry(p, t.id));
    else if (t.id === 7) entries = [rosterEntry({ ...OTHER_LEAGUE_PLAYERS[0]!, slot: 20 }, 7)];
    return {
      id: t.id,
      abbrev: t.abbrev,
      name: t.name,
      owners: [t.owner],
      primaryOwner: t.owner,
      playoffSeed: seedOrder.indexOf(t.id) + 1,
      waiverRank: t.waiverRank,
      record: { overall: { wins: t.wins, losses: t.losses, ties: 0, pointsFor: t.pf, pointsAgainst: t.pa, streakLength: 1, streakType: "WIN" } },
      roster: { entries },
      transactionCounter: { acquisitionBudgetSpent: t.spent, acquisitions: Math.round(t.spent / 10), drops: 2, trades: 0 },
    };
  });
  const members = TEAM_META.map((t) => ({ id: t.owner, displayName: t.owner === MY_SWID ? "piperdaniel" : `owner${t.id}`, firstName: "F", lastName: "L" }));
  const schedule = [];
  let id = 1;
  for (let period = 1; period <= 14; period++) {
    for (let i = 0; i < TEAM_META.length; i += 2) {
      const a = TEAM_META[(i + period) % TEAM_META.length]!.id;
      const b = TEAM_META[(i + period + 1) % TEAM_META.length]!.id;
      const decided = period < WEEK;
      schedule.push({
        id: id++,
        matchupPeriodId: period,
        home: { teamId: a, totalPoints: decided ? 100 + a : 0 },
        away: { teamId: b, totalPoints: decided ? 95 + b : 0 },
        winner: decided ? "HOME" : "UNDECIDED",
        playoffTierType: "NONE",
      });
    }
  }
  // Force my week-7 matchup against team 5.
  const mine = schedule.find((m) => m.matchupPeriodId === WEEK && (m.home.teamId === MY_TEAM_ID || m.away.teamId === MY_TEAM_ID))!;
  const opp = schedule.find((m) => m.matchupPeriodId === WEEK && (m.home.teamId === OPP_TEAM_ID || m.away.teamId === OPP_TEAM_ID) && m !== mine);
  if (opp) {
    const otherMine = mine.home.teamId === MY_TEAM_ID ? mine.away.teamId : mine.home.teamId;
    const otherOpp = opp.home.teamId === OPP_TEAM_ID ? opp.away.teamId : opp.home.teamId;
    mine.home = { teamId: MY_TEAM_ID, totalPoints: 0 };
    mine.away = { teamId: OPP_TEAM_ID, totalPoints: 0 };
    opp.home = { teamId: otherMine, totalPoints: 0 };
    opp.away = { teamId: otherOpp, totalPoints: 0 };
  }

  return {
    id: LEAGUE_ID,
    seasonId: SEASON,
    scoringPeriodId: WEEK,
    segmentId: 0,
    gameId: 1,
    status: {
      currentMatchupPeriod: WEEK,
      latestScoringPeriod: WEEK,
      firstScoringPeriod: 1,
      finalScoringPeriod: 17,
      isActive: true,
      waiverNextExecutionDate: Date.parse("2026-10-21T10:00:00Z"),
      waiverLastExecutionDate: Date.parse("2026-10-14T10:00:00Z"),
    },
    settings: {
      name: "Rocky Mountain Rumble",
      size: 10,
      acquisitionSettings: {
        acquisitionBudget: 100,
        acquisitionLimit: -1,
        acquisitionType: "WAIVERS_CONTINUOUS",
        isUsingAcquisitionBudget: true,
        matchupAcquisitionLimit: -1,
        minimumBid: 0,
        waiverHours: 48,
        waiverProcessDays: ["WEDNESDAY"],
        waiverProcessHour: 8,
      },
      rosterSettings: {
        lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 },
        positionLimits: { "1": 4, "2": 8, "3": 8, "4": 3, "5": 3, "16": 3 },
        lineupLocktimeType: "INDIVIDUAL_GAME",
        rosterLocktimeType: "INDIVIDUAL_GAME",
        isUsingUndroppableList: true,
      },
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6, matchupPeriods: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i + 1), [i + 1]])) },
      scoringSettings: { scoringType: "H2H_POINTS", scoringItems: [{ statId: 53, points: 1 }] },
      tradeSettings: { deadlineDate: Date.parse("2026-11-18T23:59:00Z"), max: -1, revisionHours: 48, vetoVotesRequired: 4, allowOutOfUniverse: false },
    },
    teams,
    members,
    schedule,
    ...overrides,
  };
}

export function transactionsFixture(): RawTransaction[] {
  return [
    {
      id: "tx-drop-1",
      type: "ROSTER",
      status: "EXECUTED",
      teamId: 8,
      memberId: "{OWNER-8}",
      scoringPeriodId: WEEK,
      proposedDate: Date.parse("2026-10-15T12:00:00Z"),
      isPending: false,
      items: [{ playerId: -16006, type: "DROP", fromTeamId: 8, toLineupSlotId: -1 }],
    },
    {
      id: "tx-lineup-1",
      type: "ROSTER",
      status: "EXECUTED",
      teamId: MY_TEAM_ID,
      memberId: MY_SWID,
      scoringPeriodId: WEEK,
      proposedDate: Date.parse("2026-10-14T18:00:00Z"),
      isPending: false,
      items: [
        { playerId: 110, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 2 },
        { playerId: 103, type: "LINEUP", fromLineupSlotId: 2, toLineupSlotId: 20 },
      ],
    },
    {
      id: "tx-waiver-1",
      type: "WAIVER",
      status: "PENDING",
      teamId: MY_TEAM_ID,
      memberId: MY_SWID,
      scoringPeriodId: WEEK,
      bidAmount: 12,
      proposedDate: Date.parse("2026-10-14T20:00:00Z"),
      executionType: "PROCESS",
      isPending: true,
      items: [
        { playerId: 202, type: "ADD", toTeamId: MY_TEAM_ID },
        { playerId: 116, type: "DROP", fromTeamId: MY_TEAM_ID },
      ],
    },
    {
      id: "tx-trade-1",
      type: "TRADE_PROPOSAL",
      status: "PENDING",
      teamId: OPP_TEAM_ID,
      memberId: "{OWNER-5}",
      scoringPeriodId: WEEK,
      proposedDate: Date.parse("2026-10-15T01:00:00Z"),
      expirationDate: Date.parse("2026-10-17T01:00:00Z"),
      isPending: true,
      items: [
        { playerId: 503, type: "TRADE", fromTeamId: OPP_TEAM_ID, toTeamId: MY_TEAM_ID },
        { playerId: 112, type: "TRADE", fromTeamId: MY_TEAM_ID, toTeamId: OPP_TEAM_ID },
      ],
    },
    {
      id: "tx-fa-1",
      type: "FREEAGENT",
      status: "EXECUTED",
      teamId: 7,
      memberId: "{OWNER-7}",
      scoringPeriodId: WEEK,
      proposedDate: Date.parse("2026-10-14T15:00:00Z"),
      processDate: Date.parse("2026-10-14T15:00:01Z"),
      isPending: false,
      items: [
        { playerId: 300, type: "ADD", toTeamId: 7 },
        { playerId: 301, type: "DROP", fromTeamId: 7 },
      ],
    },
  ];
}

export function activityFixture() {
  return {
    topics: [
      {
        id: "topic-1",
        date: Date.parse("2026-10-14T15:00:00Z"),
        type: "ACTIVITY_TRANSACTIONS",
        messages: [
          { id: "m1", messageTypeId: 178, targetId: 300, to: 7, for: 7, date: Date.parse("2026-10-14T15:00:00Z") },
          { id: "m2", messageTypeId: 179, targetId: 301, from: 7, for: 7, date: Date.parse("2026-10-14T15:00:00Z") },
          { id: "m3", messageTypeId: 179, targetId: -16006, from: 8, for: 8, date: Date.parse("2026-10-15T12:00:00Z") },
        ],
      },
    ],
  };
}

export function universeFixture() {
  return ALL_PLAYERS.map((p) => ({ id: p.id, fullName: p.name, defaultPositionId: p.posId, proTeamId: p.proTeamId, active: true }));
}

/** Player pool entry with correct league status for any fixture player id. */
export function poolEntryFor(id: number): RawPlayerPoolEntry | undefined {
  const mine = MY_PLAYERS.find((p) => p.id === id);
  if (mine) return playerPoolEntry(mine, MY_TEAM_ID, "ONTEAM");
  const opp = OPP_PLAYERS.find((p) => p.id === id);
  if (opp) return playerPoolEntry(opp, OPP_TEAM_ID, "ONTEAM");
  const fa = FREE_AGENTS.find((p) => p.id === id);
  if (fa) return playerPoolEntry(fa, 0, fa.status);
  const other = OTHER_LEAGUE_PLAYERS.find((p) => p.id === id);
  if (other) return playerPoolEntry(other, other.id === 300 ? 7 : 0, other.id === 300 ? "ONTEAM" : "FREEAGENT");
  return undefined;
}
