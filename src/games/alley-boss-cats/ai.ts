import { getAllGroups, getGroupLiberties } from "./groups";
import { applyMove, getLegalMoves, isGameOver, passTurn } from "./rules";
import { lockedCellKeys } from "./territory";
import { opponent } from "./types";
import type { Coord, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export type AIAction = { type: "PLACE"; row: number; col: number } | { type: "PASS" };

export function applyAction(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

function territoryCount(state: GameState, player: Player): number {
  return state.territories[player].length;
}

/** Loose (non-enclosure) estimate of "leaning your way" empty cells, used
 * only to steer the AI's evaluation — not the authoritative scoring rule. */
function potentialTerritory(state: GameState, player: Player): number {
  const opp = opponent(player);
  const locked = lockedCellKeys(state.territories);
  let count = 0;
  for (let row = 0; row < state.board.length; row++) {
    for (let col = 0; col < state.board[row].length; col++) {
      if (state.board[row][col] !== "EMPTY") continue;
      if (locked.has(`${row},${col}`)) continue;
      let bordersPlayer = false;
      let bordersOpponent = false;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= state.board.length || c < 0 || c >= state.board.length) continue;
        const value = state.board[r][c];
        if (value === (player === "A" ? "PLAYER_A" : "PLAYER_B")) bordersPlayer = true;
        if (value === (opp === "A" ? "PLAYER_A" : "PLAYER_B")) bordersOpponent = true;
      }
      if (bordersPlayer && !bordersOpponent) count++;
    }
  }
  return count;
}

function totalLiberties(state: GameState, player: Player): number {
  const locked = lockedCellKeys(state.territories);
  return getAllGroups(state.board, player).reduce(
    (sum, group) => sum + getGroupLiberties(state.board, group, locked).size,
    0,
  );
}

function groupsInAtari(state: GameState, player: Player): number {
  const locked = lockedCellKeys(state.territories);
  return getAllGroups(state.board, player).filter(
    (group) => getGroupLiberties(state.board, group, locked).size === 1,
  ).length;
}

function connectedGroupScore(state: GameState, player: Player): number {
  return getAllGroups(state.board, player).reduce((sum, group) => sum + (group.length - 1), 0);
}

function isolatedCatCount(state: GameState, player: Player): number {
  return getAllGroups(state.board, player).filter((group) => group.length === 1).length;
}

export function evaluateState(state: GameState, aiPlayer: Player): number {
  if (state.winner === aiPlayer) return 1_000_000;
  if (state.winner && state.winner !== aiPlayer) return -1_000_000;

  const opp = opponent(aiPlayer);
  return (
    territoryCount(state, aiPlayer) * 100 -
    territoryCount(state, opp) * 100 +
    potentialTerritory(state, aiPlayer) * 8 -
    potentialTerritory(state, opp) * 8 +
    totalLiberties(state, aiPlayer) * 5 -
    totalLiberties(state, opp) * 6 +
    groupsInAtari(state, opp) * 45 -
    groupsInAtari(state, aiPlayer) * 60 +
    connectedGroupScore(state, aiPlayer) * 3 -
    isolatedCatCount(state, aiPlayer) * 5
  );
}

export function candidateActions(state: GameState, player: Player): AIAction[] {
  const placements: AIAction[] = getLegalMoves(state, player).map(
    (coord: Coord): AIAction => ({ type: "PLACE", row: coord.row, col: coord.col }),
  );
  return [...placements, { type: "PASS" }];
}

function immediateWin(state: GameState, player: Player, actions: AIAction[]): AIAction | null {
  for (const action of actions) {
    const next = applyAction(state, action);
    if (next.winner === player) return action;
  }
  return null;
}

/** Does the opponent have a reply to `state` that wins immediately for them? */
function opponentHasImmediateWin(state: GameState, aiPlayer: Player): boolean {
  const opp = opponent(aiPlayer);
  if (isGameOver(state)) return false;
  for (const move of getLegalMoves(state, opp)) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner === opp) return true;
  }
  return false;
}

export function rankByStaticEval(state: GameState, player: Player, actions: AIAction[]): AIAction[] {
  return [...actions]
    .map((action) => ({ action, score: evaluateState(applyAction(state, action), player) }))
    .sort((a, b) => b.score - a.score)
    .map(({ action }) => action);
}

const EASY_TOP_N = 5;
const NORMAL_TOP_N = 10;
const NORMAL_REPLY_TOP_N = 8;

/**
 * Handles EASY and NORMAL only. HARD runs the deeper iterative-deepening
 * search in engine/minimax.ts, normally off the main thread via aiWorker.ts
 * — callers must route HARD there instead of calling this function.
 */
export function getAIMove(
  state: GameState,
  player: Player,
  difficulty: Exclude<Difficulty, "HARD">,
): AIAction {
  const actions = candidateActions(state, player);

  const winningMove = immediateWin(state, player, actions);
  if (winningMove) return winningMove;

  const safeActions = actions.filter(
    (action) => !opponentHasImmediateWin(applyAction(state, action), player),
  );
  const pool = safeActions.length > 0 ? safeActions : actions;

  if (difficulty === "EASY") {
    const ranked = rankByStaticEval(state, player, pool);
    const top = ranked.slice(0, EASY_TOP_N);
    return top[Math.floor(Math.random() * top.length)];
  }

  // NORMAL: shallow 2-ply minimax over the most promising candidates.
  const ranked = rankByStaticEval(state, player, pool).slice(0, NORMAL_TOP_N);
  const opp = opponent(player);

  let best = ranked[0];
  let bestScore = -Infinity;

  for (const action of ranked) {
    const afterMine = applyAction(state, action);
    if (afterMine.winner || isGameOver(afterMine)) {
      const score = evaluateState(afterMine, player);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
      continue;
    }

    const replies = rankByStaticEval(afterMine, opp, candidateActions(afterMine, opp)).slice(
      0,
      NORMAL_REPLY_TOP_N,
    );
    let worstForMe = Infinity;
    for (const reply of replies) {
      const afterReply = applyAction(afterMine, reply);
      worstForMe = Math.min(worstForMe, evaluateState(afterReply, player));
    }
    const score = replies.length > 0 ? worstForMe : evaluateState(afterMine, player);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }

  return best;
}
