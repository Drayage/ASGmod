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
  return influenceCountFromMap(influenceOwnerMap(board));
}

/**
 * The same totals from a map already in hand.
 *
 * The breadth-first fill behind the map is the single most expensive thing the
 * evaluation does, so a caller wanting both the totals and something else off
 * the same map — `closableInfluence`, say — builds it once and asks twice
 * rather than paying for it again.
 */
export function influenceCountFromMap(owners: Array<Player | null>): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  for (const owner of owners) {
    if (owner === "A") counts.A += 1;
    else if (owner === "B") counts.B += 1;
  }
  return counts;
}

/**
 * The same totals, with each cell weighted by how big a region of influence it
 * belongs to.
 *
 * `projectedMarginFrom` prices open ground at one flat rate per cell. That rate
 * was tuned as a scalar and came out best as one, but a scalar cannot say what
 * the recorded games do: measured on this very map over 17 games decided by the
 * count, an influenced cell at turn 31 became its claimant's territory 85% of
 * the time when it sat in a region of five to seven cells and 31% when the
 * region ran to twelve or more. The curve is the same for both players; what
 * differs is that the engine is the one holding the sprawling regions.
 *
 * So the flat rate systematically overprices exactly the middle-game frame the
 * engine keeps and cannot close. The weights below are relative and chosen to
 * leave the average cell near 1, so this changes the shape of the term without
 * moving its scale — the scale has already been measured and is not what is
 * wrong with it.
 */
export const LARGE_INFLUENCE_REGION = 12;
export const SMALL_REGION_WEIGHT = 1.1;
export const LARGE_REGION_WEIGHT = 0.55;

export function influenceCountWeightedFromMap(
  owners: Array<Player | null>,
  size = Math.round(Math.sqrt(owners.length)),
): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  const seen = new Uint8Array(owners.length);
  const at = (row: number, col: number) => owners[row * size + col];

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const side = at(row, col);
      if (!side || seen[row * size + col]) continue;
      const stack: Array<[number, number]> = [[row, col]];
      seen[row * size + col] = 1;
      let region = 0;
      while (stack.length) {
        const [r, c] = stack.pop()!;
        region += 1;
        for (const [dr, dc] of DIRECTIONS) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
          const index = nr * size + nc;
          if (seen[index] || owners[index] !== side) continue;
          seen[index] = 1;
          stack.push([nr, nc]);
        }
      }
      counts[side] +=
        region * (region >= LARGE_INFLUENCE_REGION ? LARGE_REGION_WEIGHT : SMALL_REGION_WEIGHT);
    }
  }
  return counts;
}

/**
 * Open ground priced as cells it is actually expected to become.
 *
 * The shipped term prices every influenced cell at a flat 0.12 of a settled
 * cell. Measured against what those cells became — 17 games decided by the
 * count, 922 positions, ~37,000 cell observations — no cell anywhere on the
 * board converts that badly:
 *
 *   stones    1-2   3-4   5-7  8-11  12-17   18+
 *    0-19    0.46  0.47  0.62  0.57   0.40  0.24
 *   20-29    0.57  0.64  0.85  0.65   0.45  0.26
 *   30-39    0.70  0.84  0.84  0.65   0.34  0.39
 *     40+    0.93  0.95  0.98  0.94   0.77     -
 *
 * The pooled rate is 0.57. Two things are wrong with 0.12 at once, and fixing
 * either alone fails: the scale is roughly five times too low, and the shape is
 * missing, so a flat raise amplifies the estimate most where it is least
 * deserved — the sprawling eighteen-plus regions that convert at a quarter, and
 * that the engine is the one holding. Raising the scalar was tried before and
 * traded the error for a worse one; reshaping while preserving the scale was
 * tried after and moved a candidate move by 3.5 points where the gap to the
 * next one is 36.
 *
 * So this returns expected cells directly rather than a count to be scaled, and
 * the caller adds it to settled territory without a further multiplier.
 */
const CONVERSION_BANDS = [1, 3, 5, 8, 12, 18] as const;
const CONVERSION_PHASES = [0, 20, 30, 40] as const;
const CONVERSION: ReadonlyArray<ReadonlyArray<number>> = [
  [0.46, 0.47, 0.62, 0.57, 0.4, 0.24],
  [0.57, 0.64, 0.85, 0.65, 0.45, 0.26],
  [0.7, 0.84, 0.84, 0.65, 0.34, 0.39],
  // The 18+ band never occurs this late in the sample; it takes the 12-17 rate
  // rather than a guess of its own.
  [0.93, 0.95, 0.98, 0.94, 0.77, 0.77],
];

