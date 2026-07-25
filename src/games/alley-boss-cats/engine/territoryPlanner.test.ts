import { describe, expect, it } from "vitest";
import { findBestMoveVeryHard } from "./minimax";
import { findSealingMoves, planTerritory } from "./territoryPlanner";
import { createInitialState } from "../rules";
import { calculateTerritories } from "../territory";
import { BOARD_SIZE, CENTER } from "../types";
import type { Board, GameState, Player } from "../types";

function boardWithNeutral(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

function stateFrom(board: Board, currentPlayer: Player): GameState {
  return { ...createInitialState(), board, territories: calculateTerritories(board), currentPlayer };
}

/**
 * A wall along row 3 from the left edge, and a partial wall up column 5,
 * leaving the top-left open only through (2,5). A castle at (2,6) seals the
 * biggest block — 16 cells, one more than plugging (2,5) itself, because it
 * keeps (2,5) inside the wall. B is to move.
 */
function nearlySealedPosition(): GameState {
  const board = boardWithNeutral();
  for (let col = 0; col <= 5; col++) board[3][col] = "PLAYER_A";
  board[0][5] = "PLAYER_A";
  board[1][5] = "PLAYER_A";
  // (2,5) is the gap. B has a castle far away so it is not shut out entirely.
  board[7][1] = "PLAYER_B";
  return stateFrom(board, "B");
}

describe("findSealingMoves", () => {
  it("finds the single move that settles a large block, and sizes it correctly", () => {
    const state = nearlySealedPosition();
    const seals = findSealingMoves(state, "A");

    expect(seals.length).toBeGreaterThan(0);
    expect(seals[0].move).toEqual({ row: 2, col: 6 });
    // Rows 0-2 across columns 0-4, plus the gap at (2,5) itself.
    expect(seals[0].gained.length).toBe(16);
    // Plugging the gap directly is the smaller version of the same idea.
    expect(seals.map((s) => s.gained.length)).toContain(15);
  });

  it("credits nothing to a shape that encloses nothing", () => {
    const board = boardWithNeutral();
    board[4][1] = "PLAYER_A";
    board[4][2] = "PLAYER_A";
    board[8][8] = "PLAYER_B";
    const state = stateFrom(board, "A");

    // Two castles side by side in the open settle no cells at all.
    expect(findSealingMoves(state, "A")).toHaveLength(0);
  });

  it("gives a loose diagonal framework no credit until it actually closes", () => {
    const board = boardWithNeutral();
    board[1][6] = "PLAYER_A";
    board[3][7] = "PLAYER_A";
    board[5][6] = "PLAYER_A";
    board[7][7] = "PLAYER_A";
    board[8][0] = "PLAYER_B";
    const state = stateFrom(board, "A");

    // Wide and impressive-looking, but nothing is enclosed yet.
    expect(findSealingMoves(state, "A")).toHaveLength(0);
  });
});

describe("planTerritory", () => {
  it("flags an imminent large enclosure and offers both the point and a way in", () => {
    const state = nearlySealedPosition();
    const plan = planTerritory(state, "B");

    expect(plan.urgent).toBe(true);
    expect(plan.theirBestSeal?.gained.length).toBe(16);

    // Taking the point they need must be on the table...
    expect(plan.blockingMoves).toContainEqual({ type: "PLACE", row: 2, col: 6 });
    // ...along with living inside the area before it closes.
    expect(plan.blockingMoves.length).toBeGreaterThan(1);
  });

  it("stays quiet on an empty board", () => {
    expect(planTerritory(createInitialState(), "A").urgent).toBe(false);
  });

  it("is not provoked by a small enclosure", () => {
    const board = boardWithNeutral();
    // A can settle a single corner cell — true, but not worth abandoning plans for.
    board[0][1] = "PLAYER_A";
    board[5][5] = "PLAYER_B";
    const state = stateFrom(board, "B");

    expect(planTerritory(state, "B").urgent).toBe(false);
  });
});

describe("VERY_HARD against wide play", () => {
  it("answers an imminent 15-cell enclosure instead of playing elsewhere", () => {
    const state = nearlySealedPosition();
    const action = findBestMoveVeryHard(state, "B", 2000);
    expect(action.type).toBe("PLACE");

    const move = action as { row: number; col: number };
    const plan = planTerritory(state, "B");
    const answered = plan.blockingMoves.some(
      (a) => a.type === "PLACE" && a.row === move.row && a.col === move.col,
    );
    expect(answered).toBe(true);
  });
});
