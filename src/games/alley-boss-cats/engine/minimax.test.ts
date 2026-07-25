import { describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { getAllGroups, getGroupLiberties } from "../groups";
import { applyMove, createInitialState } from "../rules";
import { calculateTerritories } from "../territory";
import { BOARD_SIZE, CENTER } from "../types";
import type { Board, GameState, Player } from "../types";
import { findBestMoveMinimax, findBestMoveVeryHard } from "./minimax";
import { influenceCount } from "./territoryPlanner";

function minGroupLiberties(board: Board, player: Player): number {
  const counts = getAllGroups(board, player).map((g) => getGroupLiberties(board, g).size);
  return counts.length === 0 ? Infinity : Math.min(...counts);
}

function stateFrom(board: Board, currentPlayer: "A" | "B"): GameState {
  return {
    ...createInitialState(),
    board,
    territories: calculateTerritories(board),
    currentPlayer,
  };
}

function boardWithNeutral(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

describe("findBestMoveMinimax", () => {
  it("takes an immediate capture when one is available", () => {
    let state = createInitialState();
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    state = applyMove(state, 5, 7); // B elsewhere

    const action = findBestMoveMinimax(state, "A", 500);
    expect(action).toEqual({ type: "PLACE", row: 4, col: 3 });
  });

  it("saves its own group when the opponent threatens an immediate capture", () => {
    const board = boardWithNeutral();
    // A's lone castle at (5,2) is down to a single escape route at (6,2).
    // If A plays anywhere else, B takes (6,2) next move and wins outright,
    // so the only non-losing move is to extend at (6,2). Kept away from the
    // corners so no side accidentally encloses a territory here.
    board[5][2] = "PLAYER_A";
    board[4][2] = "PLAYER_B";
    board[5][1] = "PLAYER_B";
    board[5][3] = "PLAYER_B";
    const state = stateFrom(board, "A");
    expect(state.territories.A).toHaveLength(0);
    expect(state.territories.B).toHaveLength(0);

    const action = findBestMoveMinimax(state, "A", 700);
    expect(action).toEqual({ type: "PLACE", row: 6, col: 2 });
  });

  it("punishes a two-liberty enemy group by putting it in atari", () => {
    // Position taken from a real game: B's group {(0,6),(1,6)} is pinned
    // against the top wall with only (0,5) and (0,7) left. A to move — either
    // liberty forces the group into atari, and every B escape just makes a
    // new one-liberty group, so this is a won position A must not misplay.
    const board = boardWithNeutral();
    board[1][5] = "PLAYER_A";
    board[1][7] = "PLAYER_A";
    board[2][6] = "PLAYER_A";
    board[0][6] = "PLAYER_B";
    board[1][6] = "PLAYER_B";
    board[3][6] = "PLAYER_B";
    const state = stateFrom(board, "A");

    const action = findBestMoveMinimax(state, "A", 1500);
    expect(action.type).toBe("PLACE");
    const killing = [
      { row: 0, col: 5 },
      { row: 0, col: 7 },
    ];
    expect(killing).toContainEqual({
      row: (action as { row: number }).row,
      col: (action as { col: number }).col,
    });
  });

  it("does not leave one of its own groups in atari when it can avoid it", () => {
    // B's lone castle is down to two liberties with A closing in. Whatever B
    // chooses, it must not end the turn with a group on a single liberty —
    // that hands A an immediate capture win.
    const board = boardWithNeutral();
    board[1][5] = "PLAYER_A";
    board[2][6] = "PLAYER_A";
    board[1][6] = "PLAYER_B";
    const state = stateFrom(board, "B");
    expect(minGroupLiberties(state.board, "B")).toBe(2);

    const action = findBestMoveMinimax(state, "B", 2000);
    expect(action.type).toBe("PLACE");
    const next = applyAction(state, action);
    expect(next.winner).not.toBe("A");
    expect(minGroupLiberties(next.board, "B")).toBeGreaterThanOrEqual(2);
  });

  it("returns a legal action on the opening position within its time budget", () => {
    const state = createInitialState();
    const start = Date.now();
    const action = findBestMoveMinimax(state, "A", 700);
    const elapsed = Date.now() - start;
    expect(action.type === "PLACE" || action.type === "PASS").toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});

/**
 * The shape a human beat this AI with repeatedly: a loose diagonal ladder down
 * one side, claiming the whole right half without ever committing to a fight.
 * The AI answered by tidying its own corner and lost the count every time.
 */
function wideFrameworkPosition(): GameState {
  const board = boardWithNeutral();
  for (const [r, c] of [
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
    [5, 7],
    [6, 6],
    [7, 5],
    [8, 4],
  ]) {
    board[r][c] = "PLAYER_A";
  }
  for (const [r, c] of [
    [6, 1],
    [7, 1],
    [7, 2],
    [6, 2],
  ]) {
    board[r][c] = "PLAYER_B";
  }
  return stateFrom(board, "B");
}

describe("findBestMoveVeryHard", () => {
  it("contests a framework claiming a whole side instead of settling at home", () => {
    const state = wideFrameworkPosition();
    const influence = influenceCount(state.board);
    expect(influence.A - influence.B).toBeGreaterThan(15); // A really is running away with it

    const action = findBestMoveVeryHard(state, "B", 600);

    // Passing here concedes the count outright, and so does another castle
    // tucked into the bottom-left. The move has to argue about A's side.
    expect(action.type).toBe("PLACE");
    expect((action as { col: number }).col).toBeGreaterThanOrEqual(4);
  });

  it("does not throw the contesting castle away to get there", () => {
    const state = wideFrameworkPosition();
    const action = findBestMoveVeryHard(state, "B", 600);
    const next = applyAction(state, action);

    expect(next.winner).not.toBe("A");
    // A castle placed with a single liberty is captured on A's next move, which
    // ends the game — invading has to leave somewhere to breathe.
    expect(minGroupLiberties(next.board, "B")).toBeGreaterThanOrEqual(2);
  });
});
