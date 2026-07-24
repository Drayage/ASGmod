import { applyAction, candidateActions, evaluateState, rankByStaticEval } from "../ai";
import type { AIAction } from "../ai";
import { opponent } from "../types";
import type { Board, GameState, Player } from "../types";
import { TranspositionTable } from "./transpositionTable";

const WIN_SCORE = 1_000_000;
const MAX_DEPTH = 6;

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

/** Branch factor shrinks with remaining depth so the search stays inside
 * its time budget while still looking deep along the most promising line. */
function branchLimit(remainingDepth: number): number {
  if (remainingDepth >= 4) return 8;
  if (remainingDepth === 3) return 7;
  if (remainingDepth === 2) return 6;
  return 5;
}

function orderActions(
  state: GameState,
  playerToMove: Player,
  actions: AIAction[],
  tt: TranspositionTable,
): AIAction[] {
  const ranked = rankByStaticEval(state, playerToMove, actions);
  const hint = tt.getBestMoveKey(positionKey(state));
  if (!hint) return ranked;
  const hintIndex = ranked.findIndex((action) => actionKey(action) === hint);
  if (hintIndex <= 0) return ranked;
  const [hinted] = ranked.splice(hintIndex, 1);
  return [hinted, ...ranked];
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
  // Checked at entry, not just after each child, so a deadline hit unwinds
  // the whole call stack immediately instead of only after the current
  // ply's loop finishes — otherwise one deep first branch could run far
  // past the time budget before anything notices.
  if (state.winner || remainingDepth === 0 || Date.now() >= deadline) {
    return evaluateState(state, rootPlayer);
  }

  const actions = orderActions(state, playerToMove, candidateActions(state, playerToMove), tt).slice(
    0,
    branchLimit(remainingDepth),
  );
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

  if (bestActionKey) tt.setBestMoveKey(positionKey(state), bestActionKey);
  return best;
}

/** Iterative-deepening alpha-beta search, time-boxed to `timeLimitMs`.
 * Blocking/synchronous — run it inside aiWorker.ts so the main thread never
 * stalls on it. */
export function findBestMoveMinimax(
  rootState: GameState,
  aiPlayer: Player,
  timeLimitMs: number,
): AIAction {
  const deadline = Date.now() + timeLimitMs;
  const tt = new TranspositionTable();
  const rootActions = candidateActions(rootState, aiPlayer);
  let bestAction: AIAction = rootActions[0] ?? { type: "PASS" };

  for (let depth = 1; depth <= MAX_DEPTH && Date.now() < deadline; depth++) {
    const ordered = orderActions(rootState, aiPlayer, rootActions, tt);
    let bestScore = -Infinity;
    let bestAtThisDepth = ordered[0];

    for (const action of ordered) {
      const child = applyAction(rootState, action);
      const score = child.winner
        ? evaluateState(child, aiPlayer)
        : minimax(child, opponent(aiPlayer), depth - 1, -Infinity, Infinity, deadline, tt, aiPlayer);

      if (score > bestScore) {
        bestScore = score;
        bestAtThisDepth = action;
      }
      if (Date.now() >= deadline) break;
    }

    bestAction = bestAtThisDepth;
    if (bestScore >= WIN_SCORE) break; // forced win found, no need to search deeper
  }

  return bestAction;
}
