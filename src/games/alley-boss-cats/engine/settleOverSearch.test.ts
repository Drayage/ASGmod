import { afterEach, describe, expect, it } from "vitest";
import {
  findBestMoveVeryHard,
  lastDecision,
  setSettleOverSearchEnabled,
  settleOverSearchEnabled,
  settleTheSearchPassed,
} from "./minimax";
import { createInitialState } from "../rules";
import { playerCell } from "../types";
import type { GameState, Player } from "../types";

/**
 * The rule that lets a settle overrule the full search, pinned at the three
 * places it is allowed to say no.
 *
 * The position is ply 18 of a recorded game (2026-08-11, build 0c8429c), which
 * is where the behaviour was measured: 치즈냥 to move, its own corner walled at
 * A2, B2, C2 and D1, and the two cells behind that wall settled by playing A1.
 * The search took a middle point and left them, four turns running.
 */
function withStones(stones: Array<[number, number, Player]>, toMove: Player): GameState {
  const state = createInitialState();
  const board = state.board.map((r) => [...r]);
  for (const [row, col, side] of stones) board[row][col] = playerCell(side);
  return { ...state, board, currentPlayer: toMove };
}

const recorded = () =>
  withStones(
    [
      [0, 3, "B"],
      [0, 5, "A"],
      [1, 0, "A"],
      [1, 1, "B"],
      [1, 2, "B"],
      [1, 6, "A"],
      [2, 1, "A"],
      [2, 2, "B"],
      [2, 7, "A"],
      [3, 0, "A"],
      [3, 8, "A"],
      [5, 0, "B"],
      [6, 1, "B"],
      [6, 7, "A"],
      [7, 2, "A"],
      [7, 6, "B"],
      [8, 5, "B"],
    ],
    "B",
  );

/** The middle point the search actually played, which settles nothing. */
const passedOver = { type: "PLACE" as const, row: 4, col: 6 };
/** A1, which closes the corner behind B's wall and settles two cells. */
const settle = { row: 0, col: 0 };

afterEach(() => setSettleOverSearchEnabled(false));

describe("the settle the search passed", () => {
  it("is off until something measures it on", () => {
    expect(settleOverSearchEnabled).toBe(false);
    expect(settleTheSearchPassed(recorded(), "B", passedOver, [settle], 200)).toBeNull();
  });

  it("takes a two-cell settle the search left on its own shortlist", () => {
    setSettleOverSearchEnabled(true);
    const taken = settleTheSearchPassed(recorded(), "B", passedOver, [settle], 200);
    expect(taken).toEqual({ type: "PLACE", row: 0, col: 0 });
  });

  it("leaves the search alone when its move already settles ground", () => {
    // Asked about the settle itself: it settles two, so there is nothing here
    // for a rule that only speaks when the search took nothing at all. The
    // enclosure upgrade is what handles that case, on the subset criterion.
    setSettleOverSearchEnabled(true);
    expect(
      settleTheSearchPassed(recorded(), "B", { type: "PLACE", ...settle }, [{ row: 4, col: 6 }], 200),
    ).toBeNull();
  });

  it("does not fire for a single cell, which the leaf itself prices lower", () => {
    // Measured on the recorded turns: at one cell the leaf evaluation preferred
    // the search's move 10 times out of 15, mean gap -65 points. That one is a
    // real trade against a stone that pays later, and is left to the search.
    setSettleOverSearchEnabled(true);
    const state = withStones(
      [
        [0, 1, "B"],
        [1, 0, "B"],
        [4, 4, "B"],
        [6, 6, "A"],
        [7, 7, "A"],
        [8, 6, "A"],
      ],
      "B",
    );
    // B1 closes the corner point A1 — one cell, and the only settle on offer.
    expect(
      settleTheSearchPassed(state, "B", { type: "PLACE", row: 4, col: 1 }, [{ row: 0, col: 0 }], 200),
    ).toBeNull();
  });

  it("never offers a move that hands over a group", () => {
    setSettleOverSearchEnabled(true);
    // A lone cat on two liberties with 고등어냥 all around it: whatever it
    // settles, the capture read refuses it, and one capture ends the game.
    const state = withStones(
      [
        [0, 3, "B"],
        [1, 1, "B"],
        [1, 2, "B"],
        [2, 2, "B"],
        [0, 1, "A"],
        [1, 0, "A"],
        [2, 0, "A"],
        [3, 1, "A"],
        [2, 3, "A"],
        [0, 4, "A"],
        [8, 8, "B"],
      ],
      "B",
    );
    const taken = settleTheSearchPassed(state, "B", { type: "PLACE", row: 5, col: 5 }, [settle], 400);
    if (taken && taken.type === "PLACE") {
      // If it did fire, it must at least not be the move that loses on the spot.
      expect(`${taken.row},${taken.col}`).not.toBe("0,0");
    } else {
      expect(taken).toBeNull();
    }
  });
});

describe("the decision trace", () => {
  it("describes this turn on every path out of the ladder", () => {
    // Three early returns used to leave the trace describing the previous turn.
    // Nothing noticed while only the stage name was read; the settle rule reads
    // the recorded shortlist, so it inherited another position's moves and threw
    // on the first illegal one. Two arena shards died on it.
    findBestMoveVeryHard(recorded(), "B", 400);
    expect(lastDecision.stage.startsWith("0 ")).toBe(false);

    const empty = createInitialState();
    findBestMoveVeryHard(empty, "A", 400);
    expect(lastDecision.stage).toBe("0 opening book");
    // And the shortlist that came with it is the move actually returned, not a
    // pool left over from the position before.
    expect(lastDecision.offered).toHaveLength(1);
  });
});
