import { pieceSize } from "./pieces";
import { countOpenCorners, getAllLegalPlacements } from "./rules";
import { opponent } from "./types";
import type { Action, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
};

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function chooseEasyMove(state: GameState, player: Player): Action {
  return randomChoice(getAllLegalPlacements(state, player));
}

function chooseNormalMove(state: GameState, player: Player): Action {
  const legal = getAllLegalPlacements(state, player);
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

/** Board-only simulation of a placement, skipping the turn/hand bookkeeping
 * `applyAction` does — the heuristic below only ever looks at the board. */
function boardAfter(state: GameState, action: Action, player: Player): GameState {
  const board = state.board.map((row) => [...row]);
  for (const c of action.cells) board[c.row][c.col] = player;
  return { ...state, board };
}

/** Weighs bigger pieces first (getting large, hard-to-place pieces down
 * early matters a lot in Blokus), then prefers placements that open up
 * more future corners for this side while closing off fewer for the
 * opponent — a cheap proxy for mobility since a true multi-ply search is
 * impractical with Blokus's branching factor. */
function chooseHardMove(state: GameState, player: Player): Action {
  const legal = getAllLegalPlacements(state, player);
  const rival = opponent(player);
  let best = legal[0];
  let bestScore = -Infinity;
  for (const action of legal) {
    const after = boardAfter(state, action, player);
    const score =
      pieceSize(action.pieceId) * 4 + countOpenCorners(after, player) - countOpenCorners(after, rival) * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

export function getAIMove(state: GameState, difficulty: Difficulty): Action {
  const player = state.currentPlayer;
  switch (difficulty) {
    case "EASY":
      return chooseEasyMove(state, player);
    case "NORMAL":
      return chooseNormalMove(state, player);
    case "HARD":
      return chooseHardMove(state, player);
  }
}
