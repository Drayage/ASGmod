import { describe, expect, it } from "vitest";
import { applyMove, createInitialState, getLegalMoves, passTurn } from "./rules";
import { applyAction, evaluateState, getSafeActions } from "./ai";
import { influenceCount, influenceOwnerMap } from "./engine/territoryPlanner";
import {
  CELL_COUNT,
  SYMMETRY_COUNT,
  bestQuietAlternative,
  completeToScoring,
  decodeOwnership,
  encodeBoard,
  encodeOwnership,
  mapCoord,
  ownershipAccuracy,
  ownershipClassScores,
  ownershipFromState,
  predictByInfluence,
  predictByNearestCat,
  predictNeutral,
  territoryMargin,
  transformBoard,
  transformOwnership,
} from "./ownership";
import { BOARD_SIZE } from "./types";
import type { GameState } from "./types";

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

describe("ownership labels", () => {
  it("marks confirmed territory and nothing else", () => {
    const state = randomPosition(3, 40);
    const owners = ownershipFromState(state);
    for (const side of ["A", "B"] as const) {
      for (const { row, col } of state.territories[side]) {
        expect(owners[row * BOARD_SIZE + col]).toBe(side);
      }
    }
    const claimed = owners.filter((owner) => owner !== null).length;
    expect(claimed).toBe(state.territories.A.length + state.territories.B.length);
  });

  it("reports the margin the win condition is written in", () => {
    const state = randomPosition(11, 40);
    expect(territoryMargin(state, "A")).toBe(
      state.territories.A.length - state.territories.B.length,
    );
    expect(territoryMargin(state, "B")).toBe(-territoryMargin(state, "A"));
  });
});

describe("completeToScoring", () => {
  it("reaches a counted finish rather than a capture", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const start = randomPosition(seed * 13, 12);
      const { state, cappedOut } = completeToScoring(start, 200);
      expect(cappedOut).toBe(false);
      expect(state.winner).not.toBeNull();
      expect(state.winReason).toBe("TERRITORY");
    }
  });

  it("plays on past a capture finish instead of taking the win as the label", () => {
    const captured: GameState = {
      ...randomPosition(5, 14),
      winner: "A",
      winReason: "CAPTURE",
      consecutivePasses: 0,
    };
    const { state: finished, addedPlies } = completeToScoring(captured, 200);
    expect(addedPlies).toBeGreaterThan(0);
    expect(finished.winReason).toBe("TERRITORY");
  });

  it("picks the best quiet move, not merely a quiet one", () => {
    // Guards the sort in bestQuietAlternative. An earlier form read
    //   (a, b) => b.score - a.score || a.action.type === "PASS" ? 1 : 0
    // which `||` binding tighter than `?:` collapses to a comparator returning
    // 1 whenever the scores differ in either direction — so cmp(a,b) and
    // cmp(b,a) both claimed "a goes after b" and nothing was ordered. It ran on
    // roughly one move in eight of a label rollout, choosing arbitrarily.
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

  it("leaves an already-counted game alone", () => {
    const passed = passTurn(passTurn(createInitialState()));
    expect(passed.winner).not.toBeNull();
    expect(passed.winReason).toBe("TERRITORY");
    const { addedPlies, state } = completeToScoring(passed, 200);
    expect(addedPlies).toBe(0);
    expect(state).toBe(passed);
  });
});

