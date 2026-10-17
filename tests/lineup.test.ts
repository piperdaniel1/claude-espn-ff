import { describe, expect, it } from "vitest";

import { effectiveProjection, hungarian, planLineup, type LineupCandidate } from "../src/espn/lineup.ts";

const SLOTS = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 23: 1 };
const QB = [0, 20, 21];
const RB = [2, 3, 20, 21, 23];
const WR = [3, 4, 5, 20, 21, 23];
const TE = [5, 6, 20, 21, 23];
const K = [17, 20, 21];
const DST = [16, 20, 21];

function p(id: number, name: string, position: string, eligible: number[], currentSlot: number, projected: number, extra: Partial<LineupCandidate> = {}): LineupCandidate {
  return { playerId: id, name, position, eligibleSlots: eligible, currentSlot, projected, injuryStatus: "ACTIVE", onBye: false, locked: false, ...extra };
}

function roster(): LineupCandidate[] {
  return [
    p(101, "Alpha QB", "QB", QB, 0, 19.5),
    p(102, "Bravo RB", "RB", RB, 2, 14.2),
    p(103, "Charlie RB", "RB", RB, 2, 11.0, { injuryStatus: "OUT" }),
    p(104, "Delta WR", "WR", WR, 4, 13.1),
    p(105, "Echo WR", "WR", WR, 4, 0, { onBye: true }),
    p(106, "Foxtrot TE", "TE", TE, 6, 8.7),
    p(107, "Golf WR", "WR", WR, 23, 9.9),
    p(108, "Hotel DST", "D/ST", DST, 16, 7.0),
    p(109, "India K", "K", K, 17, 8.0),
    p(110, "Juliet RB", "RB", RB, 20, 12.8),
    p(111, "Kilo WR", "WR", WR, 20, 10.5),
    p(112, "Lima WR", "WR", WR, 20, 7.1),
    p(113, "Mike RB", "RB", RB, 20, 6.5, { injuryStatus: "QUESTIONABLE" }),
    p(114, "November TE", "TE", TE, 20, 5.0),
    p(115, "Oscar QB", "QB", QB, 20, 15.0),
    p(116, "Papa RB", "RB", RB, 20, 3.0),
    p(117, "Quebec WR", "WR", WR, 21, 0, { injuryStatus: "INJURY_RESERVE" }),
  ];
}

describe("hungarian", () => {
  it("finds the minimum cost assignment", () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const a = hungarian(cost);
    const total = a.reduce((s, col, row) => s + cost[row]![col]!, 0);
    expect(total).toBe(5); // 1 + 2 + 2
    expect(new Set(a).size).toBe(3);
  });

  it("handles rectangular matrices (fewer rows than columns)", () => {
    const a = hungarian([
      [10, 1, 10, 10],
      [10, 10, 10, 1],
    ]);
    expect(a).toEqual([1, 3]);
  });
});

describe("effectiveProjection", () => {
  it("zeroes unavailable players and discounts doubtful ones", () => {
    expect(effectiveProjection({ projected: 12, injuryStatus: "OUT", onBye: false })).toBe(0);
    expect(effectiveProjection({ projected: 12, injuryStatus: "ACTIVE", onBye: true })).toBe(0);
    expect(effectiveProjection({ projected: 12, injuryStatus: "DOUBTFUL", onBye: false })).toBe(3);
    expect(effectiveProjection({ projected: 12, injuryStatus: "QUESTIONABLE", onBye: false })).toBe(12);
    expect(effectiveProjection({ projected: -3, injuryStatus: "ACTIVE", onBye: false })).toBe(0);
  });
});

