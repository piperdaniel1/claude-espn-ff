/**
 * Lineup optimiser: assigns roster players to starting slots to maximise
 * projected points while respecting slot eligibility, locked players, byes
 * and injury designations. Solved exactly with the Hungarian algorithm
 * (rosters are tiny, so this is instant).
 */

import { RISKY_STATUSES, SLOT_BENCH, SLOT_IR, UNAVAILABLE_STATUSES, slotName } from "./constants.ts";
import type { LineupMove } from "./transactions.ts";

export interface LineupCandidate {
  playerId: number;
  name: string;
  position: string;
  eligibleSlots: number[];
  currentSlot: number;
  /** Projected fantasy points for the week (0 if unknown). */
  projected: number;
  injuryStatus: string;
  onBye: boolean;
  /** True when ESPN will refuse to move this player (game started / roster locked). */
  locked: boolean;
}

export interface PlannedStarter {
  slot: number;
  slotName: string;
  playerId: number | null;
  name: string | null;
  position: string | null;
  projected: number;
  /** Projection after injury/bye adjustments; what the optimiser maximised. */
  effective: number;
  locked: boolean;
  note?: string;
}

export interface LineupPlan {
  starters: PlannedStarter[];
  bench: { playerId: number; name: string; position: string; projected: number; locked: boolean; note?: string }[];
  ir: { playerId: number; name: string; position: string; injuryStatus: string }[];
  moves: LineupMove[];
  projectedTotal: number;
  currentProjectedTotal: number;
  warnings: string[];
  unchanged: boolean;
}

const INELIGIBLE = -1;

/** Projection after accounting for availability. */
export function effectiveProjection(p: Pick<LineupCandidate, "projected" | "injuryStatus" | "onBye">): number {
  if (p.onBye) return 0;
  if (UNAVAILABLE_STATUSES.has(p.injuryStatus)) return 0;
  const base = Math.max(0, p.projected || 0);
  if (RISKY_STATUSES.has(p.injuryStatus)) return base * 0.25;
  return base;
}

function availabilityNote(p: Pick<LineupCandidate, "injuryStatus" | "onBye">): string | undefined {
  if (p.onBye) return "on bye";
  if (UNAVAILABLE_STATUSES.has(p.injuryStatus)) return p.injuryStatus.toLowerCase().replace("_", " ");
  if (RISKY_STATUSES.has(p.injuryStatus)) return "doubtful";
  if (p.injuryStatus === "QUESTIONABLE") return "questionable";
  return undefined;
}

/**
 * Hungarian algorithm (min-cost assignment) for an n x m cost matrix, n <= m.
 * Returns, for each row, the assigned column.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (n === 0) return [];
  if (n > m) throw new Error("hungarian(): rows must not exceed columns");
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0) assignment[p[j]! - 1] = j - 1;
  return assignment;
}

/**
 * Compute the optimal lineup.
 * @param players every rostered player (starters, bench and IR)
 * @param startingSlotCounts lineupSlotCounts from league settings; bench/IR entries are ignored
 */
