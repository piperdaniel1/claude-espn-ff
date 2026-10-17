/**
 * MCP tool surface. Each tool returns compact JSON so the scheduled Claude run
 * can reason over exact numbers. Write tools validate against the live roster
 * first, support `dry_run`, and never retry (ESPN has no idempotency key).
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppConfig } from "../config.ts";
import { EspnHttpError, EspnUnknownOutcomeError } from "../espn/client.ts";
import { SLOT_BENCH, SLOT_IR, slotName, resolveSlot } from "../espn/constants.ts";
import type { LeagueService, PlayerInfo, RosterPlayer, Snapshot, TeamSummary, TransactionInfo } from "../espn/league.ts";
import { LeagueError } from "../espn/league.ts";
import { planLineup, type LineupPlan } from "../espn/lineup.ts";
import {
  buildAddDropTransaction,
  buildCancelTransaction,
  buildLineupTransaction,
  buildTradeProposalTransaction,
  buildTradeResponseTransaction,
  buildWaiverClaimTransaction,
  interpretWriteResponse,
  type TransactionPayload,
  type WriteOutcome,
} from "../espn/transactions.ts";
import type { Journal } from "../journal/store.ts";
import { formatDateTime, humanDuration, weekdayName } from "../util/time.ts";

export interface ServerDeps {
  config: AppConfig;
  league: LeagueService;
  journal: Journal;
  version?: string;
}

export const SERVER_NAME = "espn-fantasy-football";

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}

function describeError(err: unknown): CallToolResult {
  if (err instanceof EspnUnknownOutcomeError) {
    return fail(err.message, { outcome: "unknown", retry_safe: false });
  }
  if (err instanceof EspnHttpError) {
    return fail(err.message, {
      espn_status: err.status,
      espn_details: err.details.map((d) => d.type ?? d.shortMessage ?? d.message).filter(Boolean),
      auth_problem: err.isAuthError,
    });
  }
  if (err instanceof LeagueError) return fail(err.message);
  if (err instanceof Error) return fail(`${err.name}: ${err.message}`);
  return fail(String(err));
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return describeError(err);
  }
}

// ---------------------------------------------------------------------------
// Compact views for tool output
// ---------------------------------------------------------------------------

function compactPlayer(p: PlayerInfo) {
  return {
    id: p.id,
    name: p.name,
    pos: p.position,
    team: p.proTeam,
    status: p.injuryStatus,
    proj_week: p.projectedWeek,
    pts_week: p.actualWeek,
    season_pts: p.seasonPoints,
    season_avg: p.seasonAvg,
    season_proj: p.seasonProjected,
    pos_rank: p.positionRank,
    pct_owned: p.percentOwned,
    pct_started: p.percentStarted,
    pct_change: p.percentChange,
    game: p.game.bye ? "BYE" : p.game.opponent ? `${p.game.home ? "vs" : "@"} ${p.game.opponent} ${p.game.kickoff ?? ""}`.trim() : null,
    game_started: p.game.started,
    eligible: p.eligibleSlots,
    ...(p.availability !== undefined ? { availability: p.availability, owned_by: p.onTeamName ?? null } : {}),
  };
}

function compactRosterPlayer(p: RosterPlayer) {
  return { slot: p.slot, locked: p.locked, ...compactPlayer(p), droppable: p.droppable };
}

function compactTeam(t: TeamSummary) {
  const r = t.record;
  return {
    id: t.id,
    name: t.name,
    abbrev: t.abbrev,
    owners: t.owners,
    record: `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`,
    points_for: r.pointsFor,
    points_against: r.pointsAgainst,
    streak: r.streak,
    playoff_seed: t.playoffSeed,
    waiver_rank: t.waiverRank,
    faab_remaining: t.faabRemaining,
    is_me: t.isMine,
  };
}

function compactTransaction(t: TransactionInfo) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    pending: t.pending,
    team: t.team,
    is_mine: t.isMine,
    awaiting_my_response: t.awaitingMyResponse,
    bid: t.bidAmount,
    proposed: t.proposed,
    processed: t.processed,
    expires: t.expires,
    week: t.scoringPeriodId,
    items: t.items.map((i) => `${i.action} ${i.player}${i.fromTeam ? ` from ${i.fromTeam}` : ""}${i.toTeam ? ` to ${i.toTeam}` : ""}${i.toSlot ? ` -> ${i.toSlot}` : ""}`),
    item_player_ids: t.items.map((i) => ({ action: i.action, player_id: i.playerId, player: i.player })),
  };
}

function lineupIssues(snap: Snapshot): string[] {
  const issues: string[] = [];
  const starters = snap.myTeam.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR);
  for (const p of starters) {
    if (p.game.bye) issues.push(`${p.name} (${p.slot}) is on BYE`);
    else if (["OUT", "INJURY_RESERVE", "SUSPENSION"].includes(p.injuryStatus)) issues.push(`${p.name} (${p.slot}) is ${p.injuryStatus}`);
    else if (p.injuryStatus === "DOUBTFUL") issues.push(`${p.name} (${p.slot}) is DOUBTFUL`);
    else if (p.injuryStatus === "QUESTIONABLE") issues.push(`${p.name} (${p.slot}) is QUESTIONABLE`);
  }
  const counts = new Map<number, number>();
  for (const p of starters) counts.set(p.slotId, (counts.get(p.slotId) ?? 0) + 1);
  for (const [slot, want] of Object.entries(snap.settings.startingSlotCounts)) {
    const have = counts.get(Number(slot)) ?? 0;
    if (have < want) issues.push(`${slotName(Number(slot))} has ${want - have} empty starting slot(s)`);
  }
  return issues;
}

function nextKickoffInfo(snap: Snapshot) {
  const now = snap.now.getTime();
  const mine = snap.myTeam.roster
    .filter((p) => p.game.kickoffMs !== null && p.game.kickoffMs > now)
    .sort((a, b) => a.game.kickoffMs! - b.game.kickoffMs!);
  const next = mine[0];
  return {
    my_next_locking_player: next
      ? { name: next.name, slot: next.slot, kickoff: next.game.kickoff, in: humanDuration(next.game.kickoffMs! - now) }
      : null,
    my_locked_players: snap.myTeam.roster.filter((p) => p.locked).map((p) => `${p.name} (${p.slot})`),
  };
}

function phaseOf(snap: Snapshot): string {
  if (!snap.isActive && snap.currentMatchupPeriod <= 1) return "preseason";
  const regular = snap.settings.schedule.regularSeasonWeeks;
  if (snap.currentMatchupPeriod > regular) {
    return snap.scoringPeriodId > snap.finalScoringPeriod ? "season_over" : "playoffs";
  }
  return "regular_season";
}

async function writeAndReport(
  deps: ServerDeps,
  payload: TransactionPayload,
  dryRun: boolean,
  summary: string,
  warnings: string[] = [],
): Promise<CallToolResult> {
  if (dryRun) {
    return ok({ dry_run: true, would_submit: summary, payload, warnings });
  }
  const res = await deps.league.client.postTransaction(payload as unknown as Record<string, unknown>);
  const outcome: WriteOutcome = interpretWriteResponse(res.body);
  deps.league.invalidate();
  let after: unknown = undefined;
  try {
    const snap = await deps.league.getSnapshot();
    after = {
      starters: snap.myTeam.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).map((p) => `${p.slot}: ${p.name}`),
      bench: snap.myTeam.roster.filter((p) => p.slotId === SLOT_BENCH).map((p) => p.name),
      ir: snap.myTeam.roster.filter((p) => p.slotId === SLOT_IR).map((p) => p.name),
      lineup_issues: lineupIssues(snap),
    };
  } catch {
    after = "could not re-read roster";
  }
  return ok({
    submitted: summary,
    outcome: outcome.outcome,
    espn_status: outcome.status ?? null,
    transaction_id: outcome.transactionId ?? null,
    espn_messages: outcome.messages,
    warnings,
    roster_after: after,
    espn_response: outcome.outcome === "unknown" ? res.body : undefined,
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildMcpServer(deps: ServerDeps): McpServer {
  const { league, journal, config } = deps;
  const tz = config.timezone;
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.version ?? "0.1.0" },
    {
      instructions: [
        "Tools for managing one ESPN Fantasy Football team (the team configured on the server).",
        "Start every session with get_context, then get_my_roster / get_lineup_recommendation before changing anything.",
        "All times are shown in the user's timezone. Player ids are ESPN player ids and are stable across tools.",
        "Write tools (set_lineup, apply_recommended_lineup, add_free_agent, claim_waiver_player, drop_player, propose_trade, respond_to_trade, cancel_pending_transaction) accept dry_run=true to preview the exact ESPN payload without sending it.",
        "ESPN has no undo: a drop releases the player to the league immediately.",
      ].join(" "),
    },
  );

  const dryRunField = z.boolean().optional().describe("If true, validate and return the exact ESPN payload without submitting it.");
  const weekField = z.number().int().min(1).max(18).optional().describe("NFL week / scoring period. Defaults to the current week.");

  // ---- Context ------------------------------------------------------------------

  server.registerTool(
    "get_context",
    {
      title: "League and team context",
      description:
        "Call this first. Returns the current date/time, NFL week, season phase, league rules (roster slots, scoring, waivers/FAAB, trade deadline), my team's record and standing, this week's matchup, lineup problems (bye/OUT starters, empty slots), player lock times, pending transactions that need attention, and the latest journal entries.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const [transactions, journalEntries] = await Promise.all([
          league.getTransactions().catch(() => [] as TransactionInfo[]),
          journal.read(5).catch(() => []),
        ]);
        const me = snap.myTeam;
        const matchup = snap.schedule.find((m) => m.matchupPeriod === snap.currentMatchupPeriod && m.involvesMe);
        const opponentId = matchup ? (matchup.home.teamId === me.id ? matchup.away?.teamId : matchup.home.teamId) : undefined;
        const opponent = opponentId ? snap.teams.find((t) => t.id === opponentId) : undefined;
        const projectedTotal = (team: typeof me) =>
          Math.round(team.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).reduce((s, p) => s + (p.projectedWeek ?? 0), 0) * 10) / 10;
        const pending = transactions.filter((t) => t.pending);
        const standings = [...snap.teams].sort(
          (a, b) => b.record.wins - a.record.wins || a.record.losses - b.record.losses || b.record.pointsFor - a.record.pointsFor,
        );
        const myRank = standings.findIndex((t) => t.id === me.id) + 1;
        const kick = nextKickoffInfo(snap);
        const nowMs = snap.now.getTime();
        return ok({
          now: formatDateTime(snap.now, tz),
          weekday: weekdayName(snap.now, tz),
          timezone: tz,
          season: snap.season,
          nfl_week: snap.scoringPeriodId,
          matchup_period: snap.currentMatchupPeriod,
          phase: phaseOf(snap),
          league: {
            id: snap.leagueId,
            name: snap.leagueName,
            teams: snap.settings.size,
            scoring: snap.settings.scoringFormat,
            lineup_slots: snap.settings.lineupSlots,
            roster_limit_excluding_ir: snap.settings.rosterLimit,
            ir_slots: snap.settings.irSlots,
            lineup_lock: snap.settings.lineupLockType,
            position_limits: snap.settings.positionLimits,
            waivers: snap.settings.waivers,
            waiver_next_run: formatDateTime(snap.status.waiverNextExecutionDate, tz),
            waiver_last_run: formatDateTime(snap.status.waiverLastExecutionDate, tz),
            trades: snap.settings.trades,
            regular_season_weeks: snap.settings.schedule.regularSeasonWeeks,
            playoff_teams: snap.settings.schedule.playoffTeams,
          },
          my_team: {
            ...compactTeam(me),
            standing: `${myRank} of ${snap.teams.length}`,
            roster_spots_open: league.rosterCapacity(snap).openSpots,
            acquisitions_this_season: me.acquisitions,
            projected_this_week: projectedTotal(me),
          },
          this_week_matchup: matchup
            ? {
                opponent: opponent ? compactTeam(opponent) : null,
                opponent_projected: opponent ? projectedTotal(opponent) : null,
                my_points_so_far: matchup.home.teamId === me.id ? matchup.home.points : matchup.away?.points,
                opponent_points_so_far: matchup.home.teamId === me.id ? matchup.away?.points : matchup.home.points,
                playoff_tier: matchup.playoffTier,
              }
            : null,
          lineup_issues: lineupIssues(snap),
          locks: {
            ...kick,
            week_first_kickoff: snap.weekGames[0] ? formatDateTime(snap.weekGames[0].date, tz) : null,
            week_last_kickoff: snap.weekGames.length ? formatDateTime(snap.weekGames[snap.weekGames.length - 1]!.date, tz) : null,
            week_games_remaining: snap.weekGames.filter((g) => g.date > nowMs).length,
          },
          pending_transactions: pending.map(compactTransaction),
          trades_awaiting_my_response: pending.filter((t) => t.awaitingMyResponse).length,
          journal: {
            storage: journal.storageDescription,
            persistent: journal.persistent,
            recent: journalEntries,
          },
        });
      }),
  );

  // ---- Roster / lineup ------------------------------------------------------------

  server.registerTool(
    "get_my_roster",
    {
      title: "My roster",
      description:
        "Every player on my team with slot, lock status, injury status, this week's projection and opponent/kickoff, season points, ownership and positional rank. Use the ids here for lineup, drop and trade tools.",
      inputSchema: z.object({ week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ week }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const cap = league.rosterCapacity(snap);
        return ok({
          week: snap.scoringPeriodId,
          team: snap.myTeam.name,
          roster_capacity: cap,
          starters: snap.myTeam.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).map(compactRosterPlayer),
          bench: snap.myTeam.roster.filter((p) => p.slotId === SLOT_BENCH).map(compactRosterPlayer),
          ir: snap.myTeam.roster.filter((p) => p.slotId === SLOT_IR).map(compactRosterPlayer),
          lineup_issues: lineupIssues(snap),
        });
      }),
  );

  server.registerTool(
    "get_lineup_recommendation",
    {
      title: "Recommended lineup",
      description:
        "Computes the projected-optimal starting lineup from ESPN projections, respecting slot eligibility, locked players, byes and injury designations (OUT/IR/suspended count as 0, DOUBTFUL is discounted). Returns the proposed starters, the exact moves needed, and warnings. Does not change anything; use apply_recommended_lineup or set_lineup to act.",
      inputSchema: z.object({ week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ week }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const plan = planLineup(league.lineupCandidates(snap), snap.settings.startingSlotCounts);
        return ok(renderPlan(snap, plan));
      }),
  );

  server.registerTool(
    "set_lineup",
    {
      title: "Set lineup (move players between slots)",
      description:
        "Move players between lineup slots in one ESPN transaction. Provide every move needed for a legal lineup in a single call (e.g. bench the current WR AND start the new WR). Slots: QB, RB, WR, TE, FLEX, D/ST, K, BE (bench), IR. Rejects moves for locked players or ineligible slots before anything is sent.",
      inputSchema: z.object({
        moves: z
          .array(
            z.object({
              player_id: z.number().int().describe("ESPN player id from get_my_roster"),
              to_slot: z.string().describe("Target slot name, e.g. WR, FLEX, BE, IR"),
            }),
          )
          .min(1),
        week: weekField,
        dry_run: dryRunField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ moves, week, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const validated = league.validateLineupMoves(
          snap,
          moves.map((m) => ({ playerId: m.player_id, toSlot: m.to_slot })),
        );
        if (validated.errors.length) return fail("Lineup moves rejected before submission.", { errors: validated.errors, warnings: validated.warnings });
        if (validated.moves.length === 0) return ok({ submitted: null, note: "Nothing to change.", warnings: validated.warnings });
        const payload = buildLineupTransaction(league.actor(snap, snap.scoringPeriodId), validated.moves, snap.latestScoringPeriod);
        const names = new Map(snap.myTeam.roster.map((p) => [p.id, p.name]));
        const summary = validated.moves.map((m) => `${names.get(m.playerId)}: ${slotName(m.fromSlot)} -> ${slotName(m.toSlot)}`).join("; ");
        return writeAndReport(deps, payload, dry_run ?? false, summary, validated.warnings);
      }),
  );

  server.registerTool(
    "apply_recommended_lineup",
    {
      title: "Apply the recommended lineup",
      description:
        "Runs the same optimiser as get_lineup_recommendation and submits all resulting moves as one transaction. Safe to call when nothing needs to change (it reports unchanged). Use dry_run to preview.",
      inputSchema: z.object({ week: weekField, dry_run: dryRunField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ week, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const plan = planLineup(league.lineupCandidates(snap), snap.settings.startingSlotCounts);
        if (plan.moves.length === 0) {
          return ok({ submitted: null, unchanged: true, projected_total: plan.projectedTotal, warnings: plan.warnings, lineup: renderPlan(snap, plan).starters });
        }
        const payload = buildLineupTransaction(league.actor(snap, snap.scoringPeriodId), plan.moves, snap.latestScoringPeriod);
        const names = new Map(snap.myTeam.roster.map((p) => [p.id, p.name]));
        const summary = plan.moves.map((m) => `${names.get(m.playerId)}: ${slotName(m.fromSlot)} -> ${slotName(m.toSlot)}`).join("; ");
        return writeAndReport(deps, payload, dry_run ?? false, summary, [
          ...plan.warnings,
          `Projected total ${plan.currentProjectedTotal} -> ${plan.projectedTotal}`,
        ]);
      }),
  );

  // ---- League info ------------------------------------------------------------------

  server.registerTool(
    "get_matchup",
    {
      title: "This week's matchup",
      description: "My matchup for a week: opponent, scores so far, both starting lineups with projections, and the opponent's bench. Useful for deciding how much risk to take.",
      inputSchema: z.object({ week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ week }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const period = week === undefined ? snap.currentMatchupPeriod : matchupPeriodForWeek(snap, week);
        const matchup = snap.schedule.find((m) => m.matchupPeriod === period && m.involvesMe);
        if (!matchup) return ok({ week: snap.scoringPeriodId, matchup: null, note: "No matchup for my team in this period (bye or season over)." });
        const me = snap.myTeam;
        const oppId = matchup.home.teamId === me.id ? matchup.away?.teamId : matchup.home.teamId;
        const opp = snap.teams.find((t) => t.id === oppId);
        const lineup = (team: typeof me) => ({
          starters: team.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).map(compactRosterPlayer),
          bench: team.roster.filter((p) => p.slotId === SLOT_BENCH).map(compactRosterPlayer),
          projected: Math.round(team.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).reduce((s, p) => s + (p.projectedWeek ?? 0), 0) * 10) / 10,
        });
        return ok({
          week: snap.scoringPeriodId,
          matchup_period: period,
          playoff_tier: matchup.playoffTier,
          winner: matchup.winner,
          me: { ...compactTeam(me), points: matchup.home.teamId === me.id ? matchup.home.points : matchup.away?.points, ...lineup(me) },
          opponent: opp ? { ...compactTeam(opp), points: matchup.home.teamId === opp.id ? matchup.home.points : matchup.away?.points, ...lineup(opp) } : null,
        });
      }),
  );

  server.registerTool(
    "get_standings",
    {
      title: "Standings",
      description: "All teams with record, points for/against, playoff seed, waiver priority and FAAB remaining. Also returns my full season schedule with results.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const standings = [...snap.teams].sort(
          (a, b) => b.record.wins - a.record.wins || a.record.losses - b.record.losses || b.record.pointsFor - a.record.pointsFor,
        );
        const mySchedule = snap.schedule
          .filter((m) => m.involvesMe)
          .map((m) => {
            const home = m.home.teamId === snap.myTeam.id;
            const opp = home ? m.away : m.home;
            const myPts = home ? m.home.points : m.away?.points ?? 0;
            const oppPts = home ? m.away?.points ?? 0 : m.home.points;
            const result = m.winner === "UNDECIDED" ? (m.matchupPeriod === snap.currentMatchupPeriod ? "in progress" : "upcoming") : myPts > oppPts ? "W" : myPts < oppPts ? "L" : "T";
            return { matchup_period: m.matchupPeriod, opponent: opp?.team ?? "BYE", opponent_id: opp?.teamId ?? null, my_points: myPts, opp_points: oppPts, result, playoff_tier: m.playoffTier };
          });
        return ok({
          week: snap.scoringPeriodId,
          regular_season_weeks: snap.settings.schedule.regularSeasonWeeks,
          playoff_teams: snap.settings.schedule.playoffTeams,
          standings: standings.map((t, i) => ({ rank: i + 1, ...compactTeam(t) })),
          my_schedule: mySchedule,
        });
      }),
  );

  server.registerTool(
    "get_team_roster",
    {
      title: "Another team's roster",
      description: "Roster of any team in the league (for trade targets). Use get_standings for team ids.",
      inputSchema: z.object({ team_id: z.number().int(), week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ team_id, week }) =>
      guard(async () => {
        const snap = await league.getSnapshot(week);
        const team = snap.teams.find((t) => t.id === team_id);
        if (!team) return fail(`No team with id ${team_id}. Teams: ${snap.teams.map((t) => `${t.id}=${t.name}`).join(", ")}`);
        return ok({
          week: snap.scoringPeriodId,
          team: compactTeam(team),
          starters: team.roster.filter((p) => p.slotId !== SLOT_BENCH && p.slotId !== SLOT_IR).map(compactRosterPlayer),
          bench: team.roster.filter((p) => p.slotId === SLOT_BENCH).map(compactRosterPlayer),
          ir: team.roster.filter((p) => p.slotId === SLOT_IR).map(compactRosterPlayer),
        });
      }),
  );

  // ---- Players ------------------------------------------------------------------------

  server.registerTool(
    "get_free_agents",
    {
      title: "Free agents and waiver players",
      description:
        "Available players (free agents and, by default, players currently on waivers) with projections, ownership and this week's game. Filter by position and sort by projected points for the week, projected season total, season points, ownership or ownership change. 'availability' tells you whether a player can be added instantly (FREEAGENT) or needs a waiver claim (WAIVERS).",
      inputSchema: z.object({
        positions: z.array(z.string()).optional().describe("Any of QB, RB, WR, TE, K, D/ST. Default: all."),
        limit: z.number().int().min(1).max(60).optional().describe("Default 25."),
        sort: z.enum(["percent_owned", "projected_week", "projected_season", "season_points", "percent_change"]).optional(),
        include_waivers: z.boolean().optional().describe("Default true."),
        min_percent_owned: z.number().min(0).max(100).optional(),
        week: weekField,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const res = await league.getFreeAgents({
          positions: args.positions,
          limit: args.limit,
          sort: args.sort,
          includeWaivers: args.include_waivers,
          minPercentOwned: args.min_percent_owned,
          week: args.week,
        });
        return ok({ week: res.week, count: res.players.length, players: res.players.map(compactPlayer) });
      }),
  );

  server.registerTool(
    "search_players",
    {
      title: "Search players by name",
      description: "Find NFL players by (partial) name across the whole player pool, with league availability (free agent / waivers / which team owns them) and stats.",
      inputSchema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(15).optional(), week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, week }) =>
      guard(async () => {
        const players = await league.searchPlayers(query, limit ?? 8, week);
        return ok({ query, count: players.length, players: players.map(compactPlayer) });
      }),
  );

  server.registerTool(
    "get_player",
    {
      title: "Player details",
      description: "Full detail for one or more player ids: weekly points history, projections, ownership, availability and this week's game.",
      inputSchema: z.object({ player_ids: z.array(z.number().int()).min(1).max(25), week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ player_ids, week }) =>
      guard(async () => {
        const players = await league.getPlayers(player_ids, week);
        return ok({
          players: players.map((p) => ({ ...compactPlayer(p), weekly_points: p.weeklyPoints, last_season_pts: p.lastSeasonPoints, droppable: p.droppable, news_updated: p.newsUpdated })),
        });
      }),
  );

  // ---- Transactions ---------------------------------------------------------------------

  server.registerTool(
    "get_transactions",
    {
      title: "Pending and recent transactions",
      description:
        "Waiver claims, adds/drops and trades for the current and next scoring period across the league, with status. Includes my pending waiver claims and any trade proposals waiting for my response (awaiting_my_response=true). Use the ids with cancel_pending_transaction / respond_to_trade.",
      inputSchema: z.object({
        only_mine: z.boolean().optional().describe("Only transactions involving my team."),
        only_pending: z.boolean().optional(),
        include_lineup_moves: z.boolean().optional().describe("Include ROSTER (lineup) transactions. Default false."),
        week: weekField,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ only_mine, only_pending, include_lineup_moves, week }) =>
      guard(async () => {
        let txs = await league.getTransactions({ week, includeLineupMoves: include_lineup_moves });
        if (only_mine) txs = txs.filter((t) => t.isMine || t.awaitingMyResponse);
        if (only_pending) txs = txs.filter((t) => t.pending);
        return ok({ count: txs.length, transactions: txs.map(compactTransaction) });
      }),
  );

  server.registerTool(
    "get_league_activity",
    {
      title: "Recent league activity",
      description: "The league's recent adds, drops and trades (all teams), newest first. Good for spotting what competitors are doing and which players just became available.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        const items = await league.getRecentActivity(limit ?? 25);
        return ok({ count: items.length, activity: items });
      }),
  );

  server.registerTool(
    "get_nfl_schedule",
    {
      title: "NFL games for a week",
      description: "Kickoff times (in the user's timezone) for every NFL game in a week, plus teams on bye. Use it to know when players lock.",
      inputSchema: z.object({ week: weekField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ week }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const w = week ?? snap.scoringPeriodId;
        const proTeams = await league.getProTeams();
        const games = league.gamesForWeek(proTeams, w);
        const playing = new Set(games.flatMap((g) => [g.homeProTeamId, g.awayProTeamId]));
        const byes = [...proTeams.values()].filter((t) => t.id !== 0 && !playing.has(t.id)).map((t) => t.abbrev ?? String(t.id));
        return ok({
          week: w,
          now: formatDateTime(snap.now, tz),
          games: games.map((g) => ({
            kickoff: formatDateTime(g.date, tz),
            away: proTeams.get(g.awayProTeamId)?.abbrev ?? g.awayProTeamId,
            home: proTeams.get(g.homeProTeamId)?.abbrev ?? g.homeProTeamId,
            started: g.date <= snap.now.getTime(),
          })),
          teams_on_bye: byes,
        });
      }),
  );

  // ---- Roster moves -------------------------------------------------------------------

  server.registerTool(
    "add_free_agent",
    {
      title: "Add a free agent (instant)",
      description:
        "Immediately add a FREE AGENT (not a player on waivers), optionally dropping a player in the same transaction. Fails before sending if the roster is full and no drop is given, the player is on waivers (use claim_waiver_player), or the player to drop is locked. The added player goes to the bench; use set_lineup afterwards.",
      inputSchema: z.object({
        add_player_id: z.number().int(),
        drop_player_id: z.number().int().optional(),
        dry_run: dryRunField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ add_player_id, drop_player_id, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const check = await preflightAcquisition(league, snap, add_player_id, drop_player_id, "free_agent");
        if (check.errors.length) return fail("Add rejected before submission.", { errors: check.errors, warnings: check.warnings });
        const payload = buildAddDropTransaction(league.actor(snap), {
          add: { playerId: add_player_id },
          drop: drop_player_id !== undefined ? { playerId: drop_player_id } : undefined,
        });
        return writeAndReport(deps, payload, dry_run ?? false, check.summary, check.warnings);
      }),
  );

  server.registerTool(
    "claim_waiver_player",
    {
      title: "Place a waiver claim",
      description:
        "Submit a waiver claim for a player (works for players on waivers; in FAAB leagues include bid_amount). Optionally name a player to drop if the claim succeeds. The claim stays PENDING until the league processes waivers. Fails before sending if the bid exceeds remaining FAAB or the roster would overflow without a drop.",
      inputSchema: z.object({
        add_player_id: z.number().int(),
        drop_player_id: z.number().int().optional(),
        bid_amount: z.number().int().min(0).optional().describe("FAAB dollars to bid. Required in FAAB leagues (0 allowed if the league allows $0 bids)."),
        dry_run: dryRunField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ add_player_id, drop_player_id, bid_amount, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const check = await preflightAcquisition(league, snap, add_player_id, drop_player_id, "waiver", bid_amount);
        if (check.errors.length) return fail("Waiver claim rejected before submission.", { errors: check.errors, warnings: check.warnings });
        const payload = buildWaiverClaimTransaction(league.actor(snap), {
          add: { playerId: add_player_id },
          drop: drop_player_id !== undefined ? { playerId: drop_player_id } : undefined,
          bidAmount: snap.settings.waivers.usesFaab ? bid_amount ?? 0 : undefined,
        });
        return writeAndReport(deps, payload, dry_run ?? false, check.summary, check.warnings);
      }),
  );

  server.registerTool(
    "drop_player",
    {
      title: "Drop a player",
      description: "Release a player from my roster to the league (waivers/free agency). Irreversible. Fails if the player is locked or undroppable.",
      inputSchema: z.object({ player_id: z.number().int(), dry_run: dryRunField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ player_id, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const player = snap.myTeam.roster.find((p) => p.id === player_id);
        if (!player) return fail(`Player ${player_id} is not on my roster.`);
        const errors: string[] = [];
        if (player.locked) errors.push(`${player.name} is locked (game started) and cannot be dropped until the week ends.`);
        if (!player.droppable) errors.push(`${player.name} is on ESPN's undroppable list.`);
        if (errors.length) return fail("Drop rejected before submission.", { errors });
        const payload = buildAddDropTransaction(league.actor(snap), { drop: { playerId: player_id } });
        return writeAndReport(deps, payload, dry_run ?? false, `Drop ${player.name} (${player.position}, ${player.proTeam})`, [
          "This releases the player immediately; other teams may claim them.",
        ]);
      }),
  );

  server.registerTool(
    "cancel_pending_transaction",
    {
      title: "Cancel a pending waiver claim or trade proposal",
      description: "Cancel one of MY pending transactions by id (from get_transactions / get_context). Works for waiver claims; cancelling a trade proposal is best-effort.",
      inputSchema: z.object({ transaction_id: z.string().min(1), dry_run: dryRunField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ transaction_id, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const txs = await league.getTransactions();
        const tx = txs.find((t) => t.id === transaction_id);
        if (!tx) return fail(`No transaction ${transaction_id} found in the current/next scoring period.`);
        if (!tx.isMine) return fail(`Transaction ${transaction_id} belongs to ${tx.team}, not my team.`);
        if (!tx.pending) return fail(`Transaction ${transaction_id} is ${tx.status}, not pending.`);
        if (tx.type !== "WAIVER" && tx.type !== "TRADE_PROPOSAL") return fail(`Cannot cancel a ${tx.type} transaction.`);
        const payload = buildCancelTransaction(league.actor(snap, tx.scoringPeriodId ?? undefined), tx.type, tx.id);
        return writeAndReport(deps, payload, dry_run ?? false, `Cancel ${tx.type} ${tx.id}: ${tx.items.map((i) => `${i.action} ${i.player}`).join(", ")}`);
      }),
  );

  // ---- Trades ---------------------------------------------------------------------------

  server.registerTool(
    "propose_trade",
    {
      title: "Propose a trade",
      description:
        "Send a trade proposal to another team: the players I give and the players I receive (ids). Validates ownership and the trade deadline first. Note: the ESPN trade endpoint is reverse-engineered; check get_transactions afterwards to confirm the proposal is PENDING.",
      inputSchema: z.object({
        to_team_id: z.number().int(),
        send_player_ids: z.array(z.number().int()).min(1).describe("Players leaving my team"),
        receive_player_ids: z.array(z.number().int()).min(1).describe("Players coming from the other team"),
        comment: z.string().max(500).optional(),
        expires_in_hours: z.number().int().min(1).max(336).optional().describe("Default 72."),
        dry_run: dryRunField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to_team_id, send_player_ids, receive_player_ids, comment, expires_in_hours, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const other = snap.teams.find((t) => t.id === to_team_id);
        const errors: string[] = [];
        if (!other) errors.push(`No team ${to_team_id}.`);
        if (snap.settings.trades.deadlinePassed) errors.push(`The trade deadline (${snap.settings.trades.deadline}) has passed.`);
        const mine = new Map(snap.myTeam.roster.map((p) => [p.id, p]));
        const theirs = new Map((other?.roster ?? []).map((p) => [p.id, p]));
        for (const id of send_player_ids) if (!mine.has(id)) errors.push(`Player ${id} is not on my roster.`);
        for (const id of receive_player_ids) if (!theirs.has(id)) errors.push(`Player ${id} is not on ${other?.name ?? "that team"}'s roster.`);
        const netChange = receive_player_ids.length - send_player_ids.length;
        const cap = league.rosterCapacity(snap);
        const warnings: string[] = [];
        if (netChange > cap.openSpots) warnings.push(`This trade adds ${netChange} net player(s) but only ${cap.openSpots} roster spot(s) are open; ESPN will require drops when it executes.`);
        if (errors.length) return fail("Trade proposal rejected before submission.", { errors, warnings });
        const payload = buildTradeProposalTransaction(league.actor(snap), {
          toTeamId: to_team_id,
          sendPlayerIds: send_player_ids,
          receivePlayerIds: receive_player_ids,
          comment,
          expirationDate: snap.now.getTime() + (expires_in_hours ?? 72) * 3600_000,
        });
        const summary = `Propose to ${other!.name}: give ${send_player_ids.map((id) => mine.get(id)!.name).join(", ")}; get ${receive_player_ids.map((id) => theirs.get(id)!.name).join(", ")}`;
        return writeAndReport(deps, payload, dry_run ?? false, summary, warnings);
      }),
  );

  server.registerTool(
    "respond_to_trade",
    {
      title: "Accept or decline a trade proposed to me",
      description:
        "Accept or decline a pending trade proposal addressed to my team (awaiting_my_response=true in get_transactions). When accepting, include drop_player_ids if the trade would overflow my roster. Note: reverse-engineered endpoint; verify with get_transactions afterwards.",
      inputSchema: z.object({
        transaction_id: z.string().min(1),
        action: z.enum(["accept", "decline"]),
        drop_player_ids: z.array(z.number().int()).optional(),
        comment: z.string().max(500).optional(),
        dry_run: dryRunField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ transaction_id, action, drop_player_ids, comment, dry_run }) =>
      guard(async () => {
        const snap = await league.getSnapshot();
        const txs = await league.getTransactions();
        const tx = txs.find((t) => t.id === transaction_id);
        if (!tx) return fail(`No transaction ${transaction_id} found.`);
        if (!tx.awaitingMyResponse) return fail(`Transaction ${transaction_id} is not a pending trade proposal addressed to my team (type ${tx.type}, status ${tx.status}).`);
        const incoming = tx.items.filter((i) => i.action === "TRADE" && i.toTeam === snap.myTeam.name).length;
        const outgoing = tx.items.filter((i) => i.action === "TRADE" && i.fromTeam === snap.myTeam.name).length;
        const cap = league.rosterCapacity(snap);
        const warnings: string[] = [];
        if (action === "accept" && incoming - outgoing - (drop_player_ids?.length ?? 0) > cap.openSpots) {
          warnings.push(`Accepting adds ${incoming - outgoing} net players with ${cap.openSpots} open spot(s); ESPN may reject without drops.`);
        }
        const payload = buildTradeResponseTransaction(league.actor(snap, tx.scoringPeriodId ?? undefined), {
          relatedTransactionId: tx.id,
          accept: action === "accept",
          dropPlayerIds: drop_player_ids,
          comment,
        });
        return writeAndReport(deps, payload, dry_run ?? false, `${action === "accept" ? "Accept" : "Decline"} trade ${tx.id} from ${tx.team}: ${tx.items.map((i) => `${i.player} ${i.fromTeam} -> ${i.toTeam}`).join(", ")}`, warnings);
      }),
  );

  // ---- Journal ----------------------------------------------------------------------------

  server.registerTool(
    "read_journal",
    {
      title: "Read the team journal",
      description: "Notes written by previous runs: run summaries, watchlists, pending plans (e.g. 'proposed trade to X on Tue'). Read this at the start of a run to keep continuity.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional().describe("Default 10."), kind: z.string().optional().describe("Filter by kind, e.g. run_summary, watchlist, note.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, kind }) =>
      guard(async () => {
        const entries = await journal.read(limit ?? 10, kind);
        return ok({ storage: journal.storageDescription, persistent: journal.persistent, count: entries.length, entries });
      }),
  );

  server.registerTool(
    "append_journal",
    {
      title: "Append a journal entry",
      description: "Record a note for future runs (what you did, why, what to watch next). Keep entries short; the last 250 are kept. Kinds: run_summary, watchlist, note, trade_log.",
      inputSchema: z.object({ kind: z.enum(["run_summary", "watchlist", "note", "trade_log"]).default("note"), text: z.string().min(1).max(4000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ kind, text }) =>
      guard(async () => {
        let week: number | null = null;
        try {
          week = (await league.getSnapshot()).scoringPeriodId;
        } catch {
          week = null;
        }
        const entry = await journal.append({ season: league.season, week, kind, text });
        return ok({ saved: entry, persistent: journal.persistent, storage: journal.storageDescription });
      }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function renderPlan(snap: Snapshot, plan: LineupPlan) {
  return {
    week: snap.scoringPeriodId,
    unchanged: plan.unchanged,
    projected_total_current: plan.currentProjectedTotal,
    projected_total_recommended: plan.projectedTotal,
    starters: plan.starters.map((s) => ({ slot: s.slotName, player: s.name, player_id: s.playerId, pos: s.position, proj: s.projected, effective: s.effective, locked: s.locked, note: s.note })),
    bench: plan.bench.map((b) => ({ player: b.name, player_id: b.playerId, pos: b.position, proj: b.projected, locked: b.locked, note: b.note })),
    ir: plan.ir,
    moves: plan.moves.map((m) => ({ player_id: m.playerId, player: snap.myTeam.roster.find((p) => p.id === m.playerId)?.name, from: slotName(m.fromSlot), to: slotName(m.toSlot) })),
    moves_for_set_lineup: plan.moves.map((m) => ({ player_id: m.playerId, to_slot: slotName(m.toSlot) })),
    warnings: plan.warnings,
  };
}

function matchupPeriodForWeek(snap: Snapshot, week: number): number {
  for (const [period, weeks] of Object.entries(snap.settings.schedule.matchupPeriods)) {
    if (weeks.includes(week)) return Number(period);
  }
  return week;
}

async function preflightAcquisition(
  league: LeagueService,
  snap: Snapshot,
  addId: number,
  dropId: number | undefined,
  mode: "free_agent" | "waiver",
  bid?: number,
): Promise<{ errors: string[]; warnings: string[]; summary: string }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const [target] = await league.getPlayers([addId]);
  if (!target) errors.push(`No player with id ${addId}.`);
  const drop = dropId !== undefined ? snap.myTeam.roster.find((p) => p.id === dropId) : undefined;
  if (dropId !== undefined && !drop) errors.push(`Player ${dropId} is not on my roster, so it cannot be dropped.`);
  if (drop?.locked) errors.push(`${drop.name} is locked (game started) and cannot be dropped this week.`);
  if (drop && !drop.droppable) errors.push(`${drop.name} is on ESPN's undroppable list.`);

  if (target) {
    if (target.availability === "ONTEAM") errors.push(`${target.name} is already owned by ${target.onTeamName ?? "another team"}.`);
    if (mode === "free_agent" && target.availability === "WAIVERS") errors.push(`${target.name} is on waivers; use claim_waiver_player instead.`);
    if (mode === "waiver" && target.availability === "FREEAGENT" && snap.settings.waivers.type !== "WAIVERS_CONTINUOUS") {
      warnings.push(`${target.name} is a free agent; add_free_agent would add them instantly instead of waiting for waivers.`);
    }
    const limit = snap.settings.positionLimits[target.position];
    if (limit) {
      const have = snap.myTeam.roster.filter((p) => p.position === target.position && p.id !== dropId).length;
      if (have + 1 > limit) errors.push(`Roster already has ${have} ${target.position}s; the league limit is ${limit}. Drop a ${target.position} in the same move.`);
    }
  }
  const cap = league.rosterCapacity(snap);
  if (!drop && cap.openSpots <= 0) errors.push(`Roster is full (${cap.activeCount}/${cap.rosterLimit}); include drop_player_id.`);

  if (mode === "waiver" && snap.settings.waivers.usesFaab) {
    const remaining = snap.myTeam.faabRemaining ?? 0;
    if (bid === undefined) errors.push(`This league uses FAAB; bid_amount is required (remaining budget $${remaining}).`);
    else if (bid > remaining) errors.push(`Bid $${bid} exceeds remaining FAAB $${remaining}.`);
    else if (snap.settings.waivers.minimumBid !== null && bid < snap.settings.waivers.minimumBid) errors.push(`Bid must be at least $${snap.settings.waivers.minimumBid}.`);
  }
  const limitSeason = snap.settings.waivers.acquisitionLimitPerSeason;
  if (limitSeason && (snap.myTeam.acquisitions ?? 0) >= limitSeason) errors.push(`Season acquisition limit reached (${limitSeason}).`);

  const summary = `${mode === "waiver" ? `Waiver claim${bid !== undefined ? ` ($${bid})` : ""}` : "Add"} ${target?.name ?? addId}${drop ? `, drop ${drop.name}` : ""}`;
  return { errors, warnings, summary };
}

export { resolveSlot };
