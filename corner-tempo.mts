/**
 * Which corner is worth playing in — priced on the whole board.
 *
 * The corner solver answers questions inside one corner. It cannot answer the
 * question that comes before that one: with a stone of my own in an empty
 * corner and an opponent's stone in another, do I finish my pair, answer their
 * corner, or start a third? Those are moves in different corners, so no
 * single-corner model can compare them — the whole point of the choice is what
 * the rest of the board is worth.
 *
 * Each candidate is played out to a count on the full 9x9 many times with play
 * allowed to vary, and every candidate runs on the same seeds, so the
 * comparison is paired and the between-game spread differences away. The
 * numbers are what *this engine* does from the position, which is the right
 * question when the choice is what to teach this engine.
 *
 *   SETUP=B:C2,A:G8 TOMOVE=A CANDIDATES=H7,A2,G2 npx vite-node corner-tempo.mts
 *   ... PLAYOUTS=600 npx vite-node corner-tempo.mts
 */
import { playoutToCount, seededRandom } from "./src/games/alley-boss-cats/labelPlayout";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const SIZE = 9;

/** "C2" anywhere on the 9x9, not just inside a study corner. */
function point(name: string): { row: number; col: number } {
  const col = COLS.indexOf(name[0].toUpperCase());
  const row = Number(name.slice(1)) - 1;
  if (col < 0 || !Number.isInteger(row) || row < 0 || row >= SIZE) {
    throw new Error(`not a point on the board: ${name}`);
  }
  return { row, col };
}

/** Corner reference for a point: sorted edge distances, so all four corners read alike. */
function corner(row: number, col: number): string {
  const dr = Math.min(row, SIZE - 1 - row);
  const dc = Math.min(col, SIZE - 1 - col);
  const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
  const side = `${row < SIZE / 2 ? "위" : "아래"}${col < SIZE / 2 ? "왼" : "오"}`;
  return `${side} (${a},${b})`;
}

const SETUP = (process.env.SETUP ?? "B:C2,A:G8").split(",").map((s) => s.trim()).filter(Boolean);
const TOMOVE = (process.env.TOMOVE ?? "A") as Player;
const CANDIDATES = (process.env.CANDIDATES ?? "H7,A2").split(",").map((s) => s.trim()).filter(Boolean);
const PLAYOUTS = Number(process.env.PLAYOUTS ?? 400);
const TOPK = Number(process.env.TOPK ?? 3);

// Stones are placed directly rather than played in turn: the setup describes a
// position, and forcing it into a legal move order would constrain which
// positions can be studied.
const base: GameState = (() => {
  const start = createInitialState();
  const board = start.board.map((r) => [...r]);
  for (const entry of SETUP) {
    const [side, name] = entry.split(":");
    const { row, col } = point(name);
    board[row][col] = playerCell(side.trim().toUpperCase() as Player);
  }
  return { ...start, board, territories: calculateTerritories(board), currentPlayer: TOMOVE };
})();

console.log(`corner tempo — ${PLAYOUTS} playouts each, topK ${TOPK}`);
console.log(`position: ${SETUP.join("  ")}   ${TOMOVE} to move`);
console.log(`margin is ${TOMOVE}'s final cells minus the other's — higher is better for ${TOMOVE}.\n`);

const results = CANDIDATES.map((name) => {
  const { row, col } = point(name);
  if (!isLegalMove(base, row, col, TOMOVE)) throw new Error(`illegal candidate: ${name}`);
  const start = applyMove({ ...base, currentPlayer: TOMOVE }, row, col);
  const margins: number[] = [];
  for (let run = 0; run < PLAYOUTS; run += 1) {
    // playoutToCount reports A minus B; flip it when B is the side choosing.
    const fromA = playoutToCount(start, seededRandom(1_000_003 + run * 7919), { topK: TOPK });
    margins.push(TOMOVE === "A" ? fromA : -fromA);
  }
  const mean = margins.reduce((s, v) => s + v, 0) / margins.length;
  const sd = Math.sqrt(margins.reduce((s, v) => s + (v - mean) ** 2, 0) / (margins.length - 1));
  return { name, where: corner(row, col), mean, se: sd / Math.sqrt(margins.length), margins };
});

const ranked = [...results].sort((x, y) => y.mean - x.mean);
console.log(`${"move".padEnd(7)}${"corner".padEnd(14)}${"margin".padStart(9)}${"± 95%".padStart(9)}`);
for (const r of ranked) {
  console.log(
    `${r.name.padEnd(7)}${r.where.padEnd(14)}${r.mean.toFixed(2).padStart(9)}${(1.96 * r.se).toFixed(2).padStart(9)}`,
  );
}

console.log("\npaired differences against the best:");
const top = ranked[0];
for (const other of ranked.slice(1)) {
  const diffs = top.margins.map((v, k) => v - other.margins[k]);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  console.log(
    `  ${top.name} - ${other.name} = ${mean.toFixed(2)} +- ${(1.96 * se).toFixed(2)}` +
      `${Math.abs(mean) > 1.96 * se ? "" : "   — not separated"}`,
  );
}
