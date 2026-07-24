import { applyAction, evaluateState, getSafeActions } from "../ai";
import type { AIAction } from "../ai";
import { opponent } from "../types";
import type { Board, GameState, Player } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";
import { localMoveScore, orderedCandidates } from "./moveOrdering";
import { TranspositionTable } from "./transpositionTable";

const WIN_SCORE = 1_000_000;
const MAX_DEPTH = 8;

const CELL_CODE: Record<Board[number][number], string> = {
  EMPTY: "E",
  PLAYER_A: "A",
  PLAYER_B: "B",
  NEUTRAL: "N",
};

function positionKey(state: GameState): string {
  let cells = "";
  for (const row of state.board) {
    for (const cell of row) cells += CELL_CODE[cell];
  }
  return `${cells}|${state.currentPlayer}|${state.consecutivePasses}`;
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

/** Branch factor narrows as the search deepens so the tree stays inside its
 * time budget while still following the critical line a long way. */
function branchLimit(remainingDepth: number): number {
  if (remainingDepth >= 5) return 14;
  if (remainingDepth === 4) return 12;
  if (remainingDepth === 3) return 10;
  if (remainingDepth === 2) return 8;
  return 6;
}

function minimax(
  state: GameState,
  playerToMove: Player,
  remainingDepth: number,
  alpha: number,
  beta: number,
  deadline: number,
  tt: TranspositionTable,
  rootPlayer: Player,
): number {
  // Checked on entry, not just between siblings, so a deadline unwinds the
  // whole stack at once instead of after the current ply finishes.
  if (state.winner || remainingDepth === 0 || Date.now() >= deadline) {
    return evaluateState(state, rootPlayer);
  }

  const key = positionKey(state);
  const actions = orderedCandidates(
    state,
    playerToMove,
    branchLimit(remainingDepth),
    tt.getBestMoveKey(key),
  );
  if (actions.length === 0) return evaluateState(state, rootPlayer);

  const maximizing = playerToMove === rootPlayer;
  let best = maximizing ? -Infinity : Infinity;
  let bestActionKey: string | null = null;

  for (const action of actions) {
    const child = applyAction(state, action);
    const value = child.winner
      ? evaluateState(child, rootPlayer)
      : minimax(child, opponent(playerToMove), remainingDepth - 1, alpha, beta, deadline, tt, rootPlayer);

    if (maximizing ? value > best : value < best) {
      best = value;
      bestActionKey = actionKey(action);
    }

    if (maximizing) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);

    if (beta <= alpha) break;
    if (Date.now() >= deadline) break;
  }

  if (bestActionKey) tt.setBestMoveKey(key, bestActionKey);
  return best;
}

const CAPTURE_READ_DEPTH = 7;
/** Share of the budget spent proving a kill before anything else. */
const ATTACK_READ_SHARE = 0.2;
/** Share spent screening our own candidates for forced losses. */
const DEFEND_READ_SHARE = 0.4;
/** Only the most promising moves are worth a full life-and-death screening;
 * checking all ~70 would consume the entire budget and leave the positional
 * search with nothing. */
const DEFEND_SCREEN_LIMIT = 18;

/**
 * VERY_HARD. Adds a life-and-death reader on top of the general search:
 * it first tries to prove a forced capture, and otherwise discards every
 * candidate that lets the opponent prove one against it. Only what survives
 * is handed to the positional search.
 */
