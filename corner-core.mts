/**
 * The shared machinery for fighting one corner out.
 *
 * The corner is a square block at one corner of the real board, and only that
 * block is playable. The corner is bounded by two board edges already, so a
 * connected wall along the anti-diagonal encloses it, which is exactly the
 * frame the engine's book is built around. Territory is computed on the whole
 * board by the real rules and then counted inside the block, so nothing about
 * enclosure is faked.
 *
 * Three knobs decide whether an answer is real or an artifact of the model, and
 * every result has to be checked against all three before it is believed:
 *
 *   REGION  how far out of the corner the fight may spread. Too small and a
 *           group sitting on the block's far edge keeps liberties nobody may
 *           fill, so it looks alive when it is not.
 *   BUDGET  how many stones each side may still add. Too small and an attack
 *           runs out of stones one move short of the kill, which reads as life.
 *   pass    either side may decline to add a stone. Without it both sides are
 *           forced to keep playing a corner that is already settled, which
 *           invents moves nobody would make. Two passes in a row end the fight.
 *
 * With pass available, BUDGET is an upper bound rather than a quota, so raising
 * it can only open lines up — it never forces a bad move.
 *
 * Used by corner-solver.mts (answers to an opening) and corner-branch.mts
 * (every alternative at one point in a line), which must agree move for move.
 */
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** Highest edge distance still inside the study block: 3 means the 4x4 corner. */
export const REGION = Number(process.env.REGION ?? 3);
export const COLS = "ABCDEFGHI";
export const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;

/** "C2" -> {row, col}. Throws rather than silently studying the wrong cell. */
export function parsePoint(point: string): { row: number; col: number } {
  const col = COLS.indexOf(point[0].toUpperCase());
  const row = Number(point.slice(1)) - 1;
  if (col < 0 || !Number.isInteger(row) || row < 0 || row > REGION || col > REGION) {
    throw new Error(`not a point in the study corner: ${point}`);
  }
  return { row, col };
}

/** The corner under test is the top-left one; every result generalises by symmetry. */
export const cells: Array<{ row: number; col: number }> = [];
for (let r = 0; r <= REGION; r += 1) {
  for (let c = 0; c <= REGION; c += 1) cells.push({ row: r, col: c });
}

/** Corner cells `side` ends with, minus the other side's. */
export function cornerScore(state: GameState, side: Player): number {
  const terr = calculateTerritories(state.board);
  const count = (p: Player) =>
    terr[p].filter((cell) => cell.row <= REGION && cell.col <= REGION).length;
  return count(side) - count(opponent(side));
}

export function boardWith(stones: Array<{ row: number; col: number; side: Player }>): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const s of stones) board[s.row][s.col] = playerCell(s.side);
  return { ...base, board, territories: calculateTerritories(board) };
}

export type Line = { score: number; line: string[] };
export const PASS = "pass";

/** A memo entry is only a bound unless the window it came from was open. */
const EXACT = 0;
const LOWER = 1;
const UPPER = 2;
type Entry = { value: number; flag: number; depth: number; line: string[] };

/**
 * A memo table that cannot outgrow the heap. A JS Map throws once it passes
 * ~16.7M entries, which a 5x5 corner reaches, so this flushes instead: losing
 * the table costs time, never correctness.
 */
export class Memo {
  private map = new Map<string, Entry>();
  constructor(private readonly limit = Number(process.env.MEMO ?? 1_500_000)) {}
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, entry: Entry) {
    if (this.map.size >= this.limit) this.map.clear();
    this.map.set(key, entry);
  }
}
export const newMemo = (): Memo => new Memo();

/**
 * Which points are worth considering. Far from every stone, a move can neither
 * attack, defend, nor wall anything in, so past the 4x4 core the search only
 * looks at points touching a stone. Off by default at REGION 3, where the core
 * is the whole block and nothing is dropped.
 */
const RELEVANT = process.env.RELEVANT === "1" || (process.env.RELEVANT !== "0" && REGION > 3);
const CORE = 3;

/**
 * Liberty counts for every group on the board, keyed by cell. One sweep per
 * node instead of a fresh flood fill per candidate move.
 */
function libertyMap(state: GameState): Map<string, number> {
  const out = new Map<string, number>();
  for (let r = 0; r <= REGION; r += 1) {
    for (let c = 0; c <= REGION; c += 1) {
      const at = state.board[r][c];
      if (at === "EMPTY" || at === "NEUTRAL") continue;
      if (out.has(`${r},${c}`)) continue;
      const group = getConnectedGroup(state.board, r, c);
      const libs = getGroupLiberties(state.board, group).size;
      for (const cell of group) out.set(`${cell.row},${cell.col}`, libs);
    }
  }
  return out;
}

/**
 * Cheap static ordering, so alpha-beta cuts early instead of walking the block
 * in row-major order. Contact fights first: the fewer liberties a neighbouring
 * group has, the more urgent the point — taking an enemy's last liberties or
 * saving my own both outrank quiet territory moves.
 */
