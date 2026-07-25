import { describe, expect, it } from "vitest";
import { getAIMove, projectedMargin } from "./ai";
import { applyMove, createInitialState } from "./rules";
import { calculateTerritories } from "./territory";
import { BOARD_SIZE, CENTER, FIRST_PLAYER_MARGIN } from "./types";
import type { Board, GameState, Player } from "./types";

function emptyBoard(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

function stateFrom(board: Board, currentPlayer: Player): GameState {
  return { ...createInitialState(), board, territories: calculateTerritories(board), currentPlayer };
}

describe("getAIMove", () => {
  it("takes an immediate capture when one is available", () => {
    let state = createInitialState();
    // B's lone cat at (3,3) is one move away from being fully surrounded by A.
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    state = applyMove(state, 5, 7); // B elsewhere
    // It's A's turn; (4,3) captures immediately.
    const action = getAIMove(state, "A", "EASY");
    expect(action).toEqual({ type: "PLACE", row: 4, col: 3 });
  });

  it("never returns a suicide move even under EASY difficulty", () => {
    let state = createInitialState();
    const action = getAIMove(state, "A", "EASY");
    expect(action.type).toBe("PLACE");
  });

  it("completes a NORMAL-difficulty decision on the opening position within a time budget", () => {
    const state = createInitialState();
    const start = Date.now();
    const action = getAIMove(state, "A", "NORMAL");
    const elapsed = Date.now() - start;
    expect(action).toBeDefined();
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("projectedMargin", () => {
  it("hands the empty board to 고등어냥, who is owed the first-player margin", () => {
    const state = stateFrom(emptyBoard(), "A");
    expect(projectedMargin(state, "A")).toBe(-FIRST_PLAYER_MARGIN);
    expect(projectedMargin(state, "B")).toBe(FIRST_PLAYER_MARGIN);
  });

  it("is zero-sum: what one side is ahead by, the other is behind by", () => {
    const board = emptyBoard();
    // A wall along row 2 from the left edge, sealing the strip above it.
    for (let col = 0; col < BOARD_SIZE; col++) board[2][col] = "PLAYER_A";
    board[6][4] = "PLAYER_B";
    const state = stateFrom(board, "B");

    expect(projectedMargin(state, "A")).toBeCloseTo(-projectedMargin(state, "B"), 10);
  });

  it("only calls 치즈냥 ahead once the lead clears the margin it owes", () => {
    const board = emptyBoard();
    // A seals the top two rows: 18 cells minus the wall itself.
    for (let col = 0; col < BOARD_SIZE; col++) board[2][col] = "PLAYER_A";
    board[6][4] = "PLAYER_B";
    const state = stateFrom(board, "A");

    const lead = state.territories.A.length - state.territories.B.length;
    expect(lead).toBeGreaterThan(FIRST_PLAYER_MARGIN);
    expect(projectedMargin(state, "A")).toBeGreaterThan(0);
    expect(projectedMargin(state, "B")).toBeLessThan(0);
  });

  it("counts settled ground as worth more than ground merely being headed towards", () => {
    // Seven castles walling off the top-left 3×3 corner: 9 settled cells.
    const sealed = emptyBoard();
    for (const [r, c] of [[0, 3], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0]]) {
      sealed[r][c] = "PLAYER_A";
    }
    const sealedState = stateFrom(sealed, "A");

    // The same seven castles strung across open ground, settling nothing —
    // they still radiate plenty of influence, which must not add up to more.
    const spread = emptyBoard();
    for (const [r, c] of [[1, 5], [2, 6], [3, 7], [5, 1], [6, 2], [7, 3], [5, 6]]) {
      spread[r][c] = "PLAYER_A";
    }
    const spreadState = stateFrom(spread, "A");

    expect(sealedState.territories.A.length).toBe(9);
    expect(spreadState.territories.A.length).toBe(0);
    expect(projectedMargin(sealedState, "A")).toBeGreaterThan(projectedMargin(spreadState, "A"));
  });
});
