import { describe, expect, it } from "vitest";
import { trapCells } from "./BoardView";
import { BOARD_SIZE, CENTER, STARTING_CATS } from "../types";
import type { Board, GameState, Player } from "../types";

/**
 * Level 2 of danger detection: the empty points where placing a cat hands the
 * opponent a capture on their next move.
 *
 * These positions are built by hand rather than played out, so each one states
 * exactly the shape being asked about and nothing else.
 */
function board(): Board {
  const cells: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  cells[CENTER][CENTER] = "NEUTRAL";
  return cells;
}

function stateOf(cells: Board, toMove: Player): GameState {
  return {
    board: cells,
    currentPlayer: toMove,
    remainingCats: { A: STARTING_CATS, B: STARTING_CATS },
    consecutivePasses: 0,
    territories: { A: [], B: [] },
    winner: null,
    winReason: null,
    moveHistory: [],
  };
}

describe("danger level 2 — points that lose a cat", () => {
  it("flags a point where the placed cat is captured on the reply", () => {
    // B's cats wall three sides of (0,1); A playing there has one liberty left
    // at (1,1), which B fills next move.
    const cells = board();
    cells[0][0] = "PLAYER_B";
    cells[0][2] = "PLAYER_B";
    cells[1][1] = "EMPTY";
    cells[2][1] = "PLAYER_B";
    cells[1][0] = "PLAYER_B";
    cells[1][2] = "PLAYER_B";

    const traps = trapCells(stateOf(cells, "A"));
    expect(traps.has("0,1")).toBe(true);
  });

  it("leaves ordinary open points alone", () => {
    const cells = board();
    cells[0][0] = "PLAYER_B";
    const traps = trapCells(stateOf(cells, "A"));
    expect(traps.has("8,8")).toBe(false);
    expect(traps.has("4,0")).toBe(false);
  });

  it("says nothing about a group that was already down to its last liberty", () => {
    // A's cat at (0,0) is already in atari — B plays (1,0) and takes it. That
    // is true wherever A moves, so it is level 1's statement, not level 2's,
    // and dotting every empty point for it would say nothing at all.
    const cells = board();
    cells[0][0] = "PLAYER_A";
    cells[0][1] = "PLAYER_B";

    const traps = trapCells(stateOf(cells, "A"));
    // A far corner cannot be the cause of a danger that already existed.
    expect(traps.has("8,8")).toBe(false);
  });

  it("does not flag a move that ends the game by capturing", () => {
    // B's lone cat at (0,0) has one liberty at (1,0); A playing it wins on the
    // spot, so however the board looks afterwards it is not a trap.
    const cells = board();
    cells[0][0] = "PLAYER_B";
    cells[0][1] = "PLAYER_A";

    const traps = trapCells(stateOf(cells, "A"));
    expect(traps.has("1,0")).toBe(false);
  });
});
