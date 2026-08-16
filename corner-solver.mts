/**
 * Fight one corner out, instead of arguing about it from statistics.
 *
 * Every measurement so far has been indirect: whole games, where the corner
 * line is buried under everything else, or arena runs where the position never
 * arises. The player's suggestion is the direct instrument — take a single
 * corner, let both sides play it to the end, and count.
 *
 * The corner is the 4x4 block at one corner of the real board (both edge
 * distances 3 or less), and only that block is playable. That is enough for a
 * real fight: the corner is bounded by two board edges already, so a connected
 * wall along the anti-diagonal encloses it, which is exactly the frame the
 * engine's book is built around. Territory is computed on the whole board by
 * the real rules and then counted inside the block, so nothing about enclosure
 * is faked.
 *
 * Alpha-beta over the block with a stone budget per side; the score is the
 * corner cells the side to move ends with, minus the other side's.
 *
 *   npx vite-node corner-solver.mts                 # answers to (1,2)
 *   OPEN=1,1 npx vite-node corner-solver.mts        # answers to another opening
 *   BUDGET=4 DEPTH=10 npx vite-node corner-solver.mts
 */
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 10);
/** Stones each side may still add. Corners resolve well inside this. */
const BUDGET = Number(process.env.BUDGET ?? 4);
const REGION = 3;

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
/** The corner under test is the top-left one; every result generalises by symmetry. */
const cells: Array<{ row: number; col: number }> = [];
for (let r = 0; r <= REGION; r += 1) {
  for (let c = 0; c <= REGION; c += 1) cells.push({ row: r, col: c });
}

function cornerScore(state: GameState, side: Player): number {
  const terr = calculateTerritories(state.board);
  const count = (p: Player) =>
    terr[p].filter((cell) => cell.row <= REGION && cell.col <= REGION).length;
  return count(side) - count(opponent(side));
}

const seenStates = new Map<string, { score: number; line: string[] }>();
const keyOf = (state: GameState, toMove: Player, left: number, right: number) =>
  `${state.board.slice(0, REGION + 1).map((r) => r.slice(0, REGION + 1).join("")).join("|")}#${toMove}${left}${right}`;

/** Alpha-beta from `root`'s point of view. */
function search(
  state: GameState,
  root: Player,
  toMove: Player,
  budgets: Record<Player, number>,
  depth: number,
  alpha: number,
  beta: number,
): { score: number; line: string[] } {
  const key = keyOf(state, toMove, budgets.A, budgets.B);
  const hit = seenStates.get(key);
  if (hit !== undefined) return hit;

  const moves = budgets[toMove] > 0
    ? cells.filter((c) => isLegalMove(state, c.row, c.col, toMove))
    : [];
  if (depth <= 0 || moves.length === 0) {
    // Both sides out of moves ends the fight; otherwise the other side plays on.
    const otherMoves = budgets[opponent(toMove)] > 0
      ? cells.filter((c) => isLegalMove(state, c.row, c.col, opponent(toMove)))
      : [];
    if (depth <= 0 || otherMoves.length === 0) {
      const out = { score: cornerScore(state, root), line: [] as string[] };
      seenStates.set(key, out);
      return out;
    }
    return search(state, root, opponent(toMove), budgets, depth - 1, alpha, beta);
  }

  const maximising = toMove === root;
  let best = maximising ? -Infinity : Infinity;
  let bestLine: string[] = [];
  for (const mv of moves) {
    const next = applyMove({ ...state, currentPlayer: toMove }, mv.row, mv.col);
    // A capture ends the whole game, which dwarfs any corner count.
    let value: number;
    let line: string[];
    const tag = `${toMove}:${nm(mv.row, mv.col)}`;
    if (next.winner) {
      value = next.winner === root ? 99 : -99;
      line = [`${tag} (captures)`];
    } else {
      const sub = search(
        next,
        root,
        opponent(toMove),
        { ...budgets, [toMove]: budgets[toMove] - 1 },
        depth - 1,
        alpha,
        beta,
      );
      value = sub.score;
      line = [tag, ...sub.line];
    }
    if (maximising ? value > best : value < best) {
      best = value;
      bestLine = line;
    }
    if (maximising) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  const out = { score: best, line: bestLine };
  seenStates.set(key, out);
  return out;
}

function boardWith(stones: Array<{ row: number; col: number; side: Player }>): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const s of stones) board[s.row][s.col] = playerCell(s.side);
  return { ...base, board, territories: calculateTerritories(board) };
}

const [oa, ob] = (process.env.OPEN ?? "1,2").split(",").map(Number);
console.log(`corner solver — the 4x4 corner, ${BUDGET} more stones each, depth ${DEPTH}`);
console.log(`B opens at (${oa},${ob}) = ${nm(oa, ob)}; A to answer. Score is A's corner cells minus B's.\n`);

const opening = [{ row: oa, col: ob, side: "B" as Player }];
const answers = cells
  .filter((c) => !(c.row === oa && c.col === ob))
  .map((c) => {
    const state = boardWith([...opening, { ...c, side: "A" }]);
    seenStates.clear();
    const { score, line } = search(
      state,
      "A",
      "B",
      { A: BUDGET - 1, B: BUDGET },
      DEPTH,
      -Infinity,
      Infinity,
    );
    const dr = Math.min(c.row, 8 - c.row);
    const dc = Math.min(c.col, 8 - c.col);
    const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
    return { cell: c, label: `(${a},${b})`, name: nm(c.row, c.col), score, line };
  })
  .sort((x, y) => y.score - x.score);

console.log(`${"answer".padEnd(10)}${"point".padEnd(8)}${"A - B".padStart(7)}   continuation (best play by both)`);
for (const a of answers) {
  console.log(
    `${a.name.padEnd(10)}${a.label.padEnd(8)}${a.score.toFixed(0).padStart(7)}   ` +
      `B:${nm(oa, ob)} A:${a.name} ${a.line.join(" ")}`,
  );
}
