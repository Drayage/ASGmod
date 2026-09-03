import { getAllLegalActions, materialValue, playAction } from "./rules";
import { opponent } from "./types";
import type { Action, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
};

function materialTotal(state: GameState, player: Player): number {
  let total = 0;
  for (const row of state.board) {
    for (const cell of row) {
      if (cell && cell.owner === player) total += materialValue(cell.type);
    }
  }
  for (const type of state.hands[player]) total += materialValue(type);
  return total;
}

const WIN_SCORE = 1_000_000;

/** Static evaluation from `player`'s perspective: material lead (board and
 * hand alike — a captured piece in hand is still worth having) plus a small
 * mobility term. Terminal states short-circuit to a fixed win/loss score. */
function evaluateState(state: GameState, player: Player): number {
  if (state.winner === player) return WIN_SCORE;
  if (state.winner) return -WIN_SCORE;

  const opp = opponent(player);
  const materialDiff = materialTotal(state, player) - materialTotal(state, opp);
  const mobilityDiff = getAllLegalActions(state, player).length - getAllLegalActions(state, opp).length;
  return materialDiff * 10 + mobilityDiff;
}

function pickWeighted(actions: Action[], weights: number[]): Action {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < actions.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return actions[i];
  }
  return actions[actions.length - 1];
}

/** What capturing with this action is worth, without applying it — 0 for a
 * drop or a non-capturing move. Used both to weight EASY's randomness and
 * to order moves for HARD's alpha-beta search. */
function captureValue(state: GameState, action: Action): number {
  if (action.kind === "DROP") return 0;
  const target = state.board[action.to.row][action.to.col];
  if (!target) return 0;
  return target.type === "LION" ? WIN_SCORE : materialValue(target.type);
}

/** Mostly-random move, lightly weighted toward capturing more valuable
 * pieces — never actively bad, but no lookahead. */
function chooseEasyMove(state: GameState): Action {
  const actions = getAllLegalActions(state);
  const weights = actions.map((a) => 1 + captureValue(state, a));
  return pickWeighted(actions, weights);
}

/** One-ply lookahead: scores each action by the resulting position's static
 * evaluation from the mover's perspective. */
function chooseNormalMove(state: GameState): Action {
  const player = state.currentPlayer;
  const actions = getAllLegalActions(state, player);

  let best: Action[] = [];
  let bestScore = -Infinity;
  for (const action of actions) {
    const { state: after } = playAction(state, action);
    const score = evaluateState(after, player);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = [action];
    } else if (Math.abs(score - bestScore) < 1e-9) {
      best.push(action);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}

function orderActions(state: GameState, actions: Action[]): Action[] {
  return [...actions].sort((a, b) => captureValue(state, b) - captureValue(state, a));
}

const HARD_TIME_BUDGET_MS = 900;
const HARD_MAX_DEPTH = 8;

function search(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  rootPlayer: Player,
  deadline: number,
): number {
  if (state.winner || depth === 0 || performance.now() > deadline) {
    return evaluateState(state, rootPlayer);
  }

  const toMove = state.currentPlayer;
  const actions = getAllLegalActions(state, toMove);
  if (actions.length === 0) return evaluateState(state, rootPlayer);

  const maximizing = toMove === rootPlayer;
  let value = maximizing ? -Infinity : Infinity;

  for (const action of orderActions(state, actions)) {
    const { state: after } = playAction(state, action);
    const score = search(after, depth - 1, alpha, beta, rootPlayer, deadline);
    if (maximizing) {
      value = Math.max(value, score);
      alpha = Math.max(alpha, value);
    } else {
      value = Math.min(value, score);
      beta = Math.min(beta, value);
    }
    if (beta <= alpha) break;
    if (performance.now() > deadline) break;
  }

  return value;
}

/** Iterative-deepening alpha-beta within a fixed time budget. The board is
 * tiny (12 squares, at most 4 pieces per side plus whatever's in hand), so
 * this reaches a meaningfully deep search well within budget. */
function chooseHardMove(state: GameState): Action {
  const player = state.currentPlayer;
  const actions = getAllLegalActions(state, player);
  if (actions.length === 1) return actions[0];

  const deadline = performance.now() + HARD_TIME_BUDGET_MS;
  let bestMove = actions[0];

  for (let depth = 1; depth <= HARD_MAX_DEPTH; depth++) {
    let depthBest = bestMove;
    let depthBestScore = -Infinity;
    let ranOutOfTime = false;

    for (const action of orderActions(state, actions)) {
      if (performance.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      const { state: after } = playAction(state, action);
      const score = search(after, depth - 1, -Infinity, Infinity, player, deadline);
      if (score > depthBestScore) {
        depthBestScore = score;
        depthBest = action;
      }
    }

    if (ranOutOfTime) break;
    bestMove = depthBest;
    if (depthBestScore >= WIN_SCORE) break;
  }

  return bestMove;
}

export function getAIMove(state: GameState, difficulty: Difficulty): Action {
  switch (difficulty) {
    case "EASY":
      return chooseEasyMove(state);
    case "NORMAL":
      return chooseNormalMove(state);
    case "HARD":
      return chooseHardMove(state);
  }
}
