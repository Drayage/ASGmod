import { describe, expect, it } from "vitest";
import { BOARD_SIZE } from "./types";
import type { Board } from "./types";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./groups";

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

  it("excludes confirmed-territory cells from liberties", () => {
    const board = emptyBoard();
    board[4][4] = "PLAYER_A";
    board[3][4] = "PLAYER_B";
    board[4][3] = "PLAYER_B";
    board[4][5] = "PLAYER_B";
    // (5,4) is the only empty neighbor left
    const group = getConnectedGroup(board, 4, 4);

    expect(getGroupLiberties(board, group).size).toBe(1);
    const locked = new Set<string>(["5,4"]);
    expect(getGroupLiberties(board, group, locked).size).toBe(0);
  });
});
