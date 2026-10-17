import { describe, expect, it } from "vitest";

import {
  buildAddDropTransaction,
  buildCancelTransaction,
  buildLineupTransaction,
  buildTradeProposalTransaction,
  buildTradeResponseTransaction,
  buildWaiverClaimTransaction,
  interpretWriteResponse,
  type TransactionPayload,
} from "../src/espn/transactions.ts";

const actor = { teamId: 3, memberId: "{SWID}", scoringPeriodId: 7 };

function assertNoNullish(payload: TransactionPayload) {
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) throw new Error(`nullish at ${path}`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as object)) walk(x, `${path}.${k}`);
  };
  walk(payload, "payload");
}

describe("transaction payload builders", () => {
  it("builds a lineup swap with both halves and bench moves first", () => {
    const p = buildLineupTransaction(
      actor,
      [
        { playerId: 110, fromSlot: 20, toSlot: 2 },
        { playerId: 103, fromSlot: 2, toSlot: 20 },
        { playerId: 999, fromSlot: 4, toSlot: 4 },
      ],
      7,
    );
    assertNoNullish(p);
    expect(p).toMatchObject({ isLeagueManager: false, isActingAsTeamOwner: false, teamId: 3, type: "ROSTER", memberId: "{SWID}", scoringPeriodId: 7, executionType: "EXECUTE" });
    expect(p.items).toEqual([
      { playerId: 103, type: "LINEUP", fromLineupSlotId: 2, toLineupSlotId: 20 },
      { playerId: 110, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 2 },
    ]);
    expect(Object.keys(p).sort()).toEqual(["executionType", "isActingAsTeamOwner", "isLeagueManager", "items", "memberId", "scoringPeriodId", "teamId", "type"]);
  });

  it("keeps slot 0 (QB) in lineup items and uses FUTURE_ROSTER for future weeks", () => {
    const p = buildLineupTransaction({ ...actor, scoringPeriodId: 9 }, [{ playerId: 115, fromSlot: 20, toSlot: 0 }], 7);
    expect(p.type).toBe("FUTURE_ROSTER");
    expect(p.items[0]).toEqual({ playerId: 115, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 0 });
  });

  it("refuses empty lineup transactions", () => {
    expect(() => buildLineupTransaction(actor, [{ playerId: 1, fromSlot: 20, toSlot: 20 }], 7)).toThrow(/no-op/);
  });

  it("builds FREEAGENT add+drop and ROSTER drop-only", () => {
    const add = buildAddDropTransaction(actor, { add: { playerId: 201 }, drop: { playerId: 116 } });
    assertNoNullish(add);
    expect(add.type).toBe("FREEAGENT");
    expect(add.items).toEqual([
      { playerId: 201, type: "ADD", toTeamId: 3 },
      { playerId: 116, type: "DROP", fromTeamId: 3 },
    ]);
    const drop = buildAddDropTransaction(actor, { drop: { playerId: 116 } });
    expect(drop.type).toBe("ROSTER");
    expect(drop.items).toEqual([{ playerId: 116, type: "DROP", fromTeamId: 3 }]);
    expect(() => buildAddDropTransaction(actor, {})).toThrow();
  });

  it("builds waiver claims with the bid in the envelope", () => {
    const p = buildWaiverClaimTransaction(actor, { add: { playerId: 202 }, drop: { playerId: 116 }, bidAmount: 12 });
    assertNoNullish(p);
    expect(p.type).toBe("WAIVER");
    expect(p.bidAmount).toBe(12);
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).not.toHaveProperty("bidAmount");
    const zero = buildWaiverClaimTransaction(actor, { add: { playerId: 202 }, bidAmount: 0 });
    expect(zero.bidAmount).toBe(0);
    const none = buildWaiverClaimTransaction(actor, { add: { playerId: 202 } });
    expect(none).not.toHaveProperty("bidAmount");
    expect(() => buildWaiverClaimTransaction(actor, { add: { playerId: 202 }, bidAmount: -1 })).toThrow();
    expect(() => buildWaiverClaimTransaction(actor, { add: { playerId: 202 }, bidAmount: 1.5 })).toThrow();
  });

  it("builds cancel, trade proposal and trade responses", () => {
    const cancel = buildCancelTransaction(actor, "WAIVER", "tx-1");
    assertNoNullish(cancel);
    expect(cancel).toMatchObject({ type: "WAIVER", executionType: "CANCEL", relatedTransactionId: "tx-1", items: [] });

    const trade = buildTradeProposalTransaction(actor, { toTeamId: 5, sendPlayerIds: [112], receivePlayerIds: [503], comment: "fair?", expirationDate: 1234 });
    assertNoNullish(trade);
    expect(trade.type).toBe("TRADE_PROPOSAL");
    expect(trade.items).toEqual([
      { playerId: 112, type: "TRADE", fromTeamId: 3, toTeamId: 5 },
      { playerId: 503, type: "TRADE", fromTeamId: 5, toTeamId: 3 },
    ]);
    expect(trade.comment).toBe("fair?");
    expect(trade.expirationDate).toBe(1234);
    expect(() => buildTradeProposalTransaction(actor, { toTeamId: 3, sendPlayerIds: [1], receivePlayerIds: [2] })).toThrow();
    expect(() => buildTradeProposalTransaction(actor, { toTeamId: 5, sendPlayerIds: [], receivePlayerIds: [2] })).toThrow();

    const accept = buildTradeResponseTransaction(actor, { relatedTransactionId: "tx-t", accept: true, dropPlayerIds: [116] });
    expect(accept.type).toBe("TRADE_ACCEPT");
    expect(accept.items).toEqual([{ playerId: 116, type: "DROP", fromTeamId: 3 }]);
    const decline = buildTradeResponseTransaction(actor, { relatedTransactionId: "tx-t", accept: false, dropPlayerIds: [116], comment: "" });
    expect(decline.type).toBe("TRADE_DECLINE");
    expect(decline.items).toEqual([]);
    expect(decline).not.toHaveProperty("comment");
  });
});

describe("interpretWriteResponse", () => {
  it("classifies ESPN responses", () => {
    expect(interpretWriteResponse({ id: "a", status: "EXECUTED" })).toMatchObject({ outcome: "applied", transactionId: "a" });
    expect(interpretWriteResponse({ id: "b", status: "PENDING" })).toMatchObject({ outcome: "pending" });
    expect(interpretWriteResponse({ transactions: [{ id: "c", isPending: true }] })).toMatchObject({ outcome: "pending", transactionId: "c" });
    expect(interpretWriteResponse({ id: "d", status: "FAILED_ROSTERLOCK" })).toMatchObject({ outcome: "rejected" });
    expect(interpretWriteResponse(null)).toMatchObject({ outcome: "unknown" });
    expect(interpretWriteResponse("weird")).toMatchObject({ outcome: "unknown" });
  });
});
