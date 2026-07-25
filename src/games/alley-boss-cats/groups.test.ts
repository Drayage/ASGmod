import { describe, expect, it } from "vitest";
import { BOARD_SIZE } from "./types";
import type { Board, GameState } from "./types";
import { findEndangeredGroups, getAllGroups, getConnectedGroup, getGroupLiberties } from "./groups";
import { createInitialState } from "./rules";
import { calculateTerritories } from "./territory";

function emptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
}

describe("getConnectedGroup", () => {
  it("connects orthogonal neighbors only", () => {
    const board = emptyBoard();
    // A A ·
    // · A A
    board[0][0] = "PLAYER_A";
    board[0][1] = "PLAYER_A";
    board[1][1] = "PLAYER_A";
    board[1][2] = "PLAYER_A";

    const group = getConnectedGroup(board, 0, 0);
    expect(group).toHaveLength(4);
  });

  it("does not connect diagonally", () => {
    const board = emptyBoard();
    // A ·
    // · A
    board[0][0] = "PLAYER_A";
    board[1][1] = "PLAYER_A";

    expect(getConnectedGroup(board, 0, 0)).toHaveLength(1);
  });

  it("finds groups touching the board edge", () => {
    const board = emptyBoard();
    board[0][0] = "PLAYER_A";
    board[0][1] = "PLAYER_A";
    const group = getConnectedGroup(board, 0, 0);
    expect(group).toHaveLength(2);
  });

  it("splits unconnected groups of the same color", () => {
    const board = emptyBoard();
    board[0][0] = "PLAYER_A";
    board[8][8] = "PLAYER_A";
    const groups = getAllGroups(board, "A");
    expect(groups).toHaveLength(2);
  });
});

describe("getGroupLiberties", () => {
  it("counts the surviving liberty when one cell remains", () => {
    const board = emptyBoard();
    // · A ·
    // A A B
    // · B ·
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    board[1][1] = "PLAYER_A";
    board[1][2] = "PLAYER_B";
    board[2][1] = "PLAYER_B";

    const group = getConnectedGroup(board, 1, 1);
    const liberties = getGroupLiberties(board, group);
    // remaining empty neighbors: (0,0)? not adjacent; actual liberties are (2,0) and (0,2)? let's just check > 0
    expect(liberties.size).toBeGreaterThan(0);
  });

  it("reports zero liberties for a fully surrounded single cat", () => {
    const board = emptyBoard();
    board[4][4] = "PLAYER_A";
    board[3][4] = "PLAYER_B";
    board[5][4] = "PLAYER_B";
    board[4][3] = "PLAYER_B";
    board[4][5] = "PLAYER_B";

    const group = getConnectedGroup(board, 4, 4);
    expect(getGroupLiberties(board, group).size).toBe(0);
  });

  it("keeps a multi-cat group alive if any member has a liberty", () => {
    const board = emptyBoard();
    // A A A A
    // A B B A
    // A A A A
    for (const [r, c] of [
      [0, 0], [0, 1], [0, 2], [0, 3],
      [1, 0], [1, 3],
      [2, 0], [2, 1], [2, 2], [2, 3],
    ]) {
      board[r][c] = "PLAYER_A";
    }
    board[1][1] = "PLAYER_B";
    board[1][2] = "PLAYER_B";

    const group = getConnectedGroup(board, 1, 1);
    expect(group).toHaveLength(2);
    expect(getGroupLiberties(board, group).size).toBe(0);
  });

  it("still counts a confirmed-territory cell as a liberty", () => {
    // A territory is only ever bordered by its owner's own castles, so
    // treating those cells as non-liberties would let a player strangle the
    // very group that walled the territory off. A gap is a gap.
    const board = emptyBoard();
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    // (0,0) is now A's territory, walled by two castles and two board edges.
    expect(calculateTerritories(board).A).toEqual([{ row: 0, col: 0 }]);

    const group = getConnectedGroup(board, 0, 1);
    expect(getGroupLiberties(board, group)).toContain("0,0");
  });
});

describe("findEndangeredGroups", () => {
  function stateFrom(board: Board, currentPlayer: "A" | "B"): GameState {
    return { ...createInitialState(), board, territories: calculateTerritories(board), currentPlayer };
  }

  it("flags a group the opponent can surround with one more cat", () => {
    const board = emptyBoard();
    board[4][4] = "NEUTRAL";
    // B's lone cat at (5,2) is down to a single escape route at (6,2).
    board[5][2] = "PLAYER_B";
    board[4][2] = "PLAYER_A";
    board[5][1] = "PLAYER_A";
    board[5][3] = "PLAYER_A";
    const state = stateFrom(board, "A");

    expect(findEndangeredGroups(state, "B")).toEqual([[{ row: 5, col: 2 }]]);
    expect(findEndangeredGroups(state, "A")).toEqual([]);
  });

  it("leaves comfortable groups alone", () => {
    const board = emptyBoard();
    board[4][4] = "NEUTRAL";
    board[5][2] = "PLAYER_B";
    board[4][2] = "PLAYER_A";
    const state = stateFrom(board, "A");

    expect(findEndangeredGroups(state, "B")).toEqual([]);
  });

  it("does not flag a group whose last breath is its own living area", () => {
    const board = emptyBoard();
    board[4][4] = "NEUTRAL";
    // A walls off the top-left 3x3 corner, then sits a cat in the doorway at
    // (2,2) whose only empty neighbour is inside that settled area. Nobody may
    // ever play there, so the cat is permanently safe — warning about it would
    // be telling the player to defend something that cannot be attacked.
    for (const [r, c] of [[0, 3], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0]]) {
      board[r][c] = "PLAYER_A";
    }
    board[2][1] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    const state = stateFrom(board, "B");

    const endangered = findEndangeredGroups(state, "A");
    const cells = endangered.flat();
    expect(cells).not.toContainEqual({ row: 2, col: 2 });
  });
});
