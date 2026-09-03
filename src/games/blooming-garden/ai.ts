import { countFlowers, getAllLegalMoves, playMove } from "./rules";
import { opponent, playerCell } from "./types";
import type { Action, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
};

/** How many enemy flowers `action` would convert for `player`, found by
 * diffing flower counts rather than re-deriving the conversion rule here. */
function capturedByMove(state: GameState, action: Action, player: Player, before: number): number {
  const { state: after } = playMove(state, action);
  const placed = action.type === "CLONE" ? 1 : 0;
  return countFlowers(after)[player] - before - placed;
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

/** Mostly-random move, lightly weighted toward whichever move converts more
 * enemy flowers — never actively bad, but no lookahead. */
function chooseEasyMove(state: GameState): Action {
  const player = state.currentPlayer;
  const moves = getAllLegalMoves(state, player);
  const before = countFlowers(state)[player];
  const weights = moves.map((m) => 1 + Math.max(0, capturedByMove(state, m, player, before)) * 2);
  return pickWeighted(moves, weights);
}

/**
 * One-ply lookahead: scores each move by flowers captured, a small bonus for
 * cloning (it grows the garden, a jump only relocates it), a little credit
 * for mobility left behind, and a penalty for the single biggest capture the
 * opponent could answer with. Mirrors the "보통" formula in the design doc.
 */
function chooseNormalMove(state: GameState): Action {
  const player = state.currentPlayer;
  const opp = opponent(player);
  const moves = getAllLegalMoves(state, player);
  const before = countFlowers(state)[player];

  let best: Action[] = [];
  let bestScore = -Infinity;

  for (const move of moves) {
    const { state: after } = playMove(state, move);
    const captured = countFlowers(after)[player] - before - (move.type === "CLONE" ? 1 : 0);
    const myMobility = getAllLegalMoves(after, player).length;

    let opponentBestReply = 0;
    if (!after.winner && after.currentPlayer === opp) {
      const opponentBefore = countFlowers(after)[opp];
      for (const reply of getAllLegalMoves(after, opp)) {
        const { state: afterReply } = playMove(after, reply);
        const replyCaptured =
          countFlowers(afterReply)[opp] - opponentBefore - (reply.type === "CLONE" ? 1 : 0);
        if (replyCaptured > opponentBestReply) opponentBestReply = replyCaptured;
      }
    }

    const score = captured * 5 + (move.type === "CLONE" ? 2 : 0) + myMobility * 0.1 - opponentBestReply * 2;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = [move];
    } else if (Math.abs(score - bestScore) < 1e-9) {
      best.push(move);
    }
  }

  return best[Math.floor(Math.random() * best.length)];
}

const WIN_SCORE = 1_000_000;
const HARD_TIME_BUDGET_MS = 900;
const HARD_MAX_DEPTH = 4;

function stabilityScore(state: GameState, player: Player): number {
  const size = state.board.length;
  const cell = playerCell(player);
  let score = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (state.board[row][col] !== cell) continue;
      const onEdgeRow = row === 0 || row === size - 1;
      const onEdgeCol = col === 0 || col === size - 1;
      if (onEdgeRow && onEdgeCol) score += 2; // corner: hardest to surround
      else if (onEdgeRow || onEdgeCol) score += 1;
    }
  }
  return score;
}

/** Static evaluation from `player`'s perspective: flower-count lead, mobility
 * lead, and a small bonus for holding edges/corners (fewer neighbours to
 * lose in one move). */
function evaluateState(state: GameState, player: Player): number {
  if (state.winner === player) return WIN_SCORE;
  if (state.winner === "DRAW") return 0;
  if (state.winner) return -WIN_SCORE;

  const opp = opponent(player);
  const counts = countFlowers(state);
  const flowerDiff = counts[player] - counts[opp];
  const mobilityDiff = getAllLegalMoves(state, player).length - getAllLegalMoves(state, opp).length;
  const stabilityDiff = stabilityScore(state, player) - stabilityScore(state, opp);

  return flowerDiff * 10 + mobilityDiff + stabilityDiff * 3;
}

/** Cheap capture estimate for move ordering — counts enemy flowers already
 * touching the target cell, without cloning the board. */
function quickCaptureEstimate(state: GameState, action: Action, player: Player): number {
  const opp = opponent(player);
  const opponentCell = playerCell(opp);
  const size = state.board.length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = action.row + dr;
      const c = action.col + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      if (state.board[r][c] === opponentCell) count++;
    }
  }
  return count;
}

function orderMoves(state: GameState, moves: Action[], player: Player): Action[] {
  return [...moves].sort(
    (a, b) => quickCaptureEstimate(state, b, player) - quickCaptureEstimate(state, a, player),
  );
}

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
  const moves = getAllLegalMoves(state, toMove);
  if (moves.length === 0) return evaluateState(state, rootPlayer);

  const maximizing = toMove === rootPlayer;
  let value = maximizing ? -Infinity : Infinity;

  for (const move of orderMoves(state, moves, toMove)) {
    const { state: after } = playMove(state, move);
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

/** Iterative-deepening alpha-beta within a fixed time budget, same shape as
 * the search used by the alley-boss-cats engine but sized for a much smaller
 * board and branching factor. */
function chooseHardMove(state: GameState): Action {
  const player = state.currentPlayer;
  const moves = getAllLegalMoves(state, player);
  if (moves.length === 1) return moves[0];

  const deadline = performance.now() + HARD_TIME_BUDGET_MS;
  let bestMove = moves[0];

  for (let depth = 1; depth <= HARD_MAX_DEPTH; depth++) {
    let depthBest = bestMove;
    let depthBestScore = -Infinity;
    let ranOutOfTime = false;

    for (const move of orderMoves(state, moves, player)) {
      if (performance.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      const { state: after } = playMove(state, move);
      const score = search(after, depth - 1, -Infinity, Infinity, player, deadline);
      if (score > depthBestScore) {
        depthBestScore = score;
        depthBest = move;
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
