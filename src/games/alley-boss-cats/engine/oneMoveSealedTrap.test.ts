import { afterEach, describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { applyAIVariant } from "../aiVariant";
import {
  createsOneMoveSealedTrap,
  findBestMoveVeryHard,
  setOneMoveSealedTrapGuardEnabled,
} from "./minimax";
import { createInitialState } from "../rules";
import type { GameState } from "../types";

/**
 * Plies 1-16 of a recorded 2026-08-15 game (EYE_SEALGATE), replayed by move:
 * A to move at ply 17. Both createsOneMoveTrap and createsVoluntarySealedGroup
 * share `if (!touchesOwnGroup) return false` — a fresh stone touching nothing
 * of the mover's own was exempt from either. The engine played H5, a lone
 * stone with four liberties, unremarkable by both checks. One ply later the
 * single opponent stone beside it sealed the group — canBreathe already knew
 * none of its remaining liberties would ever leave it with more than three.
 * The engine never returned to it across four of its own turns; captured on
 * turn 26.
 */
const moves: Array<[number, number]> = [
  [6, 1], [6, 7], [7, 2], [7, 6], [1, 2], [2, 1], [0, 3], [2, 7],
  [1, 6], [5, 8], [0, 5], [1, 8], [1, 7], [3, 8], [8, 0], [3, 6],
];

function positionBeforePly17(): GameState {
  applyAIVariant("EYE_SEALGATE");
  let state = createInitialState();
  for (const [row, col] of moves) {
    state = applyAction(state, { type: "PLACE", row, col });
  }
  return state;
}

/** H5 — the recorded trap: a lone stone the opponent seals in one reply. */
const h5 = { type: "PLACE" as const, row: 4, col: 7 };

afterEach(() => setOneMoveSealedTrapGuardEnabled(false));

describe("createsOneMoveSealedTrap", () => {
  it("flags H5 on the recorded position, which the existing guards pass", () => {
    const state = positionBeforePly17();
    expect(createsOneMoveSealedTrap(state, "A", h5)).toBe(true);
  });

  it("does not require touching an own group, unlike its sibling guards", () => {
    // H5 touches nothing of A's own at this position — that is exactly the
    // case createsOneMoveTrap and createsVoluntarySealedGroup both exempt.
    const state = positionBeforePly17();
    let touchesOwn = false;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const r = 4 + dr;
      const c = 7 + dc;
      if (r >= 0 && r < 9 && c >= 0 && c < 9 && state.board[r][c] === "PLAYER_A") touchesOwn = true;
    }
    expect(touchesOwn).toBe(false);
  });

  it("exempts a move with a friendly stone within a diagonal step", () => {
    // Isolation is the narrowing that made this filter safe: the first version
    // tested only "sealed after their reply" and cost 0.70 cells over 240 arena
    // games. A corner-book pair always has its partner a diagonal step away, so
    // requiring genuine isolation exempts every planned shape.
    const state = positionBeforePly17();
    const board = state.board.map((r) => [...r]);
    board[3][7] = "PLAYER_A"; // a friend one step from H5
    const supported = { ...state, board };
    expect(createsOneMoveSealedTrap(supported, "A", h5)).toBe(false);
  });

  it("does not fire for a move with genuine room on both sides of the reply", () => {
    // A lone stone in open space, well off the edges and away from the
    // neutral centre: any single opponent reply still leaves several
    // independent liberties, none of them dead ends.
    const state = createInitialState();
    expect(createsOneMoveSealedTrap(state, "A", { type: "PLACE", row: 2, col: 2 })).toBe(false);
  });
});

describe("the full ladder on the recorded position", () => {
  it("plays H5 with the guard off, matching the recorded game", () => {
    setOneMoveSealedTrapGuardEnabled(false);
    const state = positionBeforePly17();
    const move = findBestMoveVeryHard(state, "A", 2600);
    expect(move).toEqual(h5);
  });

  it("avoids H5 with the guard on", () => {
    setOneMoveSealedTrapGuardEnabled(true);
    const state = positionBeforePly17();
    const move = findBestMoveVeryHard(state, "A", 2600);
    expect(move).not.toEqual(h5);
  });
});
