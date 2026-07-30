import { describe, expect, it } from "vitest";
import { createInitialState } from "../rules";
import type { AIAction } from "../ai";
import type { KataCatPuctResult, KataCatVisitRecord } from "./katacatPuct";
import { verifyKataCatRootChoice } from "./katacatFinalGuard";

function place(index: number): AIAction {
  return { type: "PLACE", row: Math.floor(index / 9), col: index % 9 };
}

function actionIndex(action: AIAction): number {
  return action.type === "PASS" ? 81 : action.row * 9 + action.col;
}

function record(
  index: number,
  visits: number,
  meanValue: number,
  prior = 0.1,
): KataCatVisitRecord {
  return {
    action: place(index),
    actionIndex: index,
    visits,
    prior,
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
      screenedActions: records.length,
      refutedActions: 0,
      rootPoolBefore: records.length,
      rootPoolAfter: records.length,
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
        const index = actionIndex(action);
        checked.push(index);
        return index === 0;
      },
    );

    expect(checked).toEqual([0, 1]);
    expect(verified.action).toEqual(place(1));
    expect(verified.report.checks).toBe(2);
    expect(verified.report.refutations).toBe(1);
    expect(verified.report.selectedActionRejected).toBe(true);
    expect(verified.report.selectedActionWasRefuted).toBe(true);
    expect(verified.report.chosenRank).toBe(2);
    expect(verified.report.outcome).toBe("VERIFIED_SAFE");
    expect(verified.report.fallbackToUnverified).toBe(false);
  });

  it("uses the next unverified visited move instead of a proven losing move", () => {
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
    expect(verified.report.selectedActionWasRefuted).toBe(true);
    expect(verified.report.fallbackToUnverified).toBe(true);
    expect(verified.report.fallbackToZeroVisit).toBe(false);
    expect(verified.report.chosenRank).toBe(3);
    expect(verified.report.outcome).toBe("UNVERIFIED_VISITED");
  });

  it("keeps zero-visit legal roots as fallbacks after all visited candidates are refuted", () => {
    const result = searchResult([
      record(0, 12, 0.4),
      record(1, 8, 0.3),
      record(2, 0, 0, 0.3),
      record(3, 0, 0, 0.2),
    ]);
    const checked: number[] = [];
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      { finalVerificationLimit: 2 },
      (_state, _player, action) => {
        checked.push(actionIndex(action));
        return true;
      },
    );

    expect(checked).toEqual([0, 1]);
    expect(verified.action).toEqual(place(2));
    expect(verified.report.chosenVisits).toBe(0);
    expect(verified.report.fallbackToUnverified).toBe(true);
    expect(verified.report.fallbackToZeroVisit).toBe(true);
    expect(verified.report.allCheckedRefuted).toBe(true);
    expect(verified.report.allRootActionsRefuted).toBe(false);
    expect(verified.report.provenLosingFallback).toBe(false);
    expect(verified.report.outcome).toBe("UNVERIFIED_ZERO_VISIT");
  });

  it("reports an unavoidable forced-loss fallback only after every root action is refuted", () => {
    const result = searchResult([record(0, 12, 0.4), record(1, 8, 0.3), record(2, 0, 0)]);
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      { finalVerificationLimit: 3 },
      () => true,
    );

    expect(verified.action).toEqual(place(0));
    expect(verified.report.checks).toBe(3);
    expect(verified.report.refutations).toBe(3);
    expect(verified.report.allRootActionsRefuted).toBe(true);
    expect(verified.report.provenLosingFallback).toBe(true);
    expect(verified.report.uncheckedActionsRemaining).toBe(0);
    expect(verified.report.outcome).toBe("ALL_ROOT_ACTIONS_REFUTED");
  });

  it("verifies and selects a CURRENT-style rescue suggestion after primary candidates fail", () => {
    const result = searchResult([
      record(0, 12, 0.4),
      record(1, 8, 0.3),
      record(2, 4, 0.2),
      record(3, 2, 0.1),
    ]);
    const checked: number[] = [];
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      {
        finalVerificationLimit: 2,
        rescueVerificationLimit: 3,
        rescueVerificationMs: 50,
        rescueTotalMs: 1000,
      },
      (_state, _player, action) => {
        const index = actionIndex(action);
        checked.push(index);
        return index === 0 || index === 1;
      },
      () => place(3),
    );

    expect(checked).toEqual([0, 1, 3]);
    expect(verified.action).toEqual(place(3));
    expect(verified.report.outcome).toBe("VERIFIED_RESCUE");
    expect(verified.report.rescueRequested).toBe(true);
    expect(verified.report.rescueCandidateInRoot).toBe(true);
    expect(verified.report.rescueCandidateChecked).toBe(true);
    expect(verified.report.rescueCandidateSelected).toBe(true);
    expect(verified.report.adaptiveChecks).toBe(0);
  });

  it("continues through the adaptive tail when the rescue suggestion is also refuted", () => {
    const result = searchResult([
      record(0, 12, 0.4),
      record(1, 8, 0.3),
      record(2, 4, 0.2),
      record(3, 2, 0.1),
    ]);
    const checked: number[] = [];
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      {
        finalVerificationLimit: 2,
        rescueVerificationLimit: 3,
        rescueVerificationMs: 50,
        rescueTotalMs: 1000,
      },
      (_state, _player, action) => {
        const index = actionIndex(action);
        checked.push(index);
        return index !== 3;
      },
      () => place(2),
    );

    expect(checked).toEqual([0, 1, 2, 3]);
    expect(verified.action).toEqual(place(3));
    expect(verified.report.outcome).toBe("VERIFIED_ADAPTIVE");
    expect(verified.report.rescueCandidateRefuted).toBe(true);
    expect(verified.report.adaptiveChecks).toBe(1);
    expect(verified.report.adaptiveRefutations).toBe(0);
  });

  it("ignores a rescue suggestion outside the screened root and scans legal root edges", () => {
    const result = searchResult([
      record(0, 12, 0.4),
      record(1, 8, 0.3),
      record(2, 4, 0.2),
    ]);
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      {
        finalVerificationLimit: 2,
        rescueVerificationLimit: 2,
        rescueVerificationMs: 50,
        rescueTotalMs: 1000,
      },
      (_state, _player, action) => actionIndex(action) !== 2,
      () => place(80),
    );

    expect(verified.action).toEqual(place(2));
    expect(verified.report.outcome).toBe("VERIFIED_ADAPTIVE");
    expect(verified.report.rescueSuggested).toBe(true);
    expect(verified.report.rescueCandidateInRoot).toBe(false);
    expect(verified.report.adaptiveChecks).toBe(1);
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
    let readerCalls = 0;
    let rescueCalls = 0;
    const verified = verifyKataCatRootChoice(
      createInitialState(),
      result,
      {},
      () => {
        readerCalls += 1;
        return true;
      },
      () => {
        rescueCalls += 1;
        return place(6);
      },
    );

    expect(readerCalls).toBe(0);
    expect(rescueCalls).toBe(0);
    expect(verified.action).toEqual(action);
    expect(verified.report.checks).toBe(0);
    expect(verified.report.outcome).toBe("SKIPPED_TACTICAL");
  });
});
