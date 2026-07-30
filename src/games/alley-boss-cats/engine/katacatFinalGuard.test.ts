import { describe, expect, it } from "vitest";
import { createInitialState } from "../rules";
import type { AIAction } from "../ai";
import type { KataCatPuctResult, KataCatVisitRecord } from "./katacatPuct";
import { verifyKataCatRootChoice } from "./katacatFinalGuard";

function place(index: number): AIAction {
  return { type: "PLACE", row: Math.floor(index / 9), col: index % 9 };
}

function record(index: number, visits: number, meanValue: number): KataCatVisitRecord {
  return {
    action: place(index),
    actionIndex: index,
    visits,
    prior: 0.1,
    meanValue,
  };
}

function searchResult(records: KataCatVisitRecord[]): KataCatPuctResult {
  return {
    action: records[0].action,
    reason: "SEARCH",
    simulations: records.reduce((sum, item) => sum + item.visits, 0),
    visitDistribution: records,
    tactical: {
      enabled: true,
      forcedCaptureFound: false,
      screenedActions: 3,
      refutedActions: 0,
      rootPoolBefore: 3,
      rootPoolAfter: 3,
      allRefutedFallback: false,
    },
  };
}

describe("KataCat final root guard", () => {
  it("rejects the PUCT leader when the focused reader proves a loss", () => {
    const result = searchResult([record(0, 12, 0.4), record(1, 8, 0.3), record(2, 4, 0.2)]);
    const checked: number[] = [];
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      { finalVerificationLimit: 3, finalVerificationMs: 75, finalVerificationDepth: 7 },
      (_state, _player, action) => {
        const index = action.type === "PASS" ? 81 : action.row * 9 + action.col;
        checked.push(index);
        return index === 0;
      },
    );

    expect(checked).toEqual([0, 1]);
    expect(verified.action).toEqual(place(1));
    expect(verified.report.checks).toBe(2);
    expect(verified.report.refutations).toBe(1);
    expect(verified.report.selectedActionRejected).toBe(true);
    expect(verified.report.chosenRank).toBe(2);
    expect(verified.report.fallbackToUnverified).toBe(false);
  });

  it("uses the next unverified visit-ranked move instead of a proven losing move", () => {
    const result = searchResult([record(0, 12, 0.4), record(1, 8, 0.3), record(2, 4, 0.2)]);
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      { finalVerificationLimit: 2 },
      () => true,
    );

    expect(verified.action).toEqual(place(2));
    expect(verified.report.checks).toBe(2);
    expect(verified.report.refutations).toBe(2);
    expect(verified.report.selectedActionRejected).toBe(true);
    expect(verified.report.fallbackToUnverified).toBe(true);
    expect(verified.report.chosenRank).toBe(3);
  });

  it("does not second-guess an immediate or forced capture", () => {
    const action = place(5);
    const result: KataCatPuctResult = {
      action,
      reason: "FORCED_CAPTURE",
      simulations: 0,
      visitDistribution: [record(5, 1, 1)],
      tactical: {
        enabled: true,
        forcedCaptureFound: true,
        screenedActions: 0,
        refutedActions: 0,
        rootPoolBefore: 10,
        rootPoolAfter: 10,
        allRefutedFallback: false,
      },
    };
    let calls = 0;
    const verified = verifyKataCatRootChoice(createInitialState(), result, {}, () => {
      calls += 1;
      return true;
    });

    expect(calls).toBe(0);
    expect(verified.action).toEqual(action);
    expect(verified.report.checks).toBe(0);
  });
});
