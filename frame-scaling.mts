/**
 * The scaling the player describes: 2 stones 1 cell, 3 stones 3, 4 stones 6,
 * 5 stones 10 — and their claim that five is where it stops holding.
 *
 * Each frame is the corner anti-diagonal at a given depth: the cells whose two
 * edge distances sum to n-1. So this builds each one, asks the rules how much it
 * actually confirms, and then lets the opponent in at every point inside it and
 * reads whether the invader can be captured.
 *
 * A region only counts as territory when the opponent cannot play there at all,
 * and an invader only dies if the capture read says so — which is exactly where
 * a frame that is too wide should come apart.
 *
 *   npx vite-node frame-scaling.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

function build(mine: Array<[number, number]>, theirs: Array<[number, number]> = []): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: "B" };
}

console.log(`the corner frame at each depth — stones on the anti-diagonal a+b = n-1\n`);
console.log(
  `${"stones".padStart(7)}${"frame".padStart(22)}${"cells".padStart(7)}` +
    `${"triangular".padStart(12)}${"invasions legal".padStart(16)}${"invader survives at".padStart(22)}`,
);

for (let n = 2; n <= 6; n += 1) {
  const line: Array<[number, number]> = [];
  for (let a = 0; a <= n - 1; a += 1) line.push([a, n - 1 - a]);
  const state = build(line);
  const cells = state.territories.A.length;

  // Every empty point the frame is supposed to hold, tried as an invasion.
  const inside: string[] = [];
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (row + col >= n - 1) continue; // outside the corner triangle
      if (state.board[row][col] !== "EMPTY") continue;
      inside.push(nm(row, col));
    }
  }
  const survivors: string[] = [];
  let tried = 0;
  for (const spot of inside) {
    const col = COLS.indexOf(spot[0]);
    const row = Number(spot.slice(1)) - 1;
    if (!getLegalMoves(state, "B").some((m) => m.row === row && m.col === col)) continue;
    tried += 1;
    const invaded = build(line, [[row, col]]);
    const answer = findForcedCapture({ ...invaded, currentPlayer: "A" }, "A", 9, 2000);
    if (answer === null) survivors.push(spot);
  }

  console.log(
    `${String(n).padStart(7)}${line.map(([r, c]) => nm(r, c)).join(" ").padStart(22)}` +
      `${String(cells).padStart(7)}${String((n * (n - 1)) / 2).padStart(12)}` +
      `${`${tried} of ${inside.length}`.padStart(16)}` +
      `${(survivors.length ? survivors.join(",") : tried === 0 ? "(none legal)" : "none").padStart(22)}`,
  );
}