export function planLineup(players: LineupCandidate[], startingSlotCounts: Record<number, number>): LineupPlan {
  const warnings: string[] = [];
  const byId = new Map(players.map((p) => [p.playerId, p]));

  // Expand starting slots into individual instances.
  const instances: { slot: number }[] = [];
  for (const [slotStr, count] of Object.entries(startingSlotCounts)) {
    const slot = Number(slotStr);
    if (slot === SLOT_BENCH || slot === SLOT_IR || count <= 0) continue;
    for (let i = 0; i < count; i++) instances.push({ slot });
  }
  instances.sort((a, b) => a.slot - b.slot);

  const ir = players.filter((p) => p.currentSlot === SLOT_IR);
  const movable: LineupCandidate[] = [];
  const fixedStarters: { slot: number; player: LineupCandidate }[] = [];
  const fixedBench: LineupCandidate[] = [];

  for (const p of players) {
    if (p.currentSlot === SLOT_IR) continue;
    if (p.locked) {
      if (p.currentSlot === SLOT_BENCH) fixedBench.push(p);
      else fixedStarters.push({ slot: p.currentSlot, player: p });
    } else {
      movable.push(p);
    }
  }

  // Locked starters consume a slot instance each.
  const remaining = [...instances];
  for (const f of fixedStarters) {
    const idx = remaining.findIndex((r) => r.slot === f.slot);
    if (idx >= 0) remaining.splice(idx, 1);
    else warnings.push(`${f.player.name} is locked in slot ${slotName(f.slot)} but the league has no such starting slot available.`);
  }

  // Build the cost matrix: rows = remaining slot instances, columns = movable players (+ dummies).
  const columns: (LineupCandidate | null)[] = [...movable];
  while (columns.length < remaining.length) columns.push(null);
  const BIG = 1e6;
  const scale = 1000; // keep integer-ish costs; projections have <= 2 decimals
  const cost: number[][] = remaining.map((inst) =>
    columns.map((col) => {
      if (col === null) return BIG / 2; // empty slot: worse than any real player but better than ineligible
      if (!col.eligibleSlots.includes(inst.slot)) return BIG;
      const w = effectiveProjection(col) + (col.currentSlot === inst.slot ? 0.001 : 0);
      return Math.round((1000 - w) * scale);
    }),
  );
  const assignment = remaining.length > 0 ? hungarian(cost) : [];

  const targetSlotByPlayer = new Map<number, number>();
  const starters: PlannedStarter[] = [];
  remaining.forEach((inst, row) => {
    const col = assignment[row] ?? -1;
    const player = col >= 0 ? columns[col] : null;
    if (player && player.eligibleSlots.includes(inst.slot)) {
      targetSlotByPlayer.set(player.playerId, inst.slot);
      starters.push({
        slot: inst.slot,
        slotName: slotName(inst.slot),
        playerId: player.playerId,
        name: player.name,
        position: player.position,
        projected: round1(player.projected),
        effective: round1(effectiveProjection(player)),
        locked: false,
        note: availabilityNote(player),
      });
    } else {
      starters.push({
        slot: inst.slot,
        slotName: slotName(inst.slot),
        playerId: null,
        name: null,
        position: null,
        projected: 0,
        effective: 0,
        locked: false,
        note: "empty - no eligible player",
      });
      warnings.push(`No eligible, movable player for the ${slotName(inst.slot)} slot; it will be empty.`);
    }
  });
  for (const f of fixedStarters) {
    targetSlotByPlayer.set(f.player.playerId, f.slot);
    const note = availabilityNote(f.player);
    starters.push({
      slot: f.slot,
      slotName: slotName(f.slot),
      playerId: f.player.playerId,
      name: f.player.name,
      position: f.player.position,
      projected: round1(f.player.projected),
      effective: round1(effectiveProjection(f.player)),
      locked: true,
      note: note ? `${note} (locked)` : "locked",
    });
    if (effectiveProjection(f.player) === 0) {
      warnings.push(`${f.player.name} is locked into ${slotName(f.slot)} but is ${note ?? "unavailable"}; nothing can be done this week.`);
    }
  }
  starters.sort((a, b) => a.slot - b.slot);

  const bench = [
    ...movable.filter((p) => !targetSlotByPlayer.has(p.playerId)).map((p) => ({ player: p, locked: false })),
    ...fixedBench.map((p) => ({ player: p, locked: true })),
  ].map(({ player, locked }) => ({
    playerId: player.playerId,
    name: player.name,
    position: player.position,
    projected: round1(player.projected),
    locked,
    note: availabilityNote(player),
  }));

  // Moves: any movable player whose target differs from the current slot.
  const moves: LineupMove[] = [];
  for (const p of movable) {
    const target = targetSlotByPlayer.get(p.playerId) ?? SLOT_BENCH;
    if (target !== p.currentSlot) moves.push({ playerId: p.playerId, fromSlot: p.currentSlot, toSlot: target });
  }

  for (const s of starters) {
    if (s.playerId !== null && s.effective === 0 && !s.locked) {
      warnings.push(`${s.name} is starting at ${s.slotName} while ${s.note ?? "unavailable"}; no healthy alternative is eligible. Consider a free agent.`);
    } else if (s.note === "doubtful" && !s.locked) {
      warnings.push(`${s.name} (${s.slotName}) is doubtful; check for a healthier option or late news.`);
    }
  }
  for (const b of bench) {
    if (b.locked && b.projected > 0) {
      const p = byId.get(b.playerId)!;
      const outscored = starters.find((s) => s.playerId !== null && p.eligibleSlots.includes(s.slot) && s.effective < effectiveProjection(p));
      if (outscored) warnings.push(`${b.name} is locked on the bench but projects higher than ${outscored.name} (${outscored.slotName}).`);
    }
  }

  const projectedTotal = round1(starters.reduce((sum, s) => sum + s.effective, 0));
  const currentProjectedTotal = round1(
    players
      .filter((p) => p.currentSlot !== SLOT_BENCH && p.currentSlot !== SLOT_IR)
      .reduce((sum, p) => sum + effectiveProjection(p), 0),
  );

  return {
    starters,
    bench,
    ir: ir.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, injuryStatus: p.injuryStatus })),
    moves,
    projectedTotal,
    currentProjectedTotal,
    warnings,
    unchanged: moves.length === 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
