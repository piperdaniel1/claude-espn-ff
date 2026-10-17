/**
 * LeagueService: turns ESPN's raw league payloads into the normalised view
 * the MCP tools expose, and holds the validation logic for writes.
 */

import { POSITION_SLOT_FILTER, SLOT_BENCH, SLOT_IR, TRANSACTION_TYPES, UNAVAILABLE_STATUSES, positionName, proTeamAbbrev, resolveSlot, slotName, ACTIVITY_MESSAGE_TYPES } from "./constants.ts";
import type { EspnClient } from "./client.ts";
import { EspnHttpError } from "./client.ts";
import type { LineupCandidate } from "./lineup.ts";
import type { Actor, LineupMove } from "./transactions.ts";
import type {
  RawActivityFeed,
  RawLeague,
  RawPlayer,
  RawPlayerPoolEntry,
  RawPlayersWl,
  RawProGame,
  RawProSchedule,
  RawProTeam,
  RawRosterEntry,
  RawScheduleItem,
  RawSettings,
  RawStatus,
  RawTeam,
  RawTransaction,
} from "./types.ts";
import { formatDateTime } from "../util/time.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GameInfo {
  opponent: string | null;
  home: boolean | null;
  kickoff: string | null;
  kickoffMs: number | null;
  started: boolean;
  bye: boolean;
}

export interface PlayerInfo {
  id: number;
  name: string;
  position: string;
  proTeam: string;
  injuryStatus: string;
  injured: boolean;
  eligibleSlots: string[];
  eligibleSlotIds: number[];
  percentOwned: number | null;
  percentStarted: number | null;
  percentChange: number | null;
  positionRank: number | null;
  projectedWeek: number | null;
  actualWeek: number | null;
  seasonPoints: number | null;
  seasonAvg: number | null;
  seasonProjected: number | null;
  lastSeasonPoints: number | null;
  weeklyPoints: Record<string, number>;
  game: GameInfo;
  droppable: boolean;
  newsUpdated: string | null;
  /** FREEAGENT | WAIVERS | ONTEAM (only known for player-pool queries). */
  availability?: string;
  onTeamId?: number | null;
  onTeamName?: string | null;
}

export interface RosterPlayer extends PlayerInfo {
  slot: string;
  slotId: number;
  locked: boolean;
  acquisitionType: string | null;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: string | null;
}

export interface TeamSummary {
  id: number;
  abbrev: string;
  name: string;
  owners: string[];
  record: TeamRecord;
  playoffSeed: number | null;
  waiverRank: number | null;
  faabSpent: number | null;
  faabRemaining: number | null;
  acquisitions: number | null;
  isMine: boolean;
}

export interface TeamWithRoster extends TeamSummary {
  roster: RosterPlayer[];
}

export interface MatchupInfo {
  matchupPeriod: number;
  home: { teamId: number; team: string; points: number; projectedLive: number | null };
  away: { teamId: number; team: string; points: number; projectedLive: number | null } | null;
  winner: string;
  playoffTier: string;
  involvesMe: boolean;
}

export interface WaiverSettings {
  type: string;
  usesFaab: boolean;
  budget: number | null;
  minimumBid: number | null;
  processDays: string[];
  processHour: number | null;
  waiverPeriodHours: number | null;
  acquisitionLimitPerSeason: number | null;
  acquisitionLimitPerMatchup: number | null;
}

export interface LeagueSettingsSummary {
  name: string;
  size: number;
  scoringFormat: string;
  pointsPerReception: number;
  lineupSlots: Record<string, number>;
  startingSlotCounts: Record<number, number>;
  rosterLimit: number;
  irSlots: number;
  lineupLockType: string;
  undroppableListEnforced: boolean;
  positionLimits: Record<string, number>;
  waivers: WaiverSettings;
  trades: {
    deadline: string | null;
    deadlineMs: number | null;
    deadlinePassed: boolean;
    reviewHours: number | null;
    vetoVotesRequired: number | null;
  };
  schedule: {
    regularSeasonWeeks: number;
    playoffTeams: number;
    playoffStartMatchupPeriod: number;
    matchupPeriods: Record<string, number[]>;
  };
}

export interface Snapshot {
  season: number;
  leagueId: number;
  leagueName: string;
  now: Date;
  scoringPeriodId: number;
  currentMatchupPeriod: number;
  latestScoringPeriod: number;
  firstScoringPeriod: number;
  finalScoringPeriod: number;
  isActive: boolean;
  status: RawStatus;
  settings: LeagueSettingsSummary;
  teams: TeamWithRoster[];
  myTeam: TeamWithRoster;
  schedule: MatchupInfo[];
  proTeams: Map<number, RawProTeam>;
  playerNames: Map<number, string>;
  weekGames: RawProGame[];
}

