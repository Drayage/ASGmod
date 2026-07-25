import { getAllGroups, getGroupLiberties } from "./groups";
import { applyMove, getLegalMoves, passTurn } from "./rules";
import { influenceCount } from "./engine/territoryPlanner";
import { coordKeySet } from "./territory";
import { FIRST_PLAYER_MARGIN, opponent } from "./types";
import type { Coord, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD" | "VERY_HARD";

/** Difficulties whose move is computed by the search engine in a worker. */
export type SearchDifficulty = Extract<Difficulty, "HARD" | "VERY_HARD">;

export type AIAction = { type: "PLACE"; row: number; col: number } | { type: "PASS" };

export function applyAction(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

/**
 * What a cell of open ground is worth next to a cell already settled — it still
 * has to be won, so it counts for less, but not for nothing.
 *
 * Swept in the arena at 0.12 / 0.30 / 0.50. Over 12-game matches 0.30 looked
 * like a clear win (VERY_HARD vs HARD scoring 92% / 100% / 75%), but re-running
 * the top two over 24 games put them at 67% and 63% — that gap was sampling
 * noise, not strength, so the original value stands. 0.50 was genuinely worse:
 * that far up, open ground outweighs shape and the search walks into captures
 * chasing it.
 *
 * Worth knowing before tuning this again: the term is deliberately timid, and it
 * can be too timid to see a loss coming. On a position where 고등어냥 trailed by
 * 22 cells of open ground, the deficit priced at 2.64 — less than the three
 * cells 치즈냥 owes — so the count read as *ahead* while a whole side of the
 * board was being mapped out against it. Raising the weight does not fix that;
 * it just trades the error for a worse one.
 */
const INFLUENCE_TO_TERRITORY = 0.12;

/**
 * How far ahead `player` is *on the actual win condition*, in cells.
 * Positive means they currently take the territory count.
 *
 * The evaluation used to score both sides' territory symmetrically and never
 * mention the first-player margin at all, so the engine had no idea whether it
 * was winning: as 고등어냥 it did not know a tie goes to it, and as 치즈냥 it
 * did not know three cells were owed. Without that, "am I ahead, and should I
 * be consolidating or forcing matters?" is a question it could not even ask.
 */
export function projectedMargin(state: GameState, player: Player): number {
  const influence = influenceCount(state.board);
  const projected = (side: Player) =>
    state.territories[side].length + influence[side] * INFLUENCE_TO_TERRITORY;

  const lead = projected("A") - projected("B");
  // 치즈냥 (A) moves first and must finish at least FIRST_PLAYER_MARGIN ahead;
  // anything short of that is a win for 고등어냥 (B).
  return player === "A" ? lead - FIRST_PLAYER_MARGIN : FIRST_PLAYER_MARGIN - lead;
}


interface ShapeStats {
  totalLiberties: number;
  /** Groups down to a single escape route — one move from being destroyed. */
  atari: number;
  /** Groups down to two escape routes — one move from atari. */
  nearAtari: number;
  /** Groups with a liberty inside their owner's confirmed territory. Nobody
   * may ever play there, so that breath is permanent and the group can never
   * be captured — the local equivalent of an eye. */
  immortal: number;
  connectedBonus: number;
  isolated: number;
}

/** One pass over a player's groups collecting everything the evaluation
 * needs. Computing these separately re-walked the whole board per term. */
function shapeStats(state: GameState, player: Player): ShapeStats {
  const stats: ShapeStats = {
    totalLiberties: 0,
    atari: 0,
    nearAtari: 0,
    immortal: 0,
    connectedBonus: 0,
    isolated: 0,
  };
  const ownTerritory = coordKeySet(state.territories[player]);
  for (const group of getAllGroups(state.board, player)) {
    const liberties = getGroupLiberties(state.board, group);
    stats.totalLiberties += liberties.size;
    // Territory only forms with a single-colour border, so a liberty that is
    // this player's territory can never be filled by anyone: the group is
    // safe for the rest of the game, whatever its liberty count says.
    let immortal = false;
    for (const liberty of liberties) {
      if (ownTerritory.has(liberty)) {
        immortal = true;
        break;
      }
    }
    if (immortal) stats.immortal += 1;
    else if (liberties.size === 1) stats.atari += 1;
    else if (liberties.size === 2) stats.nearAtari += 1;
    stats.connectedBonus += group.length - 1;
    if (group.length === 1) stats.isolated += 1;
  }
  return stats;
}

/** Just short of a decided game — used for positions that are lost/won barring
 * a miracle, so search still prefers a real win over a merely winning shape. */
const NEAR_DECISIVE = 400_000;

export function evaluateState(state: GameState, aiPlayer: Player): number {
  if (state.winner === aiPlayer) return 1_000_000;
  if (state.winner && state.winner !== aiPlayer) return -1_000_000;

  const opp = opponent(aiPlayer);
  const mine = shapeStats(state, aiPlayer);
  const theirs = shapeStats(state, opp);

  // Destroying one castle wins outright, so a group left in atari with the
  // opponent to move is effectively already lost. Encoding that here gives
  // the search a ply of tactical sight for free at every leaf.
  if (mine.atari > 0 && state.currentPlayer === opp) return -NEAR_DECISIVE;
  if (theirs.atari > 0 && state.currentPlayer === aiPlayer) return NEAR_DECISIVE;

  return (
    // One number for the whole territory question: settled ground, ground each
    // side is heading towards, and the first-player margin that decides who
    // the count actually favours.
    projectedMargin(state, aiPlayer) * 100 +
    mine.totalLiberties * 5 -
    theirs.totalLiberties * 6 +
    theirs.atari * 45 -
    mine.atari * 90 +
    // A two-liberty group is one forcing move from atari — the shape the AI
    // used to wander into happily.
    theirs.nearAtari * 16 -
    mine.nearAtari * 34 +
    // A permanently alive group is a lasting asset, for either side.
    mine.immortal * 30 -
    theirs.immortal * 30 +
    mine.connectedBonus * 3 -
    mine.isolated * 5
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

/**
 * Does the opponent have a reply to `state` that wins immediately for them?
 *
 * Computed directly instead of simulating every opponent move (which cost
 * ~460ms per getSafeActions call and was the single largest drain on every
 * difficulty's budget). Only two immediate wins exist:
 *  - capture: one of our groups has exactly one liberty, and the opponent may
 *    legally fill it. Capture-priority makes that always legal unless the
 *    liberty is our confirmed territory, where nobody may play — that group
 *    is permanently alive, not in danger.
 *  - pass-out: we just passed (consecutivePasses === 1), so the opponent can
 *    pass back, end the game, and win the territory count.
 */
export function opponentHasImmediateWin(state: GameState, aiPlayer: Player): boolean {
  if (state.winner) return false;

  const ownTerritory = coordKeySet(state.territories[aiPlayer]);
  for (const group of getAllGroups(state.board, aiPlayer)) {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size !== 1) continue;
    const [only] = liberties;
    if (!ownTerritory.has(only)) return true;
  }

  if (state.consecutivePasses === 1) {
    const ended = passTurn(state);
    if (ended.winner && ended.winner !== aiPlayer) return true;
  }

  return false;
}

export interface SafeActions {
  /** A move that wins on the spot, if one exists — always play it. */
  winningMove: AIAction | null;
  /** Moves that don't hand the opponent an immediate capture win. Falls back
   * to every legal action when every move loses, so callers always get
   * something playable. */
  pool: AIAction[];
}

/**
 * Shared tactical floor for every difficulty: take a win when it's there, and
 * otherwise never volunteer a move that lets the opponent win next turn.
 * HARD layers its deeper search on top of this rather than rediscovering it,
 * so a shallow search can never drop below NORMAL's tactical standard.
 */
export function getSafeActions(state: GameState, player: Player): SafeActions {
  const actions = candidateActions(state, player);
  const winningMove = immediateWin(state, player, actions);
  if (winningMove) return { winningMove, pool: actions };

  const safe = actions.filter((action) => {
    const next = applyAction(state, action);
    // A pass that ends the game against us is a loss, not a "safe" move.
    if (next.winner) return next.winner === player;
    return !opponentHasImmediateWin(next, player);
  });
  return { winningMove: null, pool: safe.length > 0 ? safe : actions };
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
 * Handles EASY and NORMAL only. HARD and VERY_HARD run the search in
 * engine/minimax.ts, normally off the main thread via aiWorker.ts — callers
 * must route those there instead of calling this function.
 */
export function getAIMove(
  state: GameState,
  player: Player,
  difficulty: Exclude<Difficulty, SearchDifficulty>,
): AIAction {
  const { winningMove, pool } = getSafeActions(state, player);
  if (winningMove) return winningMove;

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
    if (afterMine.winner) {
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
