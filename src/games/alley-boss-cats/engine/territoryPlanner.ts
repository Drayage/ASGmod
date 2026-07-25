import type { AIAction } from "../ai";
import { getLegalMoves, isLegalMove } from "../rules";
import { calculateTerritories, coordKeySet } from "../territory";
import { DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Board, Coord, GameState, Player } from "../types";

/**
 * Whole-board territory planning.
 *
 * The life-and-death reader is sharp inside a single capture fight but blind to
 * the game's other half: who is quietly enclosing the larger share of the
 * board. This supplies that half.
 *
 * Territory in this game is not a matter of influence or shape — a region
 * counts only when it is genuinely walled in by one side. So rather than
 * estimating who "feels" closer to each cell, this measures the real thing:
 * how many cells each side would actually settle by playing a given move, and
 * how few moves they are from settling a large area. A diagonal or a one-space
 * jump therefore earns nothing for its own sake; it scores only once it starts
 * closing real cells off.
 */

/** A single move that would settle a worthwhile number of cells. */
export interface SealingMove {
  move: Coord;
  /** Cells that become confirmed territory as a direct result. */
  gained: Coord[];
}

/** Cells `player` settles by playing `move`, or null if the move is illegal. */
function sealingGain(state: GameState, player: Player, move: Coord): Coord[] | null {
  if (!isLegalMove(state, move.row, move.col, player)) return null;

  const board: Board = state.board.map((row) => [...row]);
  board[move.row][move.col] = playerCell(player);
  const after = calculateTerritories(board);
  const before = coordKeySet(state.territories[player]);

  return after[player].filter(({ row, col }) => !before.has(`${row},${col}`));
}

/**
 * Every move that settles at least one cell for `player`, biggest first.
 * Exact — it asks the rules rather than guessing.
 */
export function findSealingMoves(state: GameState, player: Player): SealingMove[] {
  const found: SealingMove[] = [];
  for (const move of getLegalMoves(state, player)) {
    const gained = sealingGain(state, player, move);
    if (gained && gained.length > 0) found.push({ move, gained });
  }
  return found.sort((a, b) => b.gained.length - a.gained.length);
}

/** Moves worth testing as the first half of a two-move plan: near existing
 * castles, where walls actually get built. */
function nearbyMoves(state: GameState, player: Player, limit: number): Coord[] {
  const scored = getLegalMoves(state, player).map((move) => {
    let neighbours = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const r = move.row + dr;
      const c = move.col + dc;
      if (!inBounds(r, c)) {
        neighbours += 1; // a wall is as good as a castle for enclosing
        continue;
      }
      if (state.board[r][c] !== "EMPTY") neighbours += 1;
    }
    return { move, neighbours };
  });
  return scored
    .filter((s) => s.neighbours > 0)
    .sort((a, b) => b.neighbours - a.neighbours)
    .slice(0, limit)
    .map((s) => s.move);
}

const TWO_MOVE_BRANCH = 14;

/** The most cells `player` could settle within two of their own moves, and the
 * move that starts it. Assumes the opponent does not interfere, which is what
 * makes it a *threat* rather than a promise. */
function bestTwoMovePlan(state: GameState, player: Player): SealingMove | null {
  let best: SealingMove | null = null;

  for (const first of nearbyMoves(state, player, TWO_MOVE_BRANCH)) {
    const board: Board = state.board.map((row) => [...row]);
    board[first.row][first.col] = playerCell(player);
    const midTerritories = calculateTerritories(board);
    const mid: GameState = {
      ...state,
      board,
      territories: midTerritories,
      currentPlayer: player,
    };

    for (const second of getLegalMoves(mid, player)) {
      const gained = sealingGain(mid, player, second);
      if (!gained) continue;
      // Count against the position as it stands now, not the halfway point.
      const total = gained.length + (midTerritories[player].length - state.territories[player].length);
      if (!best || total > best.gained.length) {
        best = { move: first, gained: new Array(total).fill(second) };
      }
    }
  }

  return best;
}

export interface TerritoryPlan {
  /** Biggest area the opponent settles in one move, if any. */
  theirBestSeal: SealingMove | null;
  /** Biggest area they could settle across two moves. */
  theirTwoMovePlan: SealingMove | null;
  /** My own best sealing move. */
  myBestSeal: SealingMove | null;
  /** Moves that take away or break into what they are about to enclose. */
  blockingMoves: AIAction[];
  /** Moves that settle ground for me. */
  expansionMoves: AIAction[];
  /**
   * The opponent is about to settle enough ground that answering it should
   * outrank whatever the general evaluation would otherwise drift towards.
   */
  urgent: boolean;
}

/** A large swing settled in a move or two is worth answering. */
const URGENT_CONFIRM_SIZE = 8;
/** Big areas are worth contesting even when they take a little longer to seal. */
const LARGE_AREA = 10;

function toAction({ row, col }: Coord): AIAction {
  return { type: "PLACE", row, col };
}

/**
 * Cells inside the area they are about to enclose, where a castle of mine
 * would sit with room to breathe. Taking the sealing point itself is the
 * obvious answer; living inside is the one that kills the area outright.
 */
function invasionPoints(state: GameState, player: Player, area: Coord[]): Coord[] {
  return area.filter(({ row, col }) => {
    if (!isLegalMove(state, row, col, player)) return false;
    let open = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (inBounds(r, c) && state.board[r][c] === "EMPTY") open += 1;
    }
    return open >= 2; // somewhere to run once they answer
  });
}

export function planTerritory(state: GameState, player: Player): TerritoryPlan {
  const foe = opponent(player);

  const theirSeals = findSealingMoves(state, foe);
  const theirBestSeal = theirSeals[0] ?? null;
  const mySeals = findSealingMoves(state, player);
  const myBestSeal = mySeals[0] ?? null;

  const oneMoveThreat = theirBestSeal?.gained.length ?? 0;
  const theirTwoMovePlan =
    oneMoveThreat >= URGENT_CONFIRM_SIZE ? null : bestTwoMovePlan(state, foe);
  const twoMoveThreat = theirTwoMovePlan?.gained.length ?? 0;

  const urgent =
    oneMoveThreat >= URGENT_CONFIRM_SIZE ||
    twoMoveThreat >= Math.max(URGENT_CONFIRM_SIZE, LARGE_AREA);

  const blocking: Coord[] = [];
  if (theirBestSeal) {
    // Occupy the point they need, or move in behind it.
    if (isLegalMove(state, theirBestSeal.move.row, theirBestSeal.move.col, player)) {
      blocking.push(theirBestSeal.move);
    }
    blocking.push(...invasionPoints(state, player, theirBestSeal.gained));
  }
  if (theirTwoMovePlan && isLegalMove(state, theirTwoMovePlan.move.row, theirTwoMovePlan.move.col, player)) {
    blocking.push(theirTwoMovePlan.move);
  }

  const expansion = mySeals.slice(0, 6).map((s) => s.move);

  const dedupe = (cells: Coord[]): AIAction[] => {
    const seen = new Set<string>();
    const out: AIAction[] = [];
    for (const cell of cells) {
      const k = `${cell.row},${cell.col}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(toAction(cell));
    }
    return out;
  };

  return {
    theirBestSeal,
    theirTwoMovePlan,
    myBestSeal,
    blockingMoves: dedupe(blocking),
    expansionMoves: dedupe(expansion),
    urgent,
  };
}
