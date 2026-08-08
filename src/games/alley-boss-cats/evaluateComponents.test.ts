import { describe, expect, it } from "vitest";
import { applyAction, evaluateComponents, evaluateState } from "./ai";
import { createInitialState, getLegalMoves } from "./rules";
import { opponent } from "./types";
import type { GameState, Player } from "./types";

/**
 * `evaluateComponents` restates `evaluateState`'s arithmetic so a move can be
 * explained term by term. Two copies of the same sum drift, so this pins them
 * together: over a spread of real positions, the itemised parts must add up to
 * the score the search actually uses.
 *
 * Positions come from a played-out game rather than hand-built boards, so the
 * short-circuit branches — a group in atari with the opponent to move, and its
 * mirror — get exercised alongside the ordinary sum.
 */
function playOut(plies: number): GameState[] {
  const seen: GameState[] = [];
  let state = createInitialState();
  // A fixed pseudo-random walk: same positions every run, no engine involved.
  let seed = 20260808;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let ply = 0; ply < plies; ply += 1) {
    seen.push(state);
    const moves = getLegalMoves(state, state.currentPlayer);
    if (moves.length === 0) break;
    const pick = moves[next() % moves.length];
    state = applyAction(state, { type: "PLACE", row: pick.row, col: pick.col });
    if (state.winner) break;
  }
  return seen;
}

describe("evaluateComponents", () => {
  it("adds up to evaluateState, from both sides, across a whole game", () => {
    const positions = playOut(70);
    expect(positions.length).toBeGreaterThan(20);

    for (const state of positions) {
      for (const player of ["A", "B"] as Player[]) {
        const parts = evaluateComponents(state, player);
        const summed = Object.values(parts).reduce((a, b) => a + b, 0);
        expect(summed).toBeCloseTo(evaluateState(state, player), 6);
      }
    }
  });

  it("names the short-circuit when one fires, rather than itemising past it", () => {
    // Walk until some position triggers the atari short-circuit for a side.
    const positions = playOut(70);
    const shortCircuited = positions.flatMap((state) =>
      (["A", "B"] as Player[])
        .map((p) => evaluateComponents(state, p))
        .filter((parts) => "myGroupIsLost" in parts || "theirGroupIsLost" in parts),
    );
    for (const parts of shortCircuited) {
      // A short-circuit is the whole score; nothing else may be reported.
      expect(Object.keys(parts)).toHaveLength(1);
    }
  });

  it("reports a decided game as the win itself", () => {
    let state = createInitialState();
    const player = state.currentPlayer;
    state = { ...state, winner: player, winReason: "CAPTURE" };
    expect(evaluateComponents(state, player)).toEqual({ winner: 1_000_000 });
    expect(evaluateComponents(state, opponent(player))).toEqual({ winner: -1_000_000 });
  });
});
