import { afterEach, describe, expect, it } from "vitest";
import { applyAction, evaluateComponents, setSealedLibertyThreshold, tuning } from "./ai";
import { createInitialState } from "./rules";
import type { GameState } from "./types";

/**
 * The gate `sealedWeight` is asked through, pinned on a real position rather
 * than a hand-built one: plies 1-32 of a recorded 2026-08-14 game, where a
 * two-stone engine group (C6, D6) sits at four liberties and cannot gain a
 * fifth — `canBreathe` says so, and the group was captured eight plies later
 * with the engine never returning to defend it. See
 * docs — the gate this pins is what let that group go unnoticed for as long
 * as it did: at the shipped threshold of 3, a four-liberty group is invisible
 * to `sealed` no matter the weight; raising the gate is what makes it visible.
 */
const moves: Array<[number, number]> = [
  [6, 7], [2, 7], [7, 6], [1, 6], [1, 2], [7, 2], [2, 1], [6, 1],
  [0, 3], [7, 4], [3, 0], [8, 5], [5, 8], [5, 0], [3, 5], [0, 5],
  [3, 8], [6, 3], [4, 7], [3, 3], [2, 8], [1, 8], [8, 6], [5, 5],
  [6, 5], [3, 2], [5, 6], [6, 4], [5, 2], [4, 1], [5, 3], [5, 4],
];

function positionAfterPly32(): GameState {
  let state = createInitialState();
  for (const [row, col] of moves) {
    state = applyAction(state, { type: "PLACE", row, col });
  }
  return state;
}

afterEach(() => {
  tuning.sealedWeight = 0;
  setSealedLibertyThreshold(3);
});

describe("the sealed liberty gate", () => {
  it("is invisible to a four-liberty sealed group at the shipped threshold", () => {
    const state = positionAfterPly32();
    tuning.sealedWeight = 150;
    setSealedLibertyThreshold(3);
    expect(evaluateComponents(state, "A").sealed).toBe(0);
  });

  it("sees the same group once the gate is widened to cover four liberties", () => {
    const state = positionAfterPly32();
    tuning.sealedWeight = 150;
    setSealedLibertyThreshold(4);
    // A is down one sealed group of its own, which the term prices as a cost
    // relative to B (0 - 1) * 150.
    expect(evaluateComponents(state, "A").sealed).toBeCloseTo(-150, 6);
  });

  it("costs nothing at zero weight regardless of the gate", () => {
    const state = positionAfterPly32();
    tuning.sealedWeight = 0;
    setSealedLibertyThreshold(6);
    expect(evaluateComponents(state, "A").sealed).toBe(0);
  });

  it("defaults to the shipped gate of 3", () => {
    const state = positionAfterPly32();
    tuning.sealedWeight = 150;
    expect(evaluateComponents(state, "A").sealed).toBe(0);
  });
});