function moveOrderKey(
  state: GameState,
  libs: Map<string, number>,
  cell: { row: number; col: number },
  side: Player,
): number {
  let urgency = 0;
  let friendly = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const r = cell.row + dr;
    const c = cell.col + dc;
    if (!inBounds(r, c)) continue;
    const at = state.board[r][c];
    if (at === "EMPTY" || at === "NEUTRAL") continue;
    const n = libs.get(`${r},${c}`) ?? 9;
    const mine = at === playerCell(side);
    urgency = Math.max(urgency, (mine ? 40 : 60) - Math.min(n, 5) * 10);
    if (mine) friendly += 1;
  }
  // Ties go to points nearer the corner, which is where the territory is.
  return urgency * 100 + friendly * 10 + (2 * REGION - cell.row - cell.col);
}

/** Any stone in the eight cells around this one, so contact moves survive the filter. */
function touchesAStone(state: GameState, cell: { row: number; col: number }): boolean {
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const r = cell.row + dr;
      const c = cell.col + dc;
      if (!inBounds(r, c)) continue;
      const at = state.board[r][c];
      if (at !== "EMPTY" && at !== "NEUTRAL") return true;
    }
  }
  return false;
}

const keyOf = (
  state: GameState,
  toMove: Player,
  left: number,
  right: number,
  passes: number,
) =>
  `${state.board.slice(0, REGION + 1).map((r) => r.slice(0, REGION + 1).join("")).join("|")}` +
  `#${toMove}${left}.${right}.${passes}`;

/**
 * Alpha-beta from `root`'s point of view. A capture ends the whole game, which
 * dwarfs any corner count, so it is scored at +-99 rather than in cells.
 *
 * `seen` is the caller's memo table: positions are only comparable within one
 * question, so each question passes a fresh map. Entries carry the window they
 * were proved under — a value found under a narrow window is only a bound, and
 * reusing it as if it were exact is how a solver quietly reports a move that is
 * not actually best. `passes` counts consecutive declines and is part of the
 * key: the same stones with a pass behind them is a different position.
 */
export function search(
  state: GameState,
  root: Player,
  toMove: Player,
  budgets: Record<Player, number>,
  depth: number,
  alpha: number,
  beta: number,
  seen: Memo,
  passes = 0,
): Line {
  const alpha0 = alpha;
  const beta0 = beta;
  const key = keyOf(state, toMove, budgets.A, budgets.B, passes);
  const hit = seen.get(key);
  if (hit !== undefined && hit.depth >= depth) {
    if (hit.flag === EXACT) return { score: hit.value, line: hit.line };
    if (hit.flag === LOWER && hit.value >= beta) return { score: hit.value, line: hit.line };
    if (hit.flag === UPPER && hit.value <= alpha) return { score: hit.value, line: hit.line };
    if (hit.flag === LOWER) alpha = Math.max(alpha, hit.value);
    if (hit.flag === UPPER) beta = Math.min(beta, hit.value);
    if (alpha >= beta) return { score: hit.value, line: hit.line };
  }

  // Both sides declining in a row settles the corner, and so does depth.
  if (passes >= 2 || depth <= 0) {
    const value = cornerScore(state, root);
    seen.set(key, { value, flag: EXACT, depth, line: [] });
    return { score: value, line: [] };
  }

  const libs = libertyMap(state);
  const placements = budgets[toMove] > 0
    ? cells
        .filter((c) => isLegalMove(state, c.row, c.col, toMove))
        .filter((c) => !RELEVANT || (c.row <= CORE && c.col <= CORE) || touchesAStone(state, c))
        .sort((x, y) => moveOrderKey(state, libs, y, toMove) - moveOrderKey(state, libs, x, toMove))
    : [];

  const maximising = toMove === root;
  let best = maximising ? -Infinity : Infinity;
  let bestLine: string[] = [];

  const consider = (value: number, line: string[]) => {
    // Ties are broken by resistance, not by move order. Without this the losing
    // side's "best" line is whatever came first, which shows it ignoring an
    // atari — technically still lost, but unreadable as a record. The root side
    // stretches the fight out; the other side ends it soonest.
    const better = maximising ? value > best : value < best;
    const tied = value === best &&
      (maximising ? line.length > bestLine.length : line.length < bestLine.length);
    if (better || tied) {
      best = value;
      bestLine = line;
    }
    if (maximising) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);
    return beta <= alpha;
  };

  let cut = false;
  for (const mv of placements) {
    const next = applyMove({ ...state, currentPlayer: toMove }, mv.row, mv.col);
    const tag = `${toMove}:${nm(mv.row, mv.col)}`;
    if (next.winner) {
      if (consider(next.winner === root ? 99 : -99, [`${tag} (captures)`])) { cut = true; break; }
      continue;
    }
    const sub = search(
      next,
      root,
      opponent(toMove),
      { ...budgets, [toMove]: budgets[toMove] - 1 },
      depth - 1,
      alpha,
      beta,
      seen,
      0,
    );
    if (consider(sub.score, [tag, ...sub.line])) { cut = true; break; }
  }

  if (!cut) {
    // Declining costs no stone; it only risks the other side settling the corner.
    const sub = search(state, root, opponent(toMove), budgets, depth - 1, alpha, beta, seen, passes + 1);
    consider(sub.score, [`${toMove}:${PASS}`, ...sub.line]);
  }

  const flag = best <= alpha0 ? UPPER : best >= beta0 ? LOWER : EXACT;
  seen.set(key, { value: best, flag, depth, line: bestLine });
  return { score: best, line: bestLine };
}