export function findBestMoveVeryHard(
  rootState: GameState,
  aiPlayer: Player,
  timeLimitMs: number,
): AIAction {
  const deadline = Date.now() + timeLimitMs;

  const { winningMove, pool } = getSafeActions(rootState, aiPlayer);
  if (winningMove) return winningMove;
  if (pool.length <= 1) return pool[0] ?? { type: "PASS" };

  // 1. Can we kill something outright?
  const kill = findForcedCapture(
    rootState,
    aiPlayer,
    CAPTURE_READ_DEPTH,
    timeLimitMs * ATTACK_READ_SHARE,
  );
  if (kill) return kill.move;

  // 2. Drop moves that let the opponent kill one of ours by force. Screened in
  //    local-score order so the budget goes to the moves we'd actually play.
  const ranked = [...pool].sort((a, b) => {
    const sa = a.type === "PLACE" ? localMoveScore(rootState.board, a.row, a.col, aiPlayer) : -Infinity;
    const sb = b.type === "PLACE" ? localMoveScore(rootState.board, b.row, b.col, aiPlayer) : -Infinity;
    return sb - sa;
  });

  const screened = ranked.slice(0, DEFEND_SCREEN_LIMIT);
  const screenDeadline = Date.now() + timeLimitMs * DEFEND_READ_SHARE;
  const perMoveMs = Math.max(30, (timeLimitMs * DEFEND_READ_SHARE) / Math.max(1, screened.length));

  const survivors: AIAction[] = [];
  let screenedAll = true;
  for (const action of screened) {
    if (Date.now() >= screenDeadline) {
      screenedAll = false;
      break;
    }
    const next = applyAction(rootState, action);
    if (next.winner === aiPlayer) return action;
    if (next.winner) continue;
    if (!opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, perMoveMs)) {
      survivors.push(action);
    }
  }

  // If every screened move loses by force, don't corner ourselves into that
  // small set — hand the search the full pool and let it pick the best try.
  const searchPool = survivors.length > 0 ? survivors : ranked;
  // Moves we never got around to screening stay eligible; they are unproven,
  // not refuted.
  const finalPool = screenedAll ? searchPool : [...new Set([...searchPool, ...ranked])];

  const remaining = Math.max(300, deadline - Date.now());
  return searchWithin(rootState, aiPlayer, finalPool, remaining);
}

/** Iterative-deepening alpha-beta search, time-boxed to `timeLimitMs`.
 * Blocking/synchronous — run it inside aiWorker.ts so the main thread never
 * stalls on it. */
export function findBestMoveMinimax(
  rootState: GameState,
  aiPlayer: Player,
  timeLimitMs: number,
): AIAction {
  // Start from the same tactical floor every difficulty uses. Search then
  // only has to choose *among safe moves*, so running out of time degrades
  // to NORMAL's standard instead of to a blunder.
  const { winningMove, pool } = getSafeActions(rootState, aiPlayer);
  if (winningMove) return winningMove;
  if (pool.length <= 1) return pool[0] ?? { type: "PASS" };

  return searchWithin(rootState, aiPlayer, pool, timeLimitMs);
}

/** Iterative-deepening root search over an already-chosen candidate pool. */
function searchWithin(
  rootState: GameState,
  aiPlayer: Player,
  pool: AIAction[],
  timeLimitMs: number,
): AIAction {
  const deadline = Date.now() + timeLimitMs;
  const tt = new TranspositionTable();

  // Rank the pool locally once; deeper iterations reorder via the TT.
  const rootActions = [...pool].sort((a, b) => {
    const sa = a.type === "PLACE" ? localMoveScore(rootState.board, a.row, a.col, aiPlayer) : -Infinity;
    const sb = b.type === "PLACE" ? localMoveScore(rootState.board, b.row, b.col, aiPlayer) : -Infinity;
    return sb - sa;
  });

  let bestAction: AIAction = rootActions[0];

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    if (Date.now() >= deadline) break;

    let bestScore = -Infinity;
    let bestAtThisDepth = rootActions[0];
    let completed = true;

    // Try the previous iteration's choice first — it is usually still best,
    // which makes alpha tight immediately and prunes the rest hard.
    const ordered = [bestAction, ...rootActions.filter((a) => a !== bestAction)];

    for (const action of ordered) {
      if (Date.now() >= deadline) {
        completed = false;
        break;
      }

      const child = applyAction(rootState, action);
      // Pass the running best as alpha so later root moves can be pruned;
      // searching every root move from -Infinity throws away all the
      // cutoffs alpha-beta exists to provide.
      const score = child.winner
        ? evaluateState(child, aiPlayer)
        : minimax(child, opponent(aiPlayer), depth - 1, bestScore, Infinity, deadline, tt, aiPlayer);

      if (score > bestScore) {
        bestScore = score;
        bestAtThisDepth = action;
      }
    }

    // A depth cut short by the clock has only looked at a prefix of the move
    // list, so its "best" can be worse than the previous depth's fully
    // searched answer — discard it and keep the older, complete result.
    if (!completed) break;

    bestAction = bestAtThisDepth;
    if (bestScore >= WIN_SCORE) break; // forced win found, no need to search deeper
  }

  return bestAction;
}
