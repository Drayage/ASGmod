import { tuning } from "../ai";
import type { AIAction } from "../ai";
import { getConnectedGroup, getGroupLiberties } from "../groups";
import { applyMove, getLegalMoves, isLegalMove } from "../rules";
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

/**
 * How far a castle's pull reaches when judging who is *heading towards* owning
 * open ground. Only used for the running comparison of the two sides — never
 * to put a value on an area, which was a mistake an earlier version made.
 */
const INFLUENCE_REACH = 3;

/** Breadth-first distance from `player`'s castles through open ground. */
function distanceField(board: Board, player: Player): number[][] {
  const size = board.length;
  const dist: number[][] = Array.from({ length: size }, () =>
    Array<number>(size).fill(Number.POSITIVE_INFINITY),
  );
  const own = playerCell(player);
  const queue: Coord[] = [];

  const open = (r: number, c: number) => inBounds(r, c) && board[r][c] === "EMPTY";

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (board[row][col] !== own) continue;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (!open(r, c) || dist[r][c] <= 1) continue;
        dist[r][c] = 1;
        queue.push({ row: r, col: c });
      }
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const { row, col } = queue[head];
    if (dist[row][col] >= INFLUENCE_REACH) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!open(r, c) || dist[r][c] <= dist[row][col] + 1) continue;
      dist[r][c] = dist[row][col] + 1;
      queue.push({ row: r, col: c });
    }
  }

  return dist;
}

/**
 * Open cells this side is strictly closer to — the ground it is heading
 * towards owning. Counted plainly, one point per cell: a lead here is a
 * reason to act, not a number to multiply up.
 *
 * This exists because settled territory alone is far too late a signal. An
 * opponent mapping out a large framework settles nothing for many moves, so an
 * engine watching only confirmed territory sees no reason to interfere and
 * quietly tidies its own position while the board is given away.
 */
export function influenceCount(board: Board): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  for (const owner of influenceOwnerMap(board)) {
    if (owner === "A") counts.A += 1;
    else if (owner === "B") counts.B += 1;
  }
  return counts;
}

/**
 * The same judgement `influenceCount` sums up, kept per cell instead of
 * totalled: for every point on the board, the side heading towards owning it,
 * or null where nobody is (an occupied cell, or open ground both sides reach
 * equally). Row-major, one entry per point.
 *
 * Split out so the ownership dataset can score this signal cell by cell
 * against what each cell actually became — the count alone cannot say whether
 * the reach it measures lands where the territory ends up. `influenceCount` is
 * defined in terms of this, so the two can never disagree.
 */
export function influenceOwnerMap(board: Board): Array<Player | null> {
  const distA = distanceField(board, "A");
  const distB = distanceField(board, "B");
  const owners: Array<Player | null> = [];

  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board.length; col++) {
      if (board[row][col] !== "EMPTY") {
        owners.push(null);
        continue;
      }
      const a = distA[row][col];
      const b = distB[row][col];
      // Contested middle belongs to nobody yet.
      owners.push(a === b ? null : a < b ? "A" : "B");
    }
  }
  return owners;
}

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
export function bestTwoMovePlan(state: GameState, player: Player): SealingMove | null {
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
   * The opponent is about to settle a large area within a move or two. This is
   * concrete enough to override the search's own judgement.
   */
  imminent: boolean;
  /**
   * Either an imminent seal, or simply falling behind on the ground each side
   * is heading towards. The second is a soft signal: it is worth *offering*
   * contesting moves, but not worth overriding the search, which already
   * weighs the same influence in its evaluation.
   */
  urgent: boolean;
}

/** A large swing settled in a move or two is worth answering. Read through the
 * tuning object so the arena can play two engines that differ only in this. */
const urgentConfirmSize = () => tuning.urgentConfirmSize;
/** Big areas are worth contesting even when they take a little longer to seal. */
const LARGE_AREA = 10;
/** Trailing by this much open ground means the board is being given away. */
const INFLUENCE_DEFICIT = 6;

function toAction({ row, col }: Coord): AIAction {
  return { type: "PLACE", row, col };
}

/**
 * The fewest escape routes an invading cat may land with.
 *
 * Two is not enough, however tempting the point looks. The opponent answers by
 * taking one, and a cat down to a single route is captured next move — the
 * whole game, lost for one greedy castle. At three, their best single answer
 * still leaves somewhere to run.
 */
const MIN_INVASION_LIBERTIES = 3;

/**
 * Can a cat played at `move` actually live there?
 *
 * Deciding to invade is the easy half; surviving it is the half this checks.
 * A cat sent into ground the opponent controls has to do one of two things —
 * join up with cats that are already out there, or land with enough room to
 * build a home before it is attacked. Anything else is a gift.
 *
 * This is a shape test, not a search: the life-and-death reader that runs
 * afterwards is time-boxed, and under a real move budget it is easily starved
 * into missing exactly this. A structural rule costs almost nothing and never
 * runs out of time.
 */
