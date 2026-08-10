/**
 * How big can the corner go, and how cheaply?
 *
 * The small version is settled: C2 B1 D1 encloses C1 and survives a depth-9
 * capture read with three enemy stones pressing. The player also mentions a
 * larger version worth four cells, so this searches for it — every set of up to
 * four stones drawn from the top-left corner that includes the (1,2) point,
 * ranked by cells enclosed per stone, and each one handed to the capture reader
 * with the opponent to move.
 *
 *   npx vite-node corner-shapes.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const at = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0]) });

// The corner region a shape may use: first three lines, six columns in.
const REGION: string[] = [];
for (let row = 0; row < 3; row += 1) {
  for (let col = 0; col < 6; col += 1) REGION.push(`${COLS[col]}${row + 1}`);
}
const START = "C2";

function build(mine: string[]): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const p of mine) { const c = at(p); board[c.row][c.col] = playerCell("A"); }
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: "B" };
}

interface Row { stones: string[]; cells: number; safe: boolean }
const found: Row[] = [];
const pool = REGION.filter((p) => p !== START);

for (let i = 0; i < pool.length; i += 1) {
  for (let j = i + 1; j < pool.length; j += 1) {
    for (let k = j + 1; k < pool.length; k += 1) {
      const stones = [START, pool[i], pool[j], pool[k]];
      const state = build(stones);
      const cells = state.territories.A.length;
      if (cells < 4) continue;
      found.push({ stones, cells, safe: false });
    }
  }
}
found.sort((a, b) => b.cells - a.cells);

// The capture read is the expensive part, so only the best few get it.
const best: Row[] = [];
const seenShape = new Set<string>();
for (const row of found) {
  const key = row.stones.slice().sort().join(" ");
  if (seenShape.has(key)) continue;
  seenShape.add(key);
  best.push(row);
  if (best.length >= 8) break;
}
for (const row of best) {
  row.safe = findForcedCapture(build(row.stones), "B", 9, 2000) === null;
}

console.log(`four stones including the ${START} point, ranked by cells enclosed\n`);
console.log(`${"stones".padEnd(20)}${"cells".padStart(6)}${"per stone".padStart(11)}${"opponent to move".padStart(19)}`);
for (const row of best) {
  console.log(
    `${row.stones.join(" ").padEnd(20)}${String(row.cells).padStart(6)}` +
      `${(row.cells / 4).toFixed(2).padStart(11)}${(row.safe ? "safe" : "CAPTURABLE").padStart(19)}`,
  );
}
console.log(`\nshapes reaching four cells at all: ${found.length} of the sets searched`);