export interface TransactionInfo {
  id: string;
  type: string;
  status: string;
  teamId: number | null;
  team: string | null;
  isMine: boolean;
  bidAmount: number | null;
  proposed: string | null;
  processed: string | null;
  expires: string | null;
  scoringPeriodId: number | null;
  pending: boolean;
  items: { action: string; playerId: number; player: string; fromTeam: string | null; toTeam: string | null; fromSlot: string | null; toSlot: string | null }[];
  relatedTransactionId: string | null;
  /** For trades: whether this proposal is addressed to my team (I must accept/decline). */
  awaitingMyResponse: boolean;
}

export interface ActivityItem {
  date: string | null;
  action: string;
  player: string;
  playerId: number | null;
  team: string | null;
  otherTeam: string | null;
}

export interface LeagueServiceOptions {
  client: EspnClient;
  swid: string;
  teamIdOverride?: number;
  timezone: string;
  now?: () => Date;
}

export class LeagueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueError";
  }
}

const LEAGUE_VIEWS = ["mTeam", "mRoster", "mSettings", "mMatchupScore", "mStatus"];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LeagueService {
  readonly client: EspnClient;
  readonly swid: string;
  readonly timezone: string;
  private readonly teamIdOverride?: number;
  private readonly nowFn: () => Date;
  private proScheduleCache?: Promise<Map<number, RawProTeam>>;
  private snapshotCache = new Map<string, Promise<Snapshot>>();

  constructor(opts: LeagueServiceOptions) {
    this.client = opts.client;
    this.swid = opts.swid.toUpperCase();
    this.teamIdOverride = opts.teamIdOverride;
    this.timezone = opts.timezone;
    this.nowFn = opts.now ?? (() => new Date());
  }

  get now(): Date {
    return this.nowFn();
  }

  get season(): number {
    return this.client.season;
  }

  // ---- Pro schedule ------------------------------------------------------

  async getProTeams(): Promise<Map<number, RawProTeam>> {
    if (!this.proScheduleCache) {
      this.proScheduleCache = this.client
        .seasonGet<RawProSchedule>({ views: ["proTeamSchedules_wl"] })
        .then((data) => new Map((data.settings?.proTeams ?? []).map((t) => [t.id, t])))
        .catch((err) => {
          this.proScheduleCache = undefined;
          throw err;
        });
    }
    return this.proScheduleCache;
  }

  gamesForWeek(proTeams: Map<number, RawProTeam>, week: number): RawProGame[] {
    const seen = new Set<number>();
    const games: RawProGame[] = [];
    for (const team of proTeams.values()) {
      for (const g of team.proGamesByScoringPeriod?.[String(week)] ?? []) {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          games.push(g);
        }
      }
    }
    return games.sort((a, b) => a.date - b.date);
  }

  // ---- Snapshot ---------------------------------------------------------------

  /** Load league + rosters + schedule for a scoring period (defaults to the current one). */
  async getSnapshot(week?: number): Promise<Snapshot> {
    const key = week === undefined ? "current" : String(week);
    let cached = this.snapshotCache.get(key);
    if (!cached) {
      cached = this.loadSnapshot(week).catch((err) => {
        this.snapshotCache.delete(key);
        throw err;
      });
      this.snapshotCache.set(key, cached);
    }
    return cached;
  }

  invalidate(): void {
    this.snapshotCache.clear();
  }

  private async loadSnapshot(week?: number): Promise<Snapshot> {
    const [league, proTeams] = await Promise.all([
      this.client.leagueGet<RawLeague>({ views: LEAGUE_VIEWS, scoringPeriodId: week }),
      this.getProTeams(),
    ]);
    const now = this.now;
    const status = league.status ?? {};
    const scoringPeriodId = week ?? league.scoringPeriodId ?? status.latestScoringPeriod ?? 1;
    const settings = summariseSettings(league.settings ?? {}, this.timezone, now);
    const members = new Map((league.members ?? []).map((m) => [m.id.toUpperCase(), m]));
    const weekGames = this.gamesForWeek(proTeams, scoringPeriodId);

    const rawTeams = league.teams ?? [];
    const myRawTeam = this.findMyTeam(rawTeams);
    const playerNames = new Map<number, string>();

    const teams: TeamWithRoster[] = rawTeams.map((t) => {
      const summary = summariseTeam(t, members, settings, t.id === myRawTeam.id);
      const roster = (t.roster?.entries ?? []).map((entry) => {
        const rp = this.normaliseRosterEntry(entry, scoringPeriodId, proTeams, settings, now, weekGames);
        playerNames.set(rp.id, rp.name);
        return rp;
      });
      roster.sort((a, b) => a.slotId - b.slotId || (b.projectedWeek ?? 0) - (a.projectedWeek ?? 0));
      return { ...summary, roster };
    });
    const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? `Team ${id}`;
    const myTeam = teams.find((t) => t.id === myRawTeam.id)!;

    const schedule: MatchupInfo[] = (league.schedule ?? []).map((m) => summariseMatchup(m, teamName, myTeam.id));

    return {
      season: league.seasonId ?? this.season,
      leagueId: league.id ?? this.client.leagueId,
      leagueName: settings.name,
      now,
      scoringPeriodId,
      currentMatchupPeriod: status.currentMatchupPeriod ?? 1,
      latestScoringPeriod: status.latestScoringPeriod ?? scoringPeriodId,
      firstScoringPeriod: status.firstScoringPeriod ?? 1,
      finalScoringPeriod: status.finalScoringPeriod ?? 18,
      isActive: status.isActive ?? true,
      status,
      settings,
      teams,
      myTeam,
      schedule,
      proTeams,
      playerNames,
      weekGames,
    };
  }

  private findMyTeam(teams: RawTeam[]): RawTeam {
    if (teams.length === 0) throw new LeagueError("ESPN returned no teams for this league. Check ESPN_LEAGUE_ID and the season.");
    if (this.teamIdOverride !== undefined) {
      const t = teams.find((x) => x.id === this.teamIdOverride);
      if (!t) throw new LeagueError(`ESPN_TEAM_ID=${this.teamIdOverride} is not a team in this league. Teams: ${teams.map((x) => `${x.id}=${teamDisplayName(x)}`).join(", ")}`);
      return t;
    }
    const mine = teams.filter((t) => (t.owners ?? []).some((o) => o.toUpperCase() === this.swid) || t.primaryOwner?.toUpperCase() === this.swid);
    if (mine.length === 1) return mine[0]!;
    if (mine.length > 1) {
      throw new LeagueError(`This account owns ${mine.length} teams in the league (${mine.map((t) => `${t.id}=${teamDisplayName(t)}`).join(", ")}). Set ESPN_TEAM_ID to choose one.`);
    }
    throw new LeagueError(
      `No team in this league is owned by SWID ${this.swid}. Either the SWID cookie is wrong or you need to set ESPN_TEAM_ID. Teams: ${teams.map((t) => `${t.id}=${teamDisplayName(t)}`).join(", ")}`,
    );
  }

  // ---- Players ------------------------------------------------------------------

  private normaliseRosterEntry(
    entry: RawRosterEntry,
    week: number,
    proTeams: Map<number, RawProTeam>,
    settings: LeagueSettingsSummary,
    now: Date,
    weekGames: RawProGame[],
  ): RosterPlayer {
    const ppe = entry.playerPoolEntry;
    const player: RawPlayer = ppe?.player ?? { id: entry.playerId };
    const info = this.normalisePlayer(player, ppe, week, proTeams, now, settings, weekGames);
    if (entry.injuryStatus && !player.injuryStatus) info.injuryStatus = entry.injuryStatus;
    const locked = computeLocked(info.game, ppe?.lineupLocked, settings.lineupLockType, weekGames, now);
    return {
      ...info,
      slot: slotName(entry.lineupSlotId),
      slotId: entry.lineupSlotId,
      locked,
      acquisitionType: entry.acquisitionType ?? null,
    };
  }

  normalisePlayer(
    player: RawPlayer,
    ppe: RawPlayerPoolEntry | undefined,
    week: number,
    proTeams: Map<number, RawProTeam>,
    now: Date,
    settings: LeagueSettingsSummary,
    weekGames: RawProGame[],
    teamName?: (id: number) => string,
  ): PlayerInfo {
    const season = this.season;
    const stats = (player.stats ?? []).filter((s) => s.seasonId === season || s.seasonId === season - 1);
    const find = (source: number, split: number, period: number, seasonId = season) =>
      stats.find((s) => s.seasonId === seasonId && s.statSourceId === source && s.statSplitTypeId === split && s.scoringPeriodId === period);
    const weekly: Record<string, number> = {};
    for (const s of stats) {
      if (s.seasonId === season && s.statSourceId === 0 && s.statSplitTypeId === 1 && s.appliedTotal !== undefined) {
        weekly[String(s.scoringPeriodId)] = round1(s.appliedTotal);
      }
    }
    const proTeamId = player.proTeamId ?? 0;
    const game = gameInfo(proTeamId, week, proTeams, now, this.timezone, weekGames);
    const ranking = ppe?.ratings?.["0"] ?? ppe?.ratings?.[String(week)];
    const ownership = player.ownership ?? {};
    const eligibleSlotIds = (player.eligibleSlots ?? []).filter((s) => s !== 22 && s !== 25);
    const info: PlayerInfo = {
      id: player.id,
      name: player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ") || `Player ${player.id}`,
      position: positionName(player.defaultPositionId),
      proTeam: proTeamAbbrev(proTeamId),
      injuryStatus: player.injuryStatus ?? "ACTIVE",
      injured: player.injured ?? false,
      eligibleSlots: eligibleSlotIds.map(slotName),
      eligibleSlotIds,
      percentOwned: numOrNull(ownership.percentOwned, 1),
      percentStarted: numOrNull(ownership.percentStarted, 1),
      percentChange: numOrNull(ownership.percentChange, 1),
      positionRank: ranking?.positionalRanking ?? null,
      projectedWeek: numOrNull(find(1, 1, week)?.appliedTotal, 1),
      actualWeek: numOrNull(find(0, 1, week)?.appliedTotal, 1),
      seasonPoints: numOrNull(find(0, 0, 0)?.appliedTotal, 1),
      seasonAvg: numOrNull(find(0, 0, 0)?.appliedAverage, 1),
      seasonProjected: numOrNull(find(1, 0, 0)?.appliedTotal, 1),
      lastSeasonPoints: numOrNull(find(0, 0, 0, season - 1)?.appliedTotal, 1),
      weeklyPoints: weekly,
      game,
      droppable: player.droppable ?? true,
      newsUpdated: formatDateTime(player.lastNewsDate, this.timezone),
    };
    if (ppe?.status !== undefined) info.availability = ppe.status;
    if (ppe?.onTeamId !== undefined) {
      info.onTeamId = ppe.onTeamId || null;
      info.onTeamName = ppe.onTeamId && teamName ? teamName(ppe.onTeamId) : null;
    }
    void settings;
    return info;
  }

  private statFilterValues(week: number): string[] {
    const s = this.season;
    return [`00${s}`, `10${s}`, `00${s - 1}`, `11${s}${week}`, `02${s}`];
  }

  /** Free agents and (optionally) players on waivers. */
  async getFreeAgents(opts: {
    week?: number;
    positions?: string[];
    limit?: number;
    includeWaivers?: boolean;
    minPercentOwned?: number;
    sort?: "percent_owned" | "projected_week" | "projected_season" | "season_points" | "percent_change";
  } = {}): Promise<{ week: number; players: PlayerInfo[] }> {
    const snap = await this.getSnapshot(opts.week);
    const week = snap.scoringPeriodId;
    const slotIds = resolveSlotFilter(opts.positions);
    const statuses = opts.includeWaivers === false ? ["FREEAGENT"] : ["FREEAGENT", "WAIVERS"];
    const fetchLimit = Math.min(300, Math.max(50, (opts.limit ?? 25) * 4));
    const filter = {
      players: {
        filterStatus: { value: statuses },
        filterSlotIds: { value: slotIds },
        limit: fetchLimit,
        offset: 0,
        sortPercOwned: { sortPriority: 1, sortAsc: false },
        filterRanksForScoringPeriodIds: { value: [week] },
        filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: this.statFilterValues(week) },
      },
    };
    const data = await this.client.leagueGet<RawLeague>({ views: ["kona_player_info"], scoringPeriodId: week, filter });
    const teamName = (id: number) => snap.teams.find((t) => t.id === id)?.name ?? `Team ${id}`;
    let players = (data.players ?? []).map((ppe) =>
      this.normalisePlayer(ppe.player, ppe, week, snap.proTeams, snap.now, snap.settings, snap.weekGames, teamName),
    );
    if (opts.minPercentOwned !== undefined) players = players.filter((p) => (p.percentOwned ?? 0) >= opts.minPercentOwned!);
    const sortKey = opts.sort ?? "percent_owned";
    const value = (p: PlayerInfo): number => {
      switch (sortKey) {
        case "projected_week":
          return p.projectedWeek ?? -1;
        case "projected_season":
          return p.seasonProjected ?? -1;
        case "season_points":
          return p.seasonPoints ?? -1;
        case "percent_change":
          return p.percentChange ?? -999;
        default:
          return p.percentOwned ?? -1;
      }
    };
    players.sort((a, b) => value(b) - value(a));
    return { week, players: players.slice(0, opts.limit ?? 25) };
  }

  /** Detailed info (including weekly history) for specific player ids. */
  async getPlayers(ids: number[], week?: number): Promise<PlayerInfo[]> {
    if (ids.length === 0) return [];
    const snap = await this.getSnapshot(week);
    const w = snap.scoringPeriodId;
    const filter = {
      players: {
        filterIds: { value: ids },
        filterStatsForTopScoringPeriodIds: { value: 18, additionalValue: this.statFilterValues(w) },
      },
    };
    const data = await this.client.leagueGet<RawLeague>({ views: ["kona_player_info"], scoringPeriodId: w, filter });
    const teamName = (id: number) => snap.teams.find((t) => t.id === id)?.name ?? `Team ${id}`;
    return (data.players ?? []).map((ppe) => this.normalisePlayer(ppe.player, ppe, w, snap.proTeams, snap.now, snap.settings, snap.weekGames, teamName));
  }

  /** Name search over the active NFL player universe, then league details for the best matches. */
  async searchPlayers(query: string, limit = 8, week?: number): Promise<PlayerInfo[]> {
    const q = normaliseName(query);
    if (!q) return [];
    const universe = await this.client.seasonGet<RawPlayersWl[]>({
      extend: "/players",
      views: ["players_wl"],
      extraQuery: { scoringPeriodId: "0" },
      filter: { filterActive: { value: true } },
    });
    const tokens = q.split(" ").filter(Boolean);
    const scored = (Array.isArray(universe) ? universe : [])
      .map((p) => {
        const name = normaliseName(p.fullName ?? "");
        let score = 0;
        if (name === q) score = 100;
        else if (name.startsWith(q)) score = 80;
        else if (name.includes(q)) score = 60;
        else if (tokens.every((t) => name.includes(t))) score = 40;
        else if (tokens.some((t) => t.length >= 4 && name.includes(t))) score = 10;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.p.fullName ?? "").localeCompare(b.p.fullName ?? ""))
      .slice(0, limit);
    if (scored.length === 0) return [];
    const details = await this.getPlayers(scored.map((x) => x.p.id), week);
    const order = new Map(scored.map((x, i) => [x.p.id, i]));
    return details.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  }

  // ---- Transactions ---------------------------------------------------------------

  async getTransactions(opts: { week?: number; types?: string[]; includeLineupMoves?: boolean } = {}): Promise<TransactionInfo[]> {
    const snap = await this.getSnapshot(opts.week);
    const week = snap.scoringPeriodId;
    const types = opts.types ?? TRANSACTION_TYPES.filter((t) => opts.includeLineupMoves || (t !== "ROSTER" && t !== "FUTURE_ROSTER" && t !== "RETRO_ROSTER"));
    const filter = { transactions: { filterType: { value: types } } };
    const periods = [week];
    if (week < snap.finalScoringPeriod) periods.push(week + 1);
    const results = await Promise.all(
      periods.map((p) =>
        this.client
          .leagueGet<RawLeague>({ views: ["mTransactions2", "mPendingTransactions"], scoringPeriodId: p, filter })
          .catch((err) => {
            if (err instanceof EspnHttpError && err.status === 404) return {} as RawLeague;
            throw err;
          }),
      ),
    );
    const seen = new Set<string>();
    const out: TransactionInfo[] = [];
    const names = await this.resolveNames(
      snap,
      results.flatMap((r) => [...(r.transactions ?? []), ...(r.pendingTransactions ?? [])].flatMap((t) => (t.items ?? []).map((i) => i.playerId))),
      week,
    );
    for (const r of results) {
      for (const t of [...(r.transactions ?? []), ...(r.pendingTransactions ?? [])]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(this.summariseTransaction(t, snap, names));
      }
    }
    out.sort((a, b) => (b.proposed ?? "").localeCompare(a.proposed ?? ""));
    return out;
  }

  private async resolveNames(snap: Snapshot, ids: number[], week: number): Promise<Map<number, string>> {
    const names = new Map(snap.playerNames);
    const missing = [...new Set(ids)].filter((id) => !names.has(id));
    if (missing.length > 0) {
      try {
        const players = await this.getPlayers(missing.slice(0, 50), week);
        for (const p of players) names.set(p.id, p.name);
      } catch {
        // Names stay as ids; not worth failing the whole call.
      }
    }
    return names;
  }

  private summariseTransaction(t: RawTransaction, snap: Snapshot, names: Map<number, string>): TransactionInfo {
    const teamName = (id: number | undefined) => (id === undefined || id === 0 ? null : snap.teams.find((x) => x.id === id)?.name ?? `Team ${id}`);
    const myId = snap.myTeam.id;
    const items = (t.items ?? []).map((i) => ({
      action: i.type,
      playerId: i.playerId,
      player: names.get(i.playerId) ?? `Player ${i.playerId}`,
      fromTeam: teamName(i.fromTeamId),
      toTeam: teamName(i.toTeamId),
      fromSlot: i.fromLineupSlotId !== undefined ? slotName(i.fromLineupSlotId) : null,
      toSlot: i.toLineupSlotId !== undefined ? slotName(i.toLineupSlotId) : null,
    }));
    const pending = t.status === "PENDING" || t.isPending === true;
    const awaitingMyResponse =
      t.type === "TRADE_PROPOSAL" && pending && t.teamId !== myId && (t.items ?? []).some((i) => i.toTeamId === myId || i.fromTeamId === myId);
    return {
      id: t.id,
      type: t.type,
      status: t.status ?? (pending ? "PENDING" : "UNKNOWN"),
      teamId: t.teamId ?? null,
      team: teamName(t.teamId),
      isMine: t.teamId === myId,
      bidAmount: t.bidAmount ?? null,
      proposed: formatDateTime(t.proposedDate, this.timezone),
      processed: formatDateTime(t.processDate, this.timezone),
      expires: formatDateTime(t.expirationDate, this.timezone),
      scoringPeriodId: t.scoringPeriodId ?? null,
      pending,
      items,
      relatedTransactionId: t.relatedTransactionId ?? null,
      awaitingMyResponse,
    };
  }

  /** League activity feed (adds, drops, trades across all teams). */
  async getRecentActivity(limit = 25): Promise<ActivityItem[]> {
    const snap = await this.getSnapshot();
    const filter = {
      topics: {
        filterType: { value: ["ACTIVITY_TRANSACTIONS"] },
        limit,
        limitPerMessageSet: { value: 25 },
        offset: 0,
        sortMessageDate: { sortPriority: 1, sortAsc: false },
        sortFor: { sortPriority: 2, sortAsc: false },
        filterIncludeMessageTypeIds: { value: [178, 180, 179, 239, 181, 244] },
      },
    };
    let feed: RawActivityFeed;
    try {
      feed = await this.client.leagueGet<RawActivityFeed>({ extend: "/communication/", views: ["kona_league_communication"], filter });
    } catch (err) {
      if (err instanceof EspnHttpError && err.status === 404) return [];
      throw err;
    }
    const messages = (feed.topics ?? []).flatMap((topic) => (topic.messages ?? []).map((m) => ({ topic, m })));
    const names = await this.resolveNames(snap, messages.map(({ m }) => m.targetId ?? -1).filter((id) => id > 0), snap.scoringPeriodId);
    const teamName = (id: number | undefined) => (id === undefined || id === 0 ? null : snap.teams.find((x) => x.id === id)?.name ?? `Team ${id}`);
    const out: ActivityItem[] = [];
    for (const { topic, m } of messages) {
      const action = ACTIVITY_MESSAGE_TYPES[m.messageTypeId] ?? `TYPE_${m.messageTypeId}`;
      const traded = m.messageTypeId === 244 || m.messageTypeId === 181;
      out.push({
        date: formatDateTime(m.date ?? topic.date, this.timezone),
        action,
        player: m.targetId ? names.get(m.targetId) ?? `Player ${m.targetId}` : "?",
        playerId: m.targetId ?? null,
        team: traded ? teamName(m.from) : teamName(m.for ?? m.to ?? m.from),
        otherTeam: traded ? teamName(m.to) : null,
      });
    }
    return out.slice(0, limit);
  }

  // ---- Writes: helpers ------------------------------------------------------------

  actor(snap: Snapshot, week?: number): Actor {
    return { teamId: snap.myTeam.id, memberId: this.swid, scoringPeriodId: week ?? snap.latestScoringPeriod ?? snap.scoringPeriodId };
  }

  lineupCandidates(snap: Snapshot): LineupCandidate[] {
    return snap.myTeam.roster.map((p) => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      eligibleSlots: p.eligibleSlotIds,
      currentSlot: p.slotId,
      projected: p.projectedWeek ?? 0,
      injuryStatus: p.injuryStatus,
      onBye: p.game.bye,
      locked: p.locked,
    }));
  }

  /** Validate requested lineup moves against the current roster and league rules. */
  validateLineupMoves(snap: Snapshot, requested: { playerId: number; toSlot: number | string }[]): { moves: LineupMove[]; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const roster = snap.myTeam.roster;
    const byId = new Map(roster.map((p) => [p.id, p]));
    const moves: LineupMove[] = [];
    const seen = new Set<number>();

    for (const req of requested) {
      const player = byId.get(req.playerId);
      if (!player) {
        errors.push(`Player ${req.playerId} is not on your roster.`);
        continue;
      }
      if (seen.has(req.playerId)) {
        errors.push(`${player.name} appears more than once in the moves.`);
        continue;
      }
      seen.add(req.playerId);
      const toSlot = resolveSlot(req.toSlot);
      if (toSlot === undefined) {
        errors.push(`Unknown slot "${req.toSlot}" for ${player.name}. Use a slot name like QB, RB, WR, TE, FLEX, D/ST, K, BE, IR.`);
        continue;
      }
      if (toSlot === player.slotId) {
        warnings.push(`${player.name} is already in ${slotName(toSlot)}; skipped.`);
        continue;
      }
      if (player.locked) {
        errors.push(`${player.name} is locked (${player.game.started ? "game started" : "roster locked"}) and cannot be moved this week.`);
        continue;
      }
      if (toSlot !== SLOT_BENCH && !player.eligibleSlotIds.includes(toSlot)) {
        errors.push(`${player.name} (${player.position}) is not eligible for ${slotName(toSlot)}. Eligible: ${player.eligibleSlots.join(", ")}.`);
        continue;
      }
      if (toSlot === SLOT_IR && !player.eligibleSlotIds.includes(SLOT_IR)) {
        errors.push(`${player.name} is not IR-eligible right now (status ${player.injuryStatus}).`);
        continue;
      }
      moves.push({ playerId: player.id, fromSlot: player.slotId, toSlot });
    }

    // Capacity check after applying all moves.
    const counts = new Map<number, number>();
    for (const p of roster) counts.set(p.slotId, (counts.get(p.slotId) ?? 0) + 1);
    for (const m of moves) {
      counts.set(m.fromSlot, (counts.get(m.fromSlot) ?? 0) - 1);
      counts.set(m.toSlot, (counts.get(m.toSlot) ?? 0) + 1);
    }
    const limits = snap.settings.lineupSlots;
    for (const [slot, count] of counts) {
      const limit = limits[slotName(slot)] ?? snap.settings.startingSlotCounts[slot];
      if (limit !== undefined && count > limit) {
        const movers = moves.filter((m) => m.toSlot === slot).map((m) => byId.get(m.playerId)?.name ?? m.playerId);
        errors.push(
          `${slotName(slot)} would hold ${count} players but the league allows ${limit}. Move someone out of ${slotName(slot)} in the same call (incoming: ${movers.join(", ")}).`,
        );
      }
    }
    return { moves, errors, warnings };
  }

  rosterCapacity(snap: Snapshot): { activeCount: number; rosterLimit: number; irCount: number; irSlots: number; openSpots: number } {
    const activeCount = snap.myTeam.roster.filter((p) => p.slotId !== SLOT_IR).length;
    const irCount = snap.myTeam.roster.filter((p) => p.slotId === SLOT_IR).length;
    return {
      activeCount,
      rosterLimit: snap.settings.rosterLimit,
      irCount,
      irSlots: snap.settings.irSlots,
      openSpots: snap.settings.rosterLimit - activeCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function teamDisplayName(t: RawTeam): string {
  if (t.name?.trim()) return t.name.trim();
  const parts = [t.location, t.nickname].filter((s) => s && s.trim());
  return parts.length ? parts.join(" ") : t.abbrev ?? `Team ${t.id}`;
}

function summariseTeam(t: RawTeam, members: Map<string, { displayName?: string; firstName?: string; lastName?: string }>, settings: LeagueSettingsSummary, isMine: boolean): TeamSummary {
  const overall = t.record?.overall ?? {};
  const owners = (t.owners ?? []).map((id) => {
    const m = members.get(id.toUpperCase());
    return m?.displayName ?? [m?.firstName, m?.lastName].filter(Boolean).join(" ") ?? id;
  });
  const spent = t.transactionCounter?.acquisitionBudgetSpent ?? null;
  const budget = settings.waivers.budget;
  return {
    id: t.id,
    abbrev: t.abbrev ?? `T${t.id}`,
    name: teamDisplayName(t),
    owners,
    record: {
      wins: overall.wins ?? 0,
      losses: overall.losses ?? 0,
      ties: overall.ties ?? 0,
      pointsFor: round1(overall.pointsFor ?? 0),
      pointsAgainst: round1(overall.pointsAgainst ?? 0),
      streak: overall.streakLength && overall.streakType ? `${overall.streakType === "WIN" ? "W" : overall.streakType === "LOSS" ? "L" : "T"}${overall.streakLength}` : null,
    },
    playoffSeed: t.playoffSeed ?? null,
    waiverRank: t.waiverRank ?? null,
    faabSpent: spent,
    faabRemaining: settings.waivers.usesFaab && budget !== null && spent !== null ? budget - spent : null,
    acquisitions: t.transactionCounter?.acquisitions ?? null,
    isMine,
  };
}

function summariseMatchup(m: RawScheduleItem, teamName: (id: number) => string, myTeamId: number): MatchupInfo {
  const side = (s: RawScheduleItem["home"]) =>
    s ? { teamId: s.teamId, team: teamName(s.teamId), points: round1(s.totalPoints ?? 0), projectedLive: numOrNull(s.totalProjectedPointsLive, 1) } : null;
  const home = side(m.home) ?? { teamId: 0, team: "BYE", points: 0, projectedLive: null };
  const away = side(m.away);
  return {
    matchupPeriod: m.matchupPeriodId,
    home,
    away,
    winner: m.winner ?? "UNDECIDED",
    playoffTier: m.playoffTierType ?? "NONE",
    involvesMe: home.teamId === myTeamId || away?.teamId === myTeamId,
  };
}

export function summariseSettings(s: RawSettings, timezone: string, now: Date): LeagueSettingsSummary {
  const counts = s.rosterSettings?.lineupSlotCounts ?? {};
  const lineupSlots: Record<string, number> = {};
  const startingSlotCounts: Record<number, number> = {};
  let rosterLimit = 0;
  let irSlots = 0;
  for (const [slotStr, count] of Object.entries(counts)) {
    const slot = Number(slotStr);
    if (!count) continue;
    lineupSlots[slotName(slot)] = count;
    if (slot === SLOT_IR) irSlots = count;
    else rosterLimit += count;
    if (slot !== SLOT_BENCH && slot !== SLOT_IR) startingSlotCounts[slot] = count;
  }
  const reception = s.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points ?? 0;
  const scoringFormat = reception === 1 ? "PPR" : reception === 0.5 ? "Half-PPR" : reception === 0 ? "Standard" : `${reception} pts/reception`;
  const acq = s.acquisitionSettings ?? {};
  const deadlineMs = s.tradeSettings?.deadlineDate && s.tradeSettings.deadlineDate > 0 ? s.tradeSettings.deadlineDate : null;
  const positionLimits: Record<string, number> = {};
  for (const [pos, limit] of Object.entries(s.rosterSettings?.positionLimits ?? {})) {
    if (limit > 0) positionLimits[positionName(Number(pos))] = limit;
  }
  const regularSeasonWeeks = s.scheduleSettings?.matchupPeriodCount ?? 14;
  return {
    name: s.name ?? "ESPN League",
    size: s.size ?? 0,
    scoringFormat,
    pointsPerReception: reception,
    lineupSlots,
    startingSlotCounts,
    rosterLimit,
    irSlots,
    lineupLockType: s.rosterSettings?.lineupLocktimeType ?? "INDIVIDUAL_GAME",
    undroppableListEnforced: s.rosterSettings?.isUsingUndroppableList ?? false,
    positionLimits,
    waivers: {
      type: acq.acquisitionType ?? "UNKNOWN",
      usesFaab: acq.isUsingAcquisitionBudget ?? false,
      budget: acq.isUsingAcquisitionBudget ? acq.acquisitionBudget ?? null : null,
      minimumBid: acq.minimumBid ?? null,
      processDays: acq.waiverProcessDays ?? [],
      processHour: acq.waiverProcessHour ?? null,
      waiverPeriodHours: acq.waiverHours ?? null,
      acquisitionLimitPerSeason: acq.acquisitionLimit && acq.acquisitionLimit > 0 ? acq.acquisitionLimit : null,
      acquisitionLimitPerMatchup: acq.matchupAcquisitionLimit && acq.matchupAcquisitionLimit > 0 ? acq.matchupAcquisitionLimit : null,
    },
    trades: {
      deadline: formatDateTime(deadlineMs, timezone),
      deadlineMs,
      deadlinePassed: deadlineMs !== null && deadlineMs < now.getTime(),
      reviewHours: s.tradeSettings?.revisionHours ?? null,
      vetoVotesRequired: s.tradeSettings?.vetoVotesRequired ?? null,
    },
    schedule: {
      regularSeasonWeeks,
      playoffTeams: s.scheduleSettings?.playoffTeamCount ?? 0,
      playoffStartMatchupPeriod: regularSeasonWeeks + 1,
      matchupPeriods: s.scheduleSettings?.matchupPeriods ?? {},
    },
  };
}

export function gameInfo(proTeamId: number, week: number, proTeams: Map<number, RawProTeam>, now: Date, timezone: string, weekGames?: RawProGame[]): GameInfo {
  const team = proTeams.get(proTeamId);
  if (!team || proTeamId === 0) return { opponent: null, home: null, kickoff: null, kickoffMs: null, started: false, bye: proTeamId === 0 ? false : true };
  const games = weekGames?.filter((g) => g.homeProTeamId === proTeamId || g.awayProTeamId === proTeamId) ?? team.proGamesByScoringPeriod?.[String(week)] ?? [];
  const game = games[0];
  if (!game) return { opponent: null, home: null, kickoff: null, kickoffMs: null, started: false, bye: true };
  const home = game.homeProTeamId === proTeamId;
  const opponentId = home ? game.awayProTeamId : game.homeProTeamId;
  return {
    opponent: proTeamAbbrev(opponentId),
    home,
    kickoff: formatDateTime(game.date, timezone),
    kickoffMs: game.date,
    started: game.date <= now.getTime(),
    bye: false,
  };
}

function computeLocked(game: GameInfo, lineupLocked: boolean | undefined, lockType: string, weekGames: RawProGame[], now: Date): boolean {
  if (lineupLocked === true) return true;
  if (lockType === "FIRST_GAME_OF_WEEK") {
    const first = weekGames[0];
    return first !== undefined && first.date <= now.getTime();
  }
  return game.started;
}

function resolveSlotFilter(positions: string[] | undefined): number[] {
  if (!positions || positions.length === 0) return [0, 2, 4, 6, 16, 17];
  const ids = new Set<number>();
  for (const p of positions) {
    const key = p.trim().toUpperCase();
    const mapped = POSITION_SLOT_FILTER[key] ?? POSITION_SLOT_FILTER[key.replace("DEF", "D/ST")];
    if (mapped) mapped.forEach((id) => ids.add(id));
    else if (key === "ALL") [0, 2, 4, 6, 16, 17].forEach((id) => ids.add(id));
    else {
      const slot = resolveSlot(key);
      if (slot !== undefined) ids.add(slot);
    }
  }
  return ids.size ? [...ids] : [0, 2, 4, 6, 16, 17];
}

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numOrNull(n: number | undefined | null, decimals = 1): number | null {
  if (n === undefined || n === null || Number.isNaN(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export { UNAVAILABLE_STATUSES };
