import { afterEach, describe, expect, it } from "vitest";
import { cornerBookMove, setCornerBookFinishEnabled } from "./minimax";
import { getLegalMoves } from "../rules";
import { createInitialState } from "../rules";
import { playerCell } from "../types";
import type { GameState, Player } from "../types";
import type { AIAction } from "../ai";

/**
 * The book's budget used to count the mover's stones on the whole board, so a
 * side that had claimed two corners had three moves left against the four one
 * frame needs and never finished either. These pin the finishing rule: it keeps
 * building an opened corner past the old limit, it stops at the four stones the
 * frame is, and it will not open a third corner with the extra budget.
 */
function withStones(stones: Array<[number, number, Player]>): GameState {
  const state = createInitialState();
  const board = state.board.map((r) => [...r]);
  for (const [row, col, side] of stones) board[row][col] = playerCell(side);
  return { ...state, board, currentPlayer: "A" };
}

const pool = (state: GameState, side: Player): AIAction[] =>
  getLegalMoves(state, side).map((m) => ({ type: "PLACE", row: m.row, col: m.col }));

const at = (move: AIAction | null) =>
  move && move.type === "PLACE" ? `${move.row},${move.col}` : null;

afterEach(() => setCornerBookFinishEnabled(false));

describe("cornerBookMove with the finishing budget", () => {
  // Six own stones: the old gate stopped at five, so this position is exactly
  // where the two rules disagree.
  const started: Array<[number, number, Player]> = [
    [1, 2, "A"], // top-left frame
    [2, 1, "A"],
    [1, 6, "A"], // top-right frame
    [6, 6, "A"], // stones elsewhere, spending the old budget
    [6, 2, "A"],
    [4, 3, "A"],
  ];

  it("stops once the mover has five stones without it", () => {
    const state = withStones(started);
    expect(cornerBookMove(state, "A", pool(state, "A"))).toBeNull();
  });

  it("keeps building an opened corner with it", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones(started);
    // The top-left frame is (1,2) (2,1) (0,3) (3,0); two are down, so the book
    // has to offer one of the two that are not.
    expect(["0,3", "3,0"]).toContain(at(cornerBookMove(state, "A", pool(state, "A"))));
  });

  it("takes the middle of the frame first, not the edge one", () => {
    setCornerBookFinishEnabled(true);
    // One stone on the (1,2) point. (0,3) and (2,1) are both two steps away, and
    // the rules make them the worst and best second stone a corner has: (1,2)
    // with (2,1) kills an invader at all eight entry points, (1,2) with (0,3)
    // lets five of eight live. The tie has to break toward the middle.
    const state = withStones([
      [1, 2, "A"],
      [6, 6, "A"],
      [4, 3, "A"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("2,1");
  });

  it("leaves a finished frame alone", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "A"],
      [0, 3, "A"],
      [3, 0, "A"],
      [1, 6, "A"],
    ]);
    // Nothing more is owed to the top-left; the answer has to be the other
    // corner it has opened, never a fifth stone on the finished frame.
    const move = at(cornerBookMove(state, "A", pool(state, "A")));
    expect(["0,3", "3,0", "1,2", "2,1"]).not.toContain(move);
  });

  it("will not open a third corner", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "A"],
      [0, 3, "A"],
      [3, 0, "A"],
      [1, 6, "A"],
      [2, 7, "A"],
      [0, 5, "A"],
      [3, 8, "A"],
    ]);
    // Both corners are finished frames, so the book is done rather than
    // claiming a bottom corner with the budget it has left.
    expect(cornerBookMove(state, "A", pool(state, "A"))).toBeNull();
  });
});
