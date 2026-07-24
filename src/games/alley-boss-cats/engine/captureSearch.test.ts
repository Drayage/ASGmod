import { describe, expect, it } from "vitest";
import { getAllGroups, getGroupLiberties } from "../groups";
import { createInitialState } from "../rules";
import { calculateTerritories } from "../territory";
import { BOARD_SIZE, CENTER } from "../types";
import type { Board, GameState, Player } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";

function boardWithNeutral(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

function stateFrom(board: Board, currentPlayer: Player): GameState {
  return { ...createInitialState(), board, territories: calculateTerritories(board), currentPlayer };
}

describe("findForcedCapture", () => {
  it("reads out a group pinned against the wall with two liberties", () => {
    // The shape from a real game: B's {(0,6),(1,6)} has only (0,5) and (0,7).
    // Filling either puts it in atari, and every escape just makes another
    // one-liberty group, so A can force the capture several moves ahead.
    const board = boardWithNeutral();
    board[1][5] = "PLAYER_A";
    board[1][7] = "PLAYER_A";
    board[2][6] = "PLAYER_A";
    board[0][6] = "PLAYER_B";
    board[1][6] = "PLAYER_B";
    board[3][6] = "PLAYER_B";
    const state = stateFrom(board, "A");

    const found = findForcedCapture(state, "A", 7, 2000);
    expect(found).not.toBeNull();
    expect(found!.move.type).toBe("PLACE");
    const move = found!.move as { row: number; col: number };
    expect([
      { row: 0, col: 5 },
      { row: 0, col: 7 },
    ]).toContainEqual({ row: move.row, col: move.col });
  });

  it("takes a plain atari group immediately", () => {
    const board = boardWithNeutral();
    board[5][5] = "PLAYER_B";
    board[4][5] = "PLAYER_A";
    board[6][5] = "PLAYER_A";
    board[5][4] = "PLAYER_A";
    const state = stateFrom(board, "A");

    const found = findForcedCapture(state, "A", 5, 1000);
    expect(found).not.toBeNull();
    expect(found!.move).toEqual({ type: "PLACE", row: 5, col: 6 });
  });

  it("does not claim a capture against a group with room to run", () => {
    const board = boardWithNeutral();
    board[5][5] = "PLAYER_B";
    board[4][5] = "PLAYER_A";
    const state = stateFrom(board, "A");

    expect(findForcedCapture(state, "A", 6, 1000)).toBeNull();
  });

  it("does not claim a capture on an empty board", () => {
    expect(findForcedCapture(createInitialState(), "A", 6, 1000)).toBeNull();
  });
});

describe("focus follows the group as the fight moves", () => {
  it("does not write off a group that ran out of the original focus region", () => {
    // A three-stone B wall along the top with plenty of room to the left. The
    // focus built from its first liberties covers only a couple of cells; the
    // group itself has four liberties and is in no danger at all. Reading it
    // must not conclude anything is forced.
    const board = boardWithNeutral();
    board[0][6] = "PLAYER_B";
    board[0][7] = "PLAYER_B";
    board[0][8] = "PLAYER_B";
    board[1][8] = "PLAYER_A";
    const state = stateFrom(board, "A");

    expect(findForcedCapture(state, "A", 7, 1000)).toBeNull();
  });

  it("a group with two or more liberties is never reported as trapped", () => {
    // Regression for the focus-staleness defect: the defender's candidate set
    // is rebuilt from the group's *current* liberties, so a group that still
    // has somewhere to breathe always has a move to make. With a frozen focus
    // this position could be declared a forced capture once the fight drifted
    // outside the initial region.
    const board = boardWithNeutral();
    board[4][6] = "PLAYER_B";
    board[5][6] = "PLAYER_B";
    board[3][6] = "PLAYER_A";
    board[4][7] = "PLAYER_A";
    const state = stateFrom(board, "A");

    const group = getAllGroups(state.board, "B")[0];
    expect(getGroupLiberties(state.board, group).size).toBeGreaterThanOrEqual(3);
    expect(findForcedCapture(state, "A", 7, 1000)).toBeNull();
  });
});

describe("opponentCanForceCapture", () => {
  it("sees that walking into the wall shape loses by force", () => {
    // B to move has already been reduced to one liberty at (0,6); extending
    // there is forced, and A then kills it — so from A's side, this position
    // is a proven win.
    const board = boardWithNeutral();
    board[1][5] = "PLAYER_A";
    board[1][7] = "PLAYER_A";
    board[2][6] = "PLAYER_A";
    board[1][6] = "PLAYER_B";
    const afterBExtends = boardWithNeutral();
    for (let r = 0; r < BOARD_SIZE; r++) afterBExtends[r] = [...board[r]];
    afterBExtends[0][6] = "PLAYER_B";

    // With A to move against the extended shape, B is lost.
    const state = stateFrom(afterBExtends, "A");
    expect(opponentCanForceCapture(state, "B", 7, 2000)).toBe(true);
  });

  it("reports no forced loss from a quiet opening position", () => {
    const board = boardWithNeutral();
    board[4][2] = "PLAYER_A";
    board[6][6] = "PLAYER_B";
    const state = stateFrom(board, "B");
    expect(opponentCanForceCapture(state, "A", 6, 1000)).toBe(false);
  });
});