/**
 * What it costs to leave a sealing move for later, in cells.
 *
 * `findSealingMoves` says how much ground a move settles. It does not say
 * whether the move needs playing *now*, and those are different questions. A
 * seal the opponent cannot really take away — block it and the same area still
 * comes in a cell smaller — is ground already banked; spending a turn on it
 * buys almost nothing, and the turn was the only thing that could have started
 * another area somewhere else.
 *
 * That gap is why making the engine convert sooner made it convert less. Given
 * a term that valued settled ground more highly it took its seals nine plies
 * earlier and finished with 4.69 cells against its opponent's 5.47: it was
 * cashing in points that were not going anywhere and paying a move each time.
 *
 * So: play the opponent onto the sealing point, then ask what the same region
 * is still worth. The difference is the urgency. Near zero means the move can
 * wait. Large means it is the move.
 *
 * Only follow-ups touching the original region count. The player can always
 * seal something else after being blocked, but that is a different area and
 * would make every seal look safe to postpone.
 */
export function sealingUrgency(state: GameState, player: Player, seal: SealingMove): number {
  const now = seal.gained.length;
  const foe = opponent(player);
  if (!isLegalMove(state, seal.move.row, seal.move.col, foe)) return now;

  const blocked = applyMove(
    { ...state, currentPlayer: foe },
    seal.move.row,
    seal.move.col,
  );
  // A block that ends the game leaves nothing to come back for.
  if (blocked.winner) return now;

  const region = coordKeySet(seal.gained);
  let best = 0;
  for (const follow of findSealingMoves(blocked, player)) {
    if (!follow.gained.some((cell) => region.has(`${cell.row},${cell.col}`))) continue;
    best = Math.max(best, follow.gained.length);
  }
  return now - best;
}

export function invasionIsViable(state: GameState, player: Player, move: Coord): boolean {
  if (!isLegalMove(state, move.row, move.col, player)) return false;

  const board: Board = state.board.map((row) => [...row]);
  board[move.row][move.col] = playerCell(player);

  const group = getConnectedGroup(board, move.row, move.col);
  const liberties = getGroupLiberties(board, group);
  if (liberties.size < MIN_INVASION_LIBERTIES) return false;

  // Joined up with friendly cats already in the area: an extension, not a lone
  // castle dropped behind enemy lines.
  if (group.length > 1) return true;

  // Standing alone, it needs somewhere to grow into — an escape route that
  // itself opens onto more empty ground, rather than three separate dead ends.
  return [...liberties].some((liberty) => {
    const [r, c] = liberty.split(",").map(Number);
    for (const [dr, dc] of DIRECTIONS) {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc) && board[nr][nc] === "EMPTY") return true;
    }
    return false;
  });
}

/**
 * Cells inside the area they are about to enclose where a castle of mine could
 * live. Taking the sealing point itself is the obvious answer; living inside is
 * the one that kills the area outright — but only if it survives the attempt.
 */
function invasionPoints(state: GameState, player: Player, area: Coord[]): Coord[] {
  return area.filter((cell) => invasionIsViable(state, player, cell));
}

/**
 * Legal points sitting in ground the opponent currently leads, preferring
 * those with room to live. These are the moves that argue about the board
 * instead of conceding it.
 */
function contestingMoves(state: GameState, player: Player): Coord[] {
  const foe = opponent(player);
  const distMine = distanceField(state.board, player);
  const distTheirs = distanceField(state.board, foe);

  const contested: Array<{ move: Coord; room: number }> = [];
  for (let row = 0; row < state.board.length; row++) {
    for (let col = 0; col < state.board.length; col++) {
      if (state.board[row][col] !== "EMPTY") continue;
      if (!(distTheirs[row][col] < distMine[row][col])) continue;
      // Pushing into ground they lead is an invasion like any other, and has to
      // clear the same survival test — arguing about the board is only worth
      // anything if the cat making the argument is still there next turn.
      if (!invasionIsViable(state, player, { row, col })) continue;

      let room = 0;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && state.board[r][c] === "EMPTY") room += 1;
      }
      contested.push({ move: { row, col }, room });
    }
  }

  return contested
    .sort((a, b) => b.room - a.room)
    .slice(0, 10)
    .map((c) => c.move);
}

export function planTerritory(state: GameState, player: Player): TerritoryPlan {
  const foe = opponent(player);

  const theirSeals = findSealingMoves(state, foe);
  const theirBestSeal = theirSeals[0] ?? null;
  const mySeals = findSealingMoves(state, player);
  const myBestSeal = mySeals[0] ?? null;

  const oneMoveThreat = theirBestSeal?.gained.length ?? 0;
  const theirTwoMovePlan =
    oneMoveThreat >= urgentConfirmSize() ? null : bestTwoMovePlan(state, foe);
  const twoMoveThreat = theirTwoMovePlan?.gained.length ?? 0;

  // An imminent seal is the loud case, but it is not the common one. A player
  // mapping out the board with loose diagonals settles nothing for many moves,
  // so gating purely on "they are about to confirm eight cells" left this
  // stage dormant for entire games — measured at 0 firings across 135 moves.
  // Falling behind on the ground each side is heading towards is the signal
  // that actually shows up while there is still time to do something.
  const influence = influenceCount(state.board);
  const behindOnInfluence = influence[foe] - influence[player] >= INFLUENCE_DEFICIT;

  const imminent =
    oneMoveThreat >= urgentConfirmSize() ||
    twoMoveThreat >= Math.max(urgentConfirmSize(), LARGE_AREA);
  const urgent = imminent || behindOnInfluence;

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

  // Falling behind with nothing concrete to block: push into the ground they
  // are heading towards rather than tidying our own position.
  if (behindOnInfluence && blocking.length === 0) {
    blocking.push(...contestingMoves(state, player));
  }

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
    imminent,
    blockingMoves: dedupe(blocking),
    expansionMoves: dedupe(expansion),
    urgent,
  };
}
