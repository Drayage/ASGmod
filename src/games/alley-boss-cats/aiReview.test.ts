/** Tests for the review fixes: eye-immortality awareness, the pass-out safety
 * check, and the cheap immediate-win detection agreeing with the rules. */
import { describe, expect, it } from "vitest";
import { evaluateState, getSafeActions, opponentHasImmediateWin } from "./ai";
import { findForcedCapture } from "./engine/captureSearch";
import { createInitialState } from "./rules";
import { calculateTerritories } from "./territory";
import { BOARD_SIZE, CENTER } from "./types";
import type { Board, GameState, Player } from "./types";

function boardWithNeutral(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

function stateFrom(board: Board, currentPlayer: Player, extra: Partial<GameState> = {}): GameState {
  return {
    ...createInitialState(),
    board,
    territories: calculateTerritories(board),
    currentPlayer,
    ...extra,
  };
}

/** A's corner group whose only liberty is its own territory at (0,0), with B
 * pressing from outside — permanently alive despite one liberty. */
function immortalCornerPosition(): GameState {
  const board = boardWithNeutral();
  board[0][1] = "PLAYER_A";
  board[1][0] = "PLAYER_A";
  board[1][1] = "PLAYER_A";
  board[0][2] = "PLAYER_B";
  board[1][2] = "PLAYER_B";
  board[2][0] = "PLAYER_B";
  board[2][1] = "PLAYER_B";
  board[2][2] = "PLAYER_B";
  const state = stateFrom(board, "B");
  // Preconditions: the pocket really is A's territory and the A group's only
  // liberty really is that pocket.
  expect(state.territories.A).toEqual([{ row: 0, col: 0 }]);
  return state;
}

describe("eye immortality", () => {
  it("does not score a permanently alive group as a dying one", () => {
    const state = immortalCornerPosition();
    // Old behavior: A's group counted as atari with B to move → -400000 panic.
    const score = evaluateState(state, "A");
    expect(score).toBeGreaterThan(-100_000);
  });

  it("does not let the capture reader chase a permanently alive group", () => {
    const state = immortalCornerPosition();
    expect(findForcedCapture(state, "B", 7, 1000)).toBeNull();
  });

  it("does not treat a territory-breathing group as an opponent immediate win", () => {
    const state = immortalCornerPosition();
    // A's group is on one liberty, but B cannot play there — no win available.
    expect(opponentHasImmediateWin(state, "A")).toBe(false);
  });
});

describe("opponentHasImmediateWin (direct computation)", () => {
  it("detects a one-liberty group whose liberty is fillable", () => {
    const board = boardWithNeutral();
    board[4][4 - 2] = "PLAYER_A"; // (4,2)
    board[3][2] = "PLAYER_B";
    board[5][2] = "PLAYER_B";
    board[4][1] = "PLAYER_B";
    // A's lone stone has one liberty at (4,3); B to move captures there.
    const state = stateFrom(board, "B");
    expect(opponentHasImmediateWin(state, "A")).toBe(true);
  });

  it("sees the pass-out loss after our own pass", () => {
    // B has territory, A has none; A passed (consecutivePasses=1). If B now
    // passes, the game ends and B wins the count — that is an immediate win.
    const board = boardWithNeutral();
    board[0][1] = "PLAYER_B";
    board[1][0] = "PLAYER_B";
    const state = stateFrom(board, "B", { consecutivePasses: 1 });
    expect(state.territories.B).toEqual([{ row: 0, col: 0 }]);
    expect(opponentHasImmediateWin(state, "A")).toBe(true);
  });

  it("keeps PASS out of the safe pool when passing loses the game outright", () => {
    // One pass already on the counter and the territory count favors B: if A
    // passes now the game ends immediately with B the winner.
    const board = boardWithNeutral();
    board[0][1] = "PLAYER_B";
    board[1][0] = "PLAYER_B";
    const state = stateFrom(board, "A", { consecutivePasses: 1 });

    const { winningMove, pool } = getSafeActions(state, "A");
    expect(winningMove).toBeNull();
    expect(pool.some((a) => a.type === "PASS")).toBe(false);
    expect(pool.length).toBeGreaterThan(0);
  });
});
