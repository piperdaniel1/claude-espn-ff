/**
 * Pure builders for ESPN transaction payloads.
 *
 * ESPN deserialises strictly: unknown keys and null values produce a 400, so
 * every builder emits only the keys ESPN's own web client sends. The shapes
 * come from captured requests and community reverse engineering; the
 * ROSTER/FREEAGENT/WAIVER shapes have been seen succeeding against ESPN, the
 * trade shapes are best-effort (see docs/espn-api-notes.md).
 */

export type TransactionType =
  | "ROSTER"
  | "FUTURE_ROSTER"
  | "FREEAGENT"
  | "WAIVER"
  | "TRADE_PROPOSAL"
  | "TRADE_ACCEPT"
  | "TRADE_DECLINE";

export type ItemType = "LINEUP" | "ADD" | "DROP" | "TRADE";

export interface TransactionItem {
  playerId: number;
  type: ItemType;
  fromTeamId?: number;
  toTeamId?: number;
  fromLineupSlotId?: number;
  toLineupSlotId?: number;
}

export interface TransactionPayload {
  isLeagueManager: false;
  isActingAsTeamOwner: false;
  teamId: number;
  type: TransactionType;
  memberId: string;
  scoringPeriodId: number;
  executionType: "EXECUTE" | "CANCEL";
  items: TransactionItem[];
  bidAmount?: number;
  relatedTransactionId?: string;
  comment?: string;
  expirationDate?: number;
}

export interface Actor {
  teamId: number;
  /** SWID including braces. */
  memberId: string;
  scoringPeriodId: number;
}

export interface LineupMove {
  playerId: number;
  fromSlot: number;
  toSlot: number;
}

function item(fields: TransactionItem): TransactionItem {
  const out: TransactionItem = { playerId: fields.playerId, type: fields.type };
  if (fields.fromTeamId !== undefined) out.fromTeamId = fields.fromTeamId;
  if (fields.toTeamId !== undefined) out.toTeamId = fields.toTeamId;
  if (fields.fromLineupSlotId !== undefined) out.fromLineupSlotId = fields.fromLineupSlotId;
  if (fields.toLineupSlotId !== undefined) out.toLineupSlotId = fields.toLineupSlotId;
  return out;
}

function envelope(actor: Actor, type: TransactionType, items: TransactionItem[], extras: Partial<TransactionPayload> = {}): TransactionPayload {
  const payload: TransactionPayload = {
    isLeagueManager: false,
    isActingAsTeamOwner: false,
    teamId: actor.teamId,
    type,
    memberId: actor.memberId,
    scoringPeriodId: actor.scoringPeriodId,
    executionType: extras.executionType ?? "EXECUTE",
    items,
  };
  if (extras.bidAmount !== undefined) payload.bidAmount = extras.bidAmount;
  if (extras.relatedTransactionId !== undefined) payload.relatedTransactionId = extras.relatedTransactionId;
  if (extras.comment !== undefined && extras.comment !== "") payload.comment = extras.comment;
  if (extras.expirationDate !== undefined) payload.expirationDate = extras.expirationDate;
  return payload;
}

/**
 * Lineup changes for one scoring period. Both halves of a swap travel in one
 * transaction so ESPN never sees an over-full slot. Uses FUTURE_ROSTER when the
 * target week is beyond the league's latest scoring period.
 */
export function buildLineupTransaction(actor: Actor, moves: LineupMove[], latestScoringPeriod: number): TransactionPayload {
  const effective = moves.filter((m) => m.fromSlot !== m.toSlot);
  if (effective.length === 0) throw new Error("No lineup changes to submit (every move is a no-op).");
  const type: TransactionType = actor.scoringPeriodId > latestScoringPeriod ? "FUTURE_ROSTER" : "ROSTER";
  // Vacate slots before filling them: moves to the bench first, then the rest.
  const ordered = [...effective].sort((a, b) => Number(b.toSlot === 20) - Number(a.toSlot === 20));
  return envelope(
    actor,
    type,
    ordered.map((m) => item({ playerId: m.playerId, type: "LINEUP", fromLineupSlotId: m.fromSlot, toLineupSlotId: m.toSlot })),
  );
}

export interface AddDropSpec {
  add?: { playerId: number; toSlot?: number };
  drop?: { playerId: number };
}

/** Immediate free-agent add (optionally with a drop), or a standalone drop. */
export function buildAddDropTransaction(actor: Actor, spec: AddDropSpec): TransactionPayload {
  if (!spec.add && !spec.drop) throw new Error("Provide a player to add, drop, or both.");
  const items: TransactionItem[] = [];
  if (spec.add) {
    items.push(item({ playerId: spec.add.playerId, type: "ADD", toTeamId: actor.teamId, toLineupSlotId: spec.add.toSlot }));
  }
  if (spec.drop) {
    items.push(item({ playerId: spec.drop.playerId, type: "DROP", fromTeamId: actor.teamId }));
  }
  return envelope(actor, spec.add ? "FREEAGENT" : "ROSTER", items);
}

