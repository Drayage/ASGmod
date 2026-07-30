// @ts-nocheck -- Includes generated regression fixtures from offline Actions artifacts.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AIAction } from "../ai";
import type { GameState } from "../types";
import { verifyKataCatRootChoice } from "./katacatFinalGuard";
import { verifyKataCatRootChoiceM341 } from "./katacatM341Fallback";
import type { KataCatPuctResult } from "./katacatPuct";

const env = globalThis.process?.env ?? {};

function place(index: number): AIAction {
  return { type: "PLACE", row: Math.floor(index / 9), col: index % 9 };
}

function resultWithRoots(count = 20): KataCatPuctResult {
  const visits = Array.from({ length: count }, (_, index) => ({
    action: place(index),
    actionIndex: index,
    visits: Math.max(0, count - index),
    prior: (count - index) / count,
    meanValue: 1 - index / count,
  }));
  return {
    action: visits[0].action,
    reason: "SEARCH",
    simulations: visits.reduce((sum, row) => sum + row.visits, 0),
    visitDistribution: visits,
    tactical: {
      enabled: true,
      forcedCaptureFound: false,
      screenedActions: 0,
      refutedActions: 0,
      rootPoolBefore: count,
      rootPoolAfter: count,
      allRefutedFallback: false,
    },
  };
}

const state = { currentPlayer: "A" } as GameState;
const guardOptions = {
  finalVerificationLimit: 5,
  finalVerificationMs: 1,
  finalVerificationDepth: 7,
  rescueVerificationLimit: 8,
  rescueVerificationMs: 1,
  rescueTotalMs: 1_000,
};

describe("KataCat M3.4.1 improved fallback", () => {
  it("checks the old blind rank-14 move before selecting it", () => {
    const result = resultWithRoots(20);
    const reader = (_state, _player, action) => {
      const index = action.row * 9 + action.col;
      return index < 13;
    };
    const old = verifyKataCatRootChoice(state, result, guardOptions, reader);
    expect(old.report.fallbackToUnverified).toBe(true);
    expect(old.report.chosenRank).toBe(14);

    const improved = verifyKataCatRootChoiceM341(
      state,
      result,
      guardOptions,
      { verificationDepth: 7, verificationMs: 1, verificationLimit: 82 },
      reader,
    );
    expect(improved.report.outcome).toBe("VERIFIED_EXHAUSTIVE_FALLBACK");
    expect(improved.report.chosenRank).toBe(14);
    expect(improved.report.fallbackToUnverified).toBe(false);
    expect(improved.report.preventedUnverifiedFallback).toBe(true);
  });

  it("reports an unavoidable loss only after every root was checked and refuted", () => {
    const result = resultWithRoots(16);
    const improved = verifyKataCatRootChoiceM341(
      state,
      result,
      guardOptions,
      { verificationDepth: 7, verificationMs: 1, verificationLimit: 82 },
      () => true,
    );
    expect(improved.report.outcome).toBe("ALL_ROOT_ACTIONS_REFUTED");
    expect(improved.report.uncheckedActionsRemaining).toBe(0);
    expect(improved.report.provenLosingFallback).toBe(true);
  });

  it("replays generated real loss positions without choosing an unchecked root", () => {
    const fixturePath = env.KATACAT_M341_REGRESSION_FIXTURE;
    if (!fixturePath) return;
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(fixture.cases.length).toBeGreaterThan(0);
    const failures = [];
    for (const testCase of fixture.cases) {
      const refuted = new Set(testCase.refutedActionIndices);
      const safe = new Set(testCase.readerSafeActionIndices);
      const reader = (_state, _player, action) => refuted.has(
        action.type === "PASS" ? 81 : action.row * 9 + action.col,
      );
      const replayState = { currentPlayer: testCase.currentPlayer } as GameState;
      const improved = verifyKataCatRootChoiceM341(
        replayState,
        testCase.puctResult,
        testCase.guardOptions,
        testCase.improvedOptions,
        reader,
      );
      const selectedIndex = improved.action.type === "PASS"
        ? 81
        : improved.action.row * 9 + improved.action.col;
      const passed = !improved.report.fallbackToUnverified
        && improved.report.outcome === "VERIFIED_EXHAUSTIVE_FALLBACK"
        && safe.has(selectedIndex);
      if (!passed) failures.push({ id: testCase.id, selectedIndex, report: improved.report });
    }
    const summary = {
      schemaVersion: 1,
      stage: "M3.4.1_FALLBACK_REGRESSION",
      cases: fixture.cases.length,
      failures: failures.length,
      failureDetails: failures,
      passed: failures.length === 0,
    };
    if (env.KATACAT_M341_REGRESSION_OUTPUT) {
      writeFileSync(env.KATACAT_M341_REGRESSION_OUTPUT, JSON.stringify(summary, null, 2) + "\n");
    }
    expect(failures).toEqual([]);
  });
});
