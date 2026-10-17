/** Lineup slot ids used by ESPN fantasy football. */
export const LINEUP_SLOTS: Record<number, string> = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "D/ST",
  17: "K",
  18: "P",
  19: "HC",
  20: "BE",
  21: "IR",
  22: "UNKNOWN",
  23: "FLEX",
  24: "EDR",
  25: "Rookie",
};

export const SLOT_BENCH = 20;
export const SLOT_IR = 21;

/** Slot name -> id (first match wins for aliases). */
export const SLOT_IDS: Record<string, number> = Object.fromEntries(
  Object.entries(LINEUP_SLOTS).map(([id, name]) => [name, Number(id)]),
);
SLOT_IDS["BENCH"] = SLOT_BENCH;
SLOT_IDS["DST"] = 16;
SLOT_IDS["D/ST"] = 16;
SLOT_IDS["DEF"] = 16;

/** defaultPositionId -> position label. */
export const POSITIONS: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  7: "P",
  9: "DT",
  10: "DE",
  11: "LB",
  12: "CB",
  13: "S",
  14: "HC",
  16: "D/ST",
};

/** Position label -> slot ids that position normally fills (for free-agent filters). */
export const POSITION_SLOT_FILTER: Record<string, number[]> = {
  QB: [0],
  RB: [2],
  WR: [4],
  TE: [6],
  K: [17],
  "D/ST": [16],
  DST: [16],
  FLEX: [23],
};

export const PRO_TEAMS: Record<number, string> = {
  0: "FA",
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WSH",
  29: "CAR",
  30: "JAX",
  33: "BAL",
  34: "HOU",
};

/** Injury statuses ESPN uses, roughly from healthy to unavailable. */
export const UNAVAILABLE_STATUSES = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL_OUT"]);
export const RISKY_STATUSES = new Set(["DOUBTFUL"]);

/** League activity feed message types (communication view). */
export const ACTIVITY_MESSAGE_TYPES: Record<number, string> = {
  178: "FA ADDED",
  179: "DROPPED",
  180: "WAIVER ADDED",
  181: "TRADED",
  239: "DROPPED",
  244: "TRADED",
};

export const TRANSACTION_TYPES = [
  "FREEAGENT",
  "WAIVER",
  "WAIVER_ERROR",
  "ROSTER",
  "FUTURE_ROSTER",
  "TRADE_PROPOSAL",
  "TRADE_ACCEPT",
  "TRADE_DECLINE",
  "TRADE_VETO",
  "TRADE_UPHOLD",
  "DRAFT",
  "RETRO_ROSTER",
] as const;

export const READ_HOST = "https://lm-api-reads.fantasy.espn.com";
export const WRITE_HOST = "https://lm-api-writes.fantasy.espn.com";

export function slotName(id: number): string {
  return LINEUP_SLOTS[id] ?? `SLOT_${id}`;
}

export function positionName(id: number | undefined): string {
  if (id === undefined) return "UNK";
  return POSITIONS[id] ?? `POS_${id}`;
}

export function proTeamAbbrev(id: number | undefined): string {
  if (id === undefined) return "FA";
  return PRO_TEAMS[id] ?? `TEAM_${id}`;
}

/** Resolve a slot given either a name ("WR", "FLEX", "BE") or a numeric id. */
export function resolveSlot(input: string | number): number | undefined {
  if (typeof input === "number") return LINEUP_SLOTS[input] !== undefined ? input : undefined;
  const key = input.trim().toUpperCase();
  if (/^\d+$/.test(key)) return resolveSlot(Number(key));
  if (key === "RB/WR/TE") return 23;
  return SLOT_IDS[key];
}
