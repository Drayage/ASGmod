import { describe, expect, it } from "vitest";
import { applyMove, createInitialState, getLegalMoves } from "./rules";
import { applyAction, evaluateState, getSafeActions } from "./ai";
import { influenceCount, influenceOwnerMap } from "./engine/territoryPlanner";
import { bestQuietAlternative } from "./ownership";
import { BOARD_SIZE } from "./types";
import type { GameState } from "./types";

const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** A handful of reproducible mid-game positions to measure against. */
function randomPosition(seed: number, plies: number): GameState {
  let value = seed >>> 0;
  const random = () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };

  let state = createInitialState();
  for (let ply = 0; ply < plies && !state.winner; ply++) {
    // Capture priority makes some open points illegal, so the move list has to
    // come from the rules rather than from whatever looks empty.
    const legal = getLegalMoves(state, state.currentPlayer);
    if (legal.length === 0) break;
    const { row, col } = legal[Math.floor(random() * legal.length)];
    state = applyMove(state, row, col);
  }
  return state;
}

describe("influenceOwnerMap", () => {
  it("sums to exactly what influenceCount reports", () => {
    // influenceCount is defined in terms of this map, so the two cannot drift.
    // The dataset's influence baseline reads the map, and would otherwise be
    // free to measure something the engine no longer uses.
    for (let seed = 1; seed <= 40; seed++) {
      const state = randomPosition(seed, 10 + (seed % 30));
      const counts = influenceCount(state.board);
      const owners = influenceOwnerMap(state.board);
      expect(owners).toHaveLength(CELL_COUNT);
      expect(owners.filter((owner) => owner === "A")).toHaveLength(counts.A);
      expect(owners.filter((owner) => owner === "B")).toHaveLength(counts.B);
    }
  });

  it("never claims an occupied point", () => {
    const state = randomPosition(7, 25);
    const owners = influenceOwnerMap(state.board);
    for (let index = 0; index < CELL_COUNT; index++) {
      const row = Math.floor(index / BOARD_SIZE);
      const col = index % BOARD_SIZE;
      if (state.board[row][col] !== "EMPTY") expect(owners[index]).toBeNull();
    }
  });
});

describe("bestQuietAlternative", () => {
  it("picks the best quiet move, not merely a quiet one", () => {
    // Guards the ranking. An earlier form sorted with
    //   (a, b) => b.score - a.score || a.action.type === "PASS" ? 1 : 0
    // which `||` binding tighter than `?:` collapses into a comparator
    // returning 1 whenever the scores differ in either direction — so cmp(a,b)
    // and cmp(b,a) both claimed "a goes after b" and nothing was ordered.
    const state = randomPosition(23, 16);
    const player = state.currentPlayer;
    const best = bestQuietAlternative(state, player);
    expect(best).not.toBeNull();

    const { pool } = getSafeActions(state, player);
    const quiet = pool.filter((action) => {
      const next = applyAction(state, action);
      return !(next.winner !== null && next.winReason === "CAPTURE");
    });
    const bestScore = Math.max(
      ...quiet.map((action) => evaluateState(applyAction(state, action), player)),
    );
    expect(evaluateState(applyAction(state, best!), player)).toBe(bestScore);
  });

  it("never offers a move that ends the game on a capture", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const state = randomPosition(seed * 7, 20);
      if (state.winner) continue;
      const best = bestQuietAlternative(state, state.currentPlayer);
      if (!best) continue;
      const next = applyAction(state, best);
      expect(next.winReason === "CAPTURE" && next.winner !== null).toBe(false);
    }
  });

  it("draws from the safety pool, so it cannot hand back a capture", () => {
    // The point of declining a capture is to reach a count. A candidate that
    // lets the opponent capture on the reply ends the rollout just the same.
    for (let seed = 1; seed <= 8; seed++) {
      const state = randomPosition(seed * 11, 18);
      if (state.winner) continue;
      const player = state.currentPlayer;
      const best = bestQuietAlternative(state, player);
      if (!best) continue;
      const { pool } = getSafeActions(state, player);
      expect(pool).toContainEqual(best);
    }
  });
});