describe("planLineup", () => {
  it("benches OUT and bye starters for the best eligible bench players", () => {
    const plan = planLineup(roster(), SLOTS);
    expect(plan.unchanged).toBe(false);
    const byPlayer = Object.fromEntries(plan.moves.map((m) => [m.playerId, m]));
    expect(byPlayer[103]).toMatchObject({ fromSlot: 2, toSlot: 20 });
    expect(byPlayer[110]).toMatchObject({ fromSlot: 20, toSlot: 2 });
    expect(byPlayer[105]).toMatchObject({ fromSlot: 4, toSlot: 20 });
    expect(byPlayer[111]).toMatchObject({ fromSlot: 20, toSlot: 4 });
    expect(plan.moves).toHaveLength(4);
    expect(plan.projectedTotal).toBe(103.7);
    expect(plan.currentProjectedTotal).toBe(80.4);
    // FLEX keeps Golf (tie with Kilo at WR, current-slot preference breaks it).
    const flex = plan.starters.find((s) => s.slot === 23)!;
    expect(flex.playerId).toBe(107);
    expect(plan.ir.map((x) => x.playerId)).toEqual([117]);
    expect(plan.starters).toHaveLength(9);
    expect(plan.starters.every((s) => s.playerId !== null)).toBe(true);
  });

  it("reports unchanged when the lineup is already optimal", () => {
    const players = roster().map((x) => {
      if (x.playerId === 103) return { ...x, currentSlot: 20 };
      if (x.playerId === 110) return { ...x, currentSlot: 2 };
      if (x.playerId === 105) return { ...x, currentSlot: 20 };
      if (x.playerId === 111) return { ...x, currentSlot: 4 };
      return x;
    });
    const plan = planLineup(players, SLOTS);
    expect(plan.unchanged).toBe(true);
    expect(plan.moves).toEqual([]);
  });

  it("never moves locked players and warns when they are stuck", () => {
    const players = roster().map((x) => (x.playerId === 103 ? { ...x, locked: true } : x.playerId === 110 ? { ...x, locked: true } : x));
    const plan = planLineup(players, SLOTS);
    expect(plan.moves.find((m) => m.playerId === 103)).toBeUndefined();
    expect(plan.moves.find((m) => m.playerId === 110)).toBeUndefined();
    const charlie = plan.starters.find((s) => s.playerId === 103)!;
    expect(charlie.locked).toBe(true);
    expect(plan.warnings.join("\n")).toMatch(/Charlie RB is locked/);
    expect(plan.warnings.join("\n")).toMatch(/Juliet RB is locked on the bench/);
    // Other RB slot still filled by the best movable RB (Bravo stays).
    expect(plan.starters.filter((s) => s.slot === 2).map((s) => s.playerId).sort()).toEqual([102, 103]);
  });

  it("leaves a slot empty (with a warning) when nobody eligible is available", () => {
    const players = roster().filter((x) => x.position !== "K");
    const plan = planLineup(players, SLOTS);
    const k = plan.starters.find((s) => s.slot === 17)!;
    expect(k.playerId).toBeNull();
    expect(plan.warnings.join("\n")).toMatch(/K slot/);
  });

  it("starts an unavailable player only when there is no alternative, with a warning", () => {
    const players = roster().filter((x) => ![114].includes(x.playerId)).map((x) => (x.playerId === 106 ? { ...x, injuryStatus: "OUT" } : x));
    const plan = planLineup(players, SLOTS);
    const te = plan.starters.find((s) => s.slot === 6)!;
    expect(te.playerId).toBe(106);
    expect(plan.warnings.join("\n")).toMatch(/Foxtrot TE is starting at TE while out/);
  });

  it("uses FLEX for the best remaining RB/WR/TE", () => {
    const players = roster().map((x) => (x.playerId === 113 ? { ...x, projected: 20, injuryStatus: "ACTIVE" } : x));
    const plan = planLineup(players, SLOTS);
    const starters = new Set(plan.starters.map((s) => s.playerId));
    expect(starters.has(113)).toBe(true);
    expect(starters.has(110)).toBe(true);
    expect(starters.has(102)).toBe(true);
  });
});
