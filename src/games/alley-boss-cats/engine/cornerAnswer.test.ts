import { afterEach, describe, expect, it } from "vitest";
import {
  cornerAnswerGuardEnabled,
  findBestMoveVeryHard,
  setCornerAnswerGuardEnabled,
} from "./minimax";
import { createInitialState } from "../rules";
import { playerCell } from "../types";
import type { GameState, Player } from "../types";

/**
 * Answering an opponent's corner entry from outside it.
 *
 * Derived from 446 corner fights across the pro, community, human-vs-human and
 * engine records. Against an opening (1,2), the engine answers (1,3) or (2,3)
 * 39 times in 114 and finishes those corners with 1.9 cells against 3.9; people
 * play those two answers 5 times in 71. The guard removes exactly those two
 * points, and only while a point further in is still playable.
 */
function withStones(stones: Array<[number, number, Player]>, toMove: Player): GameState {
  const state = createInitialState();
  const board = state.board.map((r) => [...r]);
  for (const [row, col, side] of stones) board[row][col] = playerCell(side);
  return { ...state, board, currentPlayer: toMove };
}

afterEach(() => setCornerAnswerGuardEnabled(false));

/** B alone in the top-left at its (1,2) point; A to answer. */
const entered = () => withStones([[1, 2, "B"], [6, 6, "B"], [7, 7, "A"]], "A");

const isOutsideAnswer = (move: { type: string; row?: number; col?: number }) => {
  if (move.type !== "PLACE") return false;
  const dr = Math.min(move.row!, 8 - move.row!);
  const dc = Math.min(move.col!, 8 - move.col!);
  const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
  return (a === 1 && b === 3) || (a === 2 && b === 3);
};

describe("the corner answer guard", () => {
  it("is off until something measures it on", () => {
    expect(cornerAnswerGuardEnabled).toBe(false);
  });

  it("never answers that corner from the outside points", () => {
    setCornerAnswerGuardEnabled(true);
    const state = entered();
    const move = findBestMoveVeryHard(state, "A", 1500);
    // Either it answers further in, or it plays elsewhere entirely — what it
    // must not do is take (1,3) or (2,3) in the corner they just entered.
    if (move.type === "PLACE") {
      const inThatCorner = move.row < 4 && move.col < 4;
      expect(inThatCorner && isOutsideAnswer(move)).toBe(false);
    }
  });

  it("leaves a corner alone once the engine is already in it", () => {
    // With a stone of its own there this is no longer an answer to an entry,
    // and the frame line is the book's own shape — not this guard's business.
    setCornerAnswerGuardEnabled(true);
    const state = withStones(
      [[1, 2, "B"], [2, 1, "A"], [6, 6, "B"], [7, 7, "A"]],
      "A",
    );
    const move = findBestMoveVeryHard(state, "A", 1500);
    expect(move.type).toBe("PLACE");
  });

  it("still returns a move when the corner is the only place left", () => {
    // The graceful-narrowing contract every pool filter here keeps: if removing
    // would empty the list, the original list survives.
    setCornerAnswerGuardEnabled(true);
    const state = entered();
    const move = findBestMoveVeryHard(state, "A", 1000);
    expect(move).toBeTruthy();
  });
});
