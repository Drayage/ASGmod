import { pieceSize } from "../pieces";
import { countOpenCorners, getAllLegalPlacements } from "./rules";
import { COLOR_OWNER } from "./types";
import type { Action, Color, GameState } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
};

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function chooseEasyMove(state: GameState, color: Color): Action {
  return randomChoice(getAllLegalPlacements(state, color));
}

function chooseNormalMove(state: GameState, color: Color): Action {
  const legal = getAllLegalPlacements(state, color);
  let bestSize = -1;
  let best: Action[] = [];
  for (const action of legal) {
    const size = pieceSize(action.pieceId);
    if (size > bestSize) {
      bestSize = size;
      best = [action];
    } else if (size === bestSize) {
      best.push(action);
    }
  }
  return randomChoice(best);
}

function boardAfter(state: GameState, action: Action, color: Color): GameState {
  const board = state.board.map((row) => [...row]);
  for (const c of action.cells) board[c.row][c.col] = color;
  return { ...state, board };
}

/** Same idea as the Duo AI's HARD heuristic — piece size first, then a
 * corner-mobility proxy — but split across the two rival colors instead of
 * one, since this color's owner faces two opposing colors, not one. */
function chooseHardMove(state: GameState, color: Color): Action {
  const legal = getAllLegalPlacements(state, color);
  const owner = COLOR_OWNER[color];
  const rivals = (["BLUE", "YELLOW", "RED", "GREEN"] as Color[]).filter((c) => COLOR_OWNER[c] !== owner);

  let best = legal[0];
  let bestScore = -Infinity;
  for (const action of legal) {
    const after = boardAfter(state, action, color);
    const rivalCorners = rivals.reduce((sum, rival) => sum + countOpenCorners(after, rival), 0);
    const score = pieceSize(action.pieceId) * 4 + countOpenCorners(after, color) - rivalCorners * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

export function getAIMove(state: GameState, difficulty: Difficulty): Action {
  const color = state.currentColor;
  switch (difficulty) {
    case "EASY":
      return chooseEasyMove(state, color);
    case "NORMAL":
      return chooseNormalMove(state, color);
    case "HARD":
      return chooseHardMove(state, color);
  }
}
