import { afterEach, describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import {
  createsVoluntarySealedGroup,
  findBestMoveVeryHard,
  lastDecision,
  pocketSealDanger,
  setPocketSealDangerGuardEnabled,
  setSelfInflictedSealedGuardEnabled,
} from "./minimax";
import { createInitialState } from "../rules";
import type { GameState } from "../types";

/**
 * Plies 1-30 of the recorded 2026-08-14 game §79 traced, replayed by move
 * rather than hand-built: A to move at ply 31. The engine's own two existing
 * guards (createsVoluntaryThinGroup, createsOneMoveTrap) both pass D6 — after
 * the move the pair sits at five liberties, clear of every count-based
 * threshold either checks. `canBreathe` already knew otherwise: none of those
 * five liberties, filled, would ever have left the group with more than five.
 * Nine plies and six of the opponent's moves later, uncontested, it was
 * captured.
 */
const moves: Array<[number, number]> = [
  [6, 7], [2, 7], [7, 6], [1, 6], [1, 2], [7, 2], [2, 1], [6, 1],
  [0, 3], [7, 4], [3, 0], [8, 5], [5, 8], [5, 0], [3, 5], [0, 5],
  [3, 8], [6, 3], [4, 7], [3, 3], [2, 8], [1, 8], [8, 6], [5, 5],
  [6, 5], [3, 2], [5, 6], [6, 4], [5, 2], [4, 1],
];

function positionBeforePly31(): GameState {
  let state = createInitialState();
  for (const [row, col] of moves) {
    state = applyAction(state, { type: "PLACE", row, col });
  }
  return state;
}

/** D6 — the recorded trap. */
const d6 = { type: "PLACE" as const, row: 5, col: 3 };

afterEach(() => {
  setSelfInflictedSealedGuardEnabled(false);
  setPocketSealDangerGuardEnabled(true);
});

describe("createsVoluntarySealedGroup", () => {
  it("flags D6 on the recorded position, which count-based guards pass", () => {
    const state = positionBeforePly31();
    expect(createsVoluntarySealedGroup(state, "A", d6)).toBe(true);
  });

  it("does not fire for a move that touches nothing of the mover's own", () => {
    const state = positionBeforePly31();
    // A far corner, empty and unrelated.
    expect(createsVoluntarySealedGroup(state, "A", { type: "PLACE", row: 8, col: 8 })).toBe(false);
  });

  it("does not blame a move for playing inside an already-sealed group", () => {
    // Wall C6 in completely on three sides first, so it is already sealed at
    // one liberty before the move in question, then ask about the last one —
    // salvaging a doomed shape is not what this guard is for.
    let state = createInitialState();
    // Built directly rather than via legal placement, since walling a group to
    // one liberty through normal play would trigger other guards first.
    const board = state.board.map((r) => [...r]);
    board[5][2] = "PLAYER_A";
    board[4][2] = "PLAYER_B";
    board[6][2] = "PLAYER_B";
    board[5][1] = "PLAYER_B";
    state = { ...state, board, currentPlayer: "A" };
    // The lone liberty at (5,3) — playing it extends into a fully enclosed
    // pocket, but the group was already sealed before this move.
    expect(createsVoluntarySealedGroup(state, "A", { type: "PLACE", row: 5, col: 3 })).toBe(false);
  });
});

describe("pocketSealDanger with the sealed guard", () => {
  it("offers D6 when the guard is off", () => {
    setSelfInflictedSealedGuardEnabled(false);
    const state = positionBeforePly31();
    const candidates = pocketSealDanger(state, "A");
    expect(candidates).toContainEqual(d6);
  });

  it("drops D6 from both the liberty-gaining and denial branches when the guard is on", () => {
    setSelfInflictedSealedGuardEnabled(true);
    const state = positionBeforePly31();
    const candidates = pocketSealDanger(state, "A");
    expect(candidates).not.toContainEqual(d6);
    // And it isn't left with nothing — the other liberties are still offered.
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("the full ladder on the recorded position", () => {
  it("plays D6 with the guard off, matching the recorded game", () => {
    setSelfInflictedSealedGuardEnabled(false);
    const state = positionBeforePly31();
    const move = findBestMoveVeryHard(state, "A", 2600);
    expect(move).toEqual(d6);
    expect(lastDecision.stage).toBe("1.85 pocket seal danger");
  });

  it("avoids D6 with the guard on", () => {
    setSelfInflictedSealedGuardEnabled(true);
    const state = positionBeforePly31();
    const move = findBestMoveVeryHard(state, "A", 2600);
    expect(move).not.toEqual(d6);
  });
});