function conversionRate(regionSize: number, stones: number): number {
  let band = 0;
  for (let i = CONVERSION_BANDS.length - 1; i >= 0; i -= 1) {
    if (regionSize >= CONVERSION_BANDS[i]) { band = i; break; }
  }
  let phase = 0;
  for (let i = CONVERSION_PHASES.length - 1; i >= 0; i -= 1) {
    if (stones >= CONVERSION_PHASES[i]) { phase = i; break; }
  }
  return CONVERSION[phase][band];
}

export function expectedOpenGroundFromMap(
  owners: Array<Player | null>,
  board: Board,
): Record<Player, number> {
  let stones = 0;
  for (const row of board) for (const cell of row) if (cell !== "EMPTY") stones += 1;

  const size = board.length;
  const out: Record<Player, number> = { A: 0, B: 0 };
  const seen = new Uint8Array(owners.length);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const side = owners[row * size + col];
      if (!side || seen[row * size + col]) continue;
      const stack: Array<[number, number]> = [[row, col]];
      seen[row * size + col] = 1;
      let region = 0;
      while (stack.length) {
        const [r, c] = stack.pop()!;
        region += 1;
        for (const [dr, dc] of DIRECTIONS) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
          const index = nr * size + nc;
          if (seen[index] || owners[index] !== side) continue;
          seen[index] = 1;
          stack.push([nr, nc]);
        }
      }
      out[side] += region * conversionRate(region, stones);
    }
  }
  return out;
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
/**
 * On. A miscount rather than an idea, so the bar was that nothing gets worse.
 *
 * Arena, 186 games, counted-once against shipped: wins 102 to 84, groups lost 52
 * against 59, final territory 6.64 against 7.02, paired margin -0.38 +/- 0.35.
 * None of that is significant on its own — the win difference is 1.3 standard
 * deviations — but the two things the criterion named both moved the right way,
 * and a capture loses outright here while 0.38 cells does not. At the shipped
 * budget the fix changes 12% of moves and costs 0.02 ply.
 */
export let settledOutOfInfluenceEnabled = true;
export function setSettledOutOfInfluenceEnabled(value: boolean): void {
  settledOutOfInfluenceEnabled = value;
}

export function influenceOwnerMap(
  board: Board,
  /**
   * Confirmed territory, which the caller has and this function cannot derive
   * from the board alone — a settled cell is still `EMPTY`, it is only
   * unplayable. Without it those cells get an influence owner like any other
   * empty point, and `projectedMarginFrom` then adds them a second time at 0.12
   * on top of the 1.0 they already score as settled ground.
   *
   * Measured over 1435 recorded positions: all 14,350 settled cells carry an
   * influence owner, so every one is priced at 1.12. It inflates whichever side
   * is ahead, which is the side the engine is usually not.
   */
  settled?: ReadonlySet<string>,
): Array<Player | null> {
  const distA = distanceField(board, "A");
  const distB = distanceField(board, "B");
  const owners: Array<Player | null> = [];

  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board.length; col++) {
      if (board[row][col] !== "EMPTY") {
        owners.push(null);
        continue;
      }
      if (settledOutOfInfluenceEnabled && settled?.has(`${row},${col}`)) {
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

/**
 * Influence counted by whether it can actually be closed, not by how far it
 * reaches.
 *
 * The plain count prices every cell the same, and measurement says the two
 * kinds of cell are worth wildly different amounts. Over 335 midgame positions
 * of the recorded games, the engine holds 82% of its influence in a single
 * blob averaging 21.5 cells with a quarter of its boundary open, and converts
 * 10.2% of its reach into territory. The human holds about six regions of 5.6
 * cells with 18.6% of the boundary open, and converts 33.8%. A five-cell
 * region seals in a move or two; a twenty-one-cell one needs its whole
 * perimeter built and never gets there.
 *
 * So a region is credited its size, discounted once per open gap beyond the
 * first — the gaps being the empty points on its border, which is roughly the
 * number of moves that closing it would take. `decay` of 1 reproduces the
 * plain count exactly.
 *
 * Note this deliberately does *not* reward large connected areas. The engine
 * already builds those; they are the thing that is not working.
 */
export function closableInfluence(
  board: Board,
  owners: Array<Player | null>,
  decay: number,
): Record<Player, number> {
  const size = board.length;
  const index = (row: number, col: number) => row * size + col;
  const credit: Record<Player, number> = { A: 0, B: 0 };
  const seen = new Array<boolean>(size * size).fill(false);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const side = owners[index(row, col)];
      if (side === null || seen[index(row, col)]) continue;

      let cells = 0;
      let gaps = 0;
      const counted = new Set<number>();
      const stack: Array<[number, number]> = [[row, col]];
      seen[index(row, col)] = true;

      while (stack.length > 0) {
        const [r, c] = stack.pop()!;
        cells += 1;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          // The board edge is a wall the region gets for nothing.
          if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
          if (owners[index(nr, nc)] === side) {
            if (!seen[index(nr, nc)]) {
              seen[index(nr, nc)] = true;
              stack.push([nr, nc]);
            }
            continue;
          }
          // A hole only counts once however many of the region's cells touch
          // it: it takes one move to plug, not one per neighbour.
          if (board[nr][nc] === "EMPTY" && !counted.has(index(nr, nc))) {
            counted.add(index(nr, nc));
            gaps += 1;
          }
        }
      }

      credit[side] += cells * decay ** Math.max(0, gaps - 1);
    }
  }

  return credit;
}

