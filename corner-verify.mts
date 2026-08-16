/**
 * Check the corner solver against a solver that cannot be wrong.
 *
 * The fast search prunes and memoises, and both of those are places where a
 * solver can quietly return a move that is not actually best. This runs a plain
 * minimax — no pruning, no memo table — over the same positions and compares
 * every score. Small budgets only; that is the point, the naive one has to be
 * able to finish.
 *
 *   npx vite-node corner-verify.mts
 *   OPEN=1,1 BUDGET=4 DEPTH=8 npx vite-node corner-verify.mts
 */
import { REGION, boardWith, cells, cornerScore, newMemo, nm, search } from "./corner-core";
import { applyMove, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 8);
const BUDGET = Number(process.env.BUDGET ?? 3);

/** The same rules as `search`, with every shortcut removed. */
function naive(
  state: GameState,
  root: Player,
  toMove: Player,
  budgets: Record<Player, number>,
  depth: number,
  passes: number,
): number {
  if (passes >= 2 || depth <= 0) return cornerScore(state, root);

  const placements = budgets[toMove] > 0
    ? cells.filter((c) => isLegalMove(state, c.row, c.col, toMove))
    : [];

  const maximising = toMove === root;
  let best = maximising ? -Infinity : Infinity;
  const take = (v: number) => {
    best = maximising ? Math.max(best, v) : Math.min(best, v);
  };

  for (const mv of placements) {
    const next = applyMove({ ...state, currentPlayer: toMove }, mv.row, mv.col);
    if (next.winner) {
      take(next.winner === root ? 99 : -99);
      continue;
    }
    take(naive(next, root, opponent(toMove), { ...budgets, [toMove]: budgets[toMove] - 1 }, depth - 1, 0));
  }
  take(naive(state, root, opponent(toMove), budgets, depth - 1, passes + 1));
  return best;
}

const [oa, ob] = (process.env.OPEN ?? "1,2").split(",").map(Number);
console.log(
  `verify — the ${REGION + 1}x${REGION + 1} corner, ${BUDGET} stones a side, depth ${DEPTH}\n` +
    `B opens at ${nm(oa, ob)}; comparing alpha-beta+memo against plain minimax.\n`,
);

let mismatches = 0;
for (const c of cells) {
  if (c.row === oa && c.col === ob) continue;
  const state = boardWith([
    { row: oa, col: ob, side: "B" },
    { ...c, side: "A" },
  ]);
  const budgets = { A: BUDGET - 1, B: BUDGET - 1 };
  const fast = search(state, "A", "B", budgets, DEPTH, -Infinity, Infinity, newMemo()).score;
  const slow = naive(state, "A", "B", budgets, DEPTH, 0);
  const ok = fast === slow;
  if (!ok) mismatches += 1;
  console.log(
    `${nm(c.row, c.col).padEnd(6)} fast ${String(fast).padStart(4)}   minimax ${String(slow).padStart(4)}   ${ok ? "ok" : "MISMATCH"}`,
  );
}
console.log(`\n${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
