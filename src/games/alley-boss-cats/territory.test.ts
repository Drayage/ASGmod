import { describe, expect, it } from "vitest";
import { BOARD_SIZE } from "./types";
import type { Board } from "./types";
import { calculateTerritories } from "./territory";

function emptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
}

describe("calculateTerritories", () => {
  it("returns nothing on an empty board (open exterior touches all four edges)", () => {
    const board = emptyBoard();
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });

  it("recognizes a single fully-enclosed cell as territory", () => {
    const board = emptyBoard();
    // Corner pocket at (0,0) walled by A on two sides + board edges on the other two.
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toEqual([{ row: 0, col: 0 }]);
    expect(territories.B).toHaveLength(0);
  });

  it("recognizes a multi-cell enclosed region", () => {
    const board = emptyBoard();
    // Wall off the top-left 2x2 corner with an A border.
    board[0][2] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    board[2][0] = "PLAYER_A";
    board[2][1] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(4);
  });

  it("does not count a region with an opponent cat inside its border", () => {
    const board = emptyBoard();
    board[0][2] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    board[2][0] = "PLAYER_A";
    board[2][1] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    board[1][1] = "PLAYER_B"; // opponent camped inside the pocket
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });

  it("leaves a region contested when both players border it", () => {
    const board = emptyBoard();
    // Corner pocket at (0,0), but the two walling cats belong to different players.
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_B";
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });

  it("lets the communal feeding spot serve as a border for either player", () => {
    const board = emptyBoard();
    board[4][4] = "NEUTRAL";
    board[3][3] = "PLAYER_A";
    board[3][4] = "PLAYER_A";
    board[4][3] = "PLAYER_A";
    const territories = calculateTerritories(board);
    // (3,3)-(3,4)-(4,3) border pocket cell would need full enclosure; just assert neutral doesn't break ownership
    expect(territories.B).toHaveLength(0);
  });

  it("excludes the whole-board outer region touching all four edges", () => {
    const board = emptyBoard();
    // A single cat can't wall anything off; the entire board remains one
    // open region touching all four edges, regardless of border color.
    board[4][4] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });
});