export interface WaiverClaimSpec extends AddDropSpec {
  add: { playerId: number; toSlot?: number };
  bidAmount?: number;
}

/** Waiver claim; `bidAmount` is only meaningful in FAAB leagues. */
export function buildWaiverClaimTransaction(actor: Actor, spec: WaiverClaimSpec): TransactionPayload {
  if (spec.bidAmount !== undefined && (!Number.isInteger(spec.bidAmount) || spec.bidAmount < 0)) {
    throw new Error("bidAmount must be a non-negative integer.");
  }
  const items: TransactionItem[] = [item({ playerId: spec.add.playerId, type: "ADD", toTeamId: actor.teamId, toLineupSlotId: spec.add.toSlot })];
  if (spec.drop) items.push(item({ playerId: spec.drop.playerId, type: "DROP", fromTeamId: actor.teamId }));
  return envelope(actor, "WAIVER", items, { bidAmount: spec.bidAmount });
}

/** Cancel a pending waiver claim or trade proposal that this team created. */
export function buildCancelTransaction(actor: Actor, type: "WAIVER" | "TRADE_PROPOSAL", relatedTransactionId: string): TransactionPayload {
  return envelope(actor, type, [], { executionType: "CANCEL", relatedTransactionId });
}

export interface TradeProposalSpec {
  toTeamId: number;
  /** Players leaving the actor's team. */
  sendPlayerIds: number[];
  /** Players arriving from the other team. */
  receivePlayerIds: number[];
  comment?: string;
  /** Epoch milliseconds when the proposal expires. */
  expirationDate?: number;
}

export function buildTradeProposalTransaction(actor: Actor, spec: TradeProposalSpec): TransactionPayload {
  if (spec.toTeamId === actor.teamId) throw new Error("Cannot trade with your own team.");
  if (spec.sendPlayerIds.length === 0 || spec.receivePlayerIds.length === 0) {
    throw new Error("A trade needs at least one player on each side.");
  }
  const items: TransactionItem[] = [
    ...spec.sendPlayerIds.map((id) => item({ playerId: id, type: "TRADE", fromTeamId: actor.teamId, toTeamId: spec.toTeamId })),
    ...spec.receivePlayerIds.map((id) => item({ playerId: id, type: "TRADE", fromTeamId: spec.toTeamId, toTeamId: actor.teamId })),
  ];
  return envelope(actor, "TRADE_PROPOSAL", items, { comment: spec.comment, expirationDate: spec.expirationDate });
}

export interface TradeResponseSpec {
  relatedTransactionId: string;
  accept: boolean;
  /** Players to drop to make roster room when accepting. */
  dropPlayerIds?: number[];
  comment?: string;
}

export function buildTradeResponseTransaction(actor: Actor, spec: TradeResponseSpec): TransactionPayload {
  const items: TransactionItem[] = (spec.accept ? spec.dropPlayerIds ?? [] : []).map((id) =>
    item({ playerId: id, type: "DROP", fromTeamId: actor.teamId }),
  );
  return envelope(actor, spec.accept ? "TRADE_ACCEPT" : "TRADE_DECLINE", items, {
    relatedTransactionId: spec.relatedTransactionId,
    comment: spec.comment,
  });
}

/** Summarise ESPN's response to a transaction POST. */
export interface WriteOutcome {
  outcome: "applied" | "pending" | "rejected" | "unknown";
  status?: string;
  transactionId?: string;
  messages: string[];
}

export function interpretWriteResponse(body: unknown): WriteOutcome {
  const messages: string[] = [];
  let status: string | undefined;
  let transactionId: string | undefined;
  let isPending: boolean | undefined;
  const candidates: unknown[] = [];
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.transactions)) candidates.push(...b.transactions);
    else candidates.push(b);
  } else if (Array.isArray(body)) {
    candidates.push(...body);
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const t = c as Record<string, unknown>;
    if (typeof t.status === "string" && !status) status = t.status;
    if (typeof t.id === "string" && !transactionId) transactionId = t.id;
    if (typeof t.isPending === "boolean" && isPending === undefined) isPending = t.isPending;
    if (Array.isArray(t.messages)) messages.push(...t.messages.filter((m): m is string => typeof m === "string"));
  }
  if (status === "EXECUTED") return { outcome: "applied", status, transactionId, messages };
  if (status === "PENDING" || status === "QUEUED" || isPending === true) return { outcome: "pending", status, transactionId, messages };
  if (status && /^FAILED|CANCEL|REJECT|VETO/.test(status)) return { outcome: "rejected", status, transactionId, messages };
  return { outcome: "unknown", status, transactionId, messages };
}