/**
 * Empty points one move away from being this player's territory.
 *
 * A point becomes territory when everything around it is one colour or the
 * board edge, so a point with three such neighbours and one gap is a frame
 * waiting for a single stone. Counting them says how much closable structure a
 * position holds, which is the thing the engine turns out not to build: a seal
 * of two cells or more is available to it on 11% of its turns and to every
 * human category on 24 to 27.
 *
 * Deliberately cheap — one pass, no board clones — because unlike
 * `findSealingMoves` this runs at every leaf the search touches. It is an
 * approximation of that function and not a replacement for it: it does not
 * check whether the gap is legal to play, nor whether an enemy stone sits
 * inside the region, so it over-counts. Bias is acceptable in an evaluation
 * term; the exact version is still what the sealing stages use.
 */
export function framePotential(board: Board, player: Player): number {
  const size = board.length;
  const mine = playerCell(player);
  let count = 0;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (board[row][col] !== "EMPTY") continue;
      let walls = 0;
      let gaps = 0;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(r, c)) {
          walls += 1;
          continue;
        }
        if (board[r][c] === mine) walls += 1;
        else if (board[r][c] === "EMPTY") gaps += 1;
        else gaps += 2; // an opponent stone can never become my wall
      }
      if (walls >= 3 && gaps <= 1) count += 1;
    }
  }
  return count;
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
/**
 * Cells I must be able to settle in one move before this stage takes the turn.
 *
 * Off until the arena says otherwise; see the `imminent` comment below.
 */
export let ownSealImminentEnabled = false;
export function setOwnSealImminentEnabled(value: boolean): void {
  ownSealImminentEnabled = value;
}
export let ownSealImminentCells = 4;
export function setOwnSealImminentCells(value: number): void {
  ownSealImminentCells = value;
}
const ownSealImminentSize = () => ownSealImminentCells;
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

  // My own big enclosure counts as imminent too, and used not to.
  //
  // Every trigger above is something *they* are about to do. Ground I could
  // settle right now was left entirely to the general evaluation, and measured
  // over the recorded games that is where the engine loses cells: on 67 turns
  // it walked past a safe enclosure of three or more, and this stage fired on
  // none of them. Sixty percent were answered by the full search, which sees
  // the seal is still there next turn and keeps finding something else to do —
  // in one game it passed the same six-cell point five times.
  //
  // Gated on the same concrete size as their threat rather than on a soft
  // signal, because the soft version is what cost 75% to 42% against HARD when
  // this stage fired on half of all moves.
  const myGainNow = myBestSeal?.gained.length ?? 0;
  const imminent =
    oneMoveThreat >= urgentConfirmSize() ||
    twoMoveThreat >= Math.max(urgentConfirmSize(), LARGE_AREA) ||
    (ownSealImminentEnabled && myGainNow >= ownSealImminentSize());
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
