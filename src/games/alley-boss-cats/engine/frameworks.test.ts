import { describe, expect, it } from "vitest";
import { candidateFrameworks, invasionRead, judgeFramework, rankFrameworks, setInvasionRead } from "./frameworks";
import { createInitialState } from "../rules";
import { calculateTerritories } from "../territory";
import { BOARD_SIZE, CENTER, playerCell } from "../types";
import type { Board, GameState, Player } from "../types";

function position(a: Array<[number, number]>, b: Array<[number, number]>): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  for (const [r, c] of a) board[r][c] = playerCell("A");
  for (const [r, c] of b) board[r][c] = playerCell("B");
  return { ...createInitialState(), board, territories: calculateTerritories(board), currentPlayer: "A" };
}

/** The corner cut, at the offset that the given stones lie on. */
function frameAcross(state: GameState, player: Player, span: number) {
  return candidateFrameworks(state.board, player).find((f) => f.wall.length === span + 1)!;
}

describe("corner frameworks", () => {
  it("prices the diagonal as the cheapest way to enclose ground", () => {
    // n cats across a corner enclose n(n-1)/2 cells, and the two board edges do
    // the rest of the walling. Nothing else on the board comes close.
    const four = position([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]], [[6, 6]]);
    expect(four.territories.A).toHaveLength(10);

    const six = position(
      [[0, 6], [1, 5], [2, 4], [3, 3], [4, 2], [5, 1], [6, 0]],
      [[8, 8]],
    );
    expect(six.territories.A).toHaveLength(21);

    // A straight wall of the same length encloses far less.
    const straight = position([[0, 3], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0]], [[6, 6]]);
    expect(straight.territories.A.length).toBeLessThan(21);
  });

  it("counts what is left to close, and how many ways there are to close it", () => {
    const state = position([[0, 4], [1, 3], [2, 2], [3, 1]], [[6, 6]]);
    const frame = frameAcross(state, "A", 4);

    expect(frame.enclosed).toHaveLength(10);
    expect(frame.missing).toEqual([{ row: 4, col: 0 }]);
    expect(frame.intruders).toHaveLength(0);
  });

  it("treats a frame the opponent already sits inside as broken", () => {
    const state = position([[0, 4], [1, 3], [3, 1], [4, 0]], [[1, 1]]);
    const frame = frameAcross(state, "A", 4);

    expect(frame.intruders).toContainEqual({ row: 1, col: 1 });
    expect(judgeFramework(state, "A", frame).secure).toBe(false);
  });

  it("finds more ways in to a big frame than a small one", () => {
    // The player's own rule: a region is only really yours if you can answer
    // every way in. Room to live scales with the size of the region, so a
    // sprawling frame is a claim rather than a holding — which is why taking a
    // modest corner beats sketching out half the board.
    //
    // The per-invasion read is pinned generously because the claim is about the
    // two shapes, not about the clock: on a loaded machine the default 25ms
    // fails to prove the small frame's kills either, both sides come back at
    // MAX_INVASION_CHECKS, and the comparison says nothing. Restored afterwards
    // so the rest of the file sees the shipped setting.
    const shipped = invasionRead();
    setInvasionRead(400, shipped.depth);
    try {
    const small = position([[0, 4], [1, 3], [2, 2], [3, 1]], [[6, 6]]);
    const big = position([[0, 6], [1, 5], [2, 4], [3, 3], [4, 2], [5, 1]], [[8, 8]]);

    const smallVerdict = judgeFramework(small, "A", frameAcross(small, "A", 4), 1500);
    const bigVerdict = judgeFramework(big, "A", frameAcross(big, "A", 6), 1500);

    expect(smallVerdict.size).toBe(10);
    expect(bigVerdict.size).toBe(21);
    expect(bigVerdict.livingInvasions.length).toBeGreaterThan(smallVerdict.livingInvasions.length);
    } finally {
      setInvasionRead(shipped.ms, shipped.depth);
    }
  });

  it("calls a closed corner secure and needs nothing more spent on it", () => {
    const state = position([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]], [[6, 6]]);
    const best = rankFrameworks(state, "A", 2000)[0];

    expect(best.movesToClose).toBe(0);
    expect(best.livingInvasions).toHaveLength(0);
    expect(best.secure).toBe(true);
  });

  it("ignores corners the player has not started", () => {
    const state = position([[4, 4 - 1]], [[6, 6]]);
    const frames = candidateFrameworks(state.board, "A");
    // Every frame offered must already contain one of the player's cats,
    // otherwise all four corners would qualify on an empty board.
    for (const frame of frames) {
      expect(frame.wall.some(({ row, col }) => state.board[row][col] === "PLAYER_A")).toBe(true);
    }
  });
});