describe("baselines", () => {
  it("scores open points separately from the free credit on occupied ones", () => {
    const state = randomPosition(9, 30);
    const actual = ownershipFromState(state);
    const accuracy = ownershipAccuracy(state.board, predictNeutral(), actual);
    // Predicting nobody is exactly right on every point that is not territory.
    const territory = state.territories.A.length + state.territories.B.length;
    expect(accuracy.allCells.correct).toBe(CELL_COUNT - territory);
    expect(accuracy.openCells.total).toBeLessThan(CELL_COUNT);
    expect(accuracy.openCells.total).toBeGreaterThan(0);
  });

  it("produces a verdict for every point", () => {
    const state = randomPosition(21, 22);
    for (const owners of [
      predictByInfluence(state.board),
      predictByNearestCat(state.board),
      predictNeutral(),
    ]) {
      expect(owners).toHaveLength(CELL_COUNT);
    }
  });

  it("separates territory it found from territory it only claimed", () => {
    const state = randomPosition(9, 30);
    const actual = ownershipFromState(state);

    // Claiming nothing scores well on accuracy and zero on recall, which is
    // exactly the blind spot precision and recall exist to expose.
    const silent = ownershipClassScores(state.board, predictNeutral(), actual);
    for (const side of ["A", "B"] as const) {
      expect(silent[side].predicted).toBe(0);
      expect(silent[side].recallPercent).toBe(0);
    }

    // Handing back the labels themselves is perfect on both counts.
    const oracle = ownershipClassScores(state.board, actual, actual);
    for (const side of ["A", "B"] as const) {
      if (oracle[side].actual === 0) continue;
      expect(oracle[side].recallPercent).toBe(100);
      expect(oracle[side].precisionPercent).toBe(100);
    }
  });

  it("counts only open points, since an occupied one can never become territory", () => {
    const state = randomPosition(15, 28);
    const actual = ownershipFromState(state);
    const scores = ownershipClassScores(state.board, predictByInfluence(state.board), actual);
    const openHeld = { A: 0, B: 0 };
    for (const side of ["A", "B"] as const) {
      for (const { row, col } of state.territories[side]) {
        if (state.board[row][col] === "EMPTY") openHeld[side] += 1;
      }
      expect(scores[side].actual).toBe(openHeld[side]);
    }
  });

  it("reaches further than the capped influence signal", () => {
    // The evaluation's own map stops three steps out; the uncapped baseline is
    // what separates that cap from the idea behind it.
    const state = randomPosition(2, 6);
    const capped = predictByInfluence(state.board).filter((owner) => owner !== null).length;
    const uncapped = predictByNearestCat(state.board).filter((owner) => owner !== null).length;
    expect(uncapped).toBeGreaterThan(capped);
  });
});

describe("symmetry", () => {
  it("has eight distinct maps, the first of them the identity", () => {
    const signatures = new Set<string>();
    for (let sym = 0; sym < SYMMETRY_COUNT; sym++) {
      let signature = "";
      for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          const [r, c] = mapCoord(row, col, sym);
          signature += `${r},${c};`;
        }
      }
      signatures.add(signature);
    }
    expect(signatures.size).toBe(SYMMETRY_COUNT);
    expect(mapCoord(3, 5, 0)).toEqual([3, 5]);
  });

  it("moves board and labels together", () => {
    const state = randomPosition(17, 34);
    const owners = ownershipFromState(state);
    for (let sym = 0; sym < SYMMETRY_COUNT; sym++) {
      const board = transformBoard(state.board, sym);
      const moved = transformOwnership(owners, sym);
      // A relabelled board holds the same counts, and each point's label
      // travels with the point it belongs to.
      expect(encodeBoard(board).replace(/[^AB]/g, "").length).toBe(
        encodeBoard(state.board).replace(/[^AB]/g, "").length,
      );
      for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          const [r, c] = mapCoord(row, col, sym);
          expect(board[r][c]).toBe(state.board[row][col]);
          expect(moved[r * BOARD_SIZE + c]).toBe(owners[row * BOARD_SIZE + col]);
        }
      }
    }
  });

  it("returns to the original after applying a map and its inverse", () => {
    const state = randomPosition(29, 26);
    for (let sym = 0; sym < SYMMETRY_COUNT; sym++) {
      const once = transformBoard(state.board, sym);
      // Find whichever map undoes this one and check it round-trips.
      let restored = false;
      for (let back = 0; back < SYMMETRY_COUNT && !restored; back++) {
        if (encodeBoard(transformBoard(once, back)) === encodeBoard(state.board)) restored = true;
      }
      expect(restored).toBe(true);
    }
  });
});

describe("encoding", () => {
  it("round-trips ownership", () => {
    const state = randomPosition(31, 38);
    const owners = ownershipFromState(state);
    expect(decodeOwnership(encodeOwnership(owners))).toEqual(owners);
    expect(encodeOwnership(owners)).toHaveLength(CELL_COUNT);
    expect(encodeBoard(state.board)).toHaveLength(CELL_COUNT);
  });
});
