/**
 * Which two stones should a corner start with?
 *
 * The player's question: with no enemy stone anywhere near, is (1,2) + (2,1)
 * better than (1,2) + (0,3)? Their reason is experience — when the engine plays
 * the first pair against them they cannot break in.
 *
 * Both pairs sit on the corner's anti-diagonal, so both are "on the frame". What
 * differs is where: (1,2) and (2,1) are the middle two, symmetric about the
 * corner's diagonal, while (1,2) and (0,3) are the pair off to one side.
 *
 * So this enumerates every two-stone start inside the corner, hands the opponent
 * the move, and plays it out locally with both sides choosing by the rules' own
 * territory count. What each shape is worth, and whether an invader can live in
 * it, is then the rules' answer rather than anyone's impression.
 *
 *   npx vite-node corner-pair.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const PLIES = Number(process.env.PLIES ?? 5);
/** How far from the corner the local fight is taken to run. */
const REACH = Number(process.env.REACH ?? 4);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;
const cls = (row: number, col: number) => {
  const a = Math.min(row, 8 - row);
  const b = Math.min(col, 8 - col);
  return `(${Math.min(a, b)},${Math.max(a, b)})`;
};

function build(mine: Array<[number, number]>, theirs: Array<[number, number]>, toMove: Player): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

const local = (state: GameState, side: Player) =>
  getLegalMoves(state, side).filter((m) => m.row + m.col <= REACH);

/** Settled cells A keeps, both sides playing on for `plies`, alpha-beta. */
function play(state: GameState, side: Player, plies: number, alpha: number, beta: number): number {
  const settled = state.territories.A.length - state.territories.B.length;
  if (plies === 0) return settled;
  const moves = local(state, side);
  if (moves.length === 0) return settled;
  let best = side === "A" ? -Infinity : Infinity;
  for (const mv of moves) {
    const board = state.board.map((r) => [...r]);
    board[mv.row][mv.col] = playerCell(side);
    const next: GameState = {
      ...state,
      board,
      territories: calculateTerritories(board),
      currentPlayer: side === "A" ? "B" : "A",
    };
    const score = play(next, side === "A" ? "B" : "A", plies - 1, alpha, beta);
    if (side === "A") { best = Math.max(best, score); alpha = Math.max(alpha, best); }
    else { best = Math.min(best, score); beta = Math.min(beta, best); }
    if (beta <= alpha) break;
  }
  return best;
}

// Every cell of the corner worth starting from: the 4x4 block nearest it.
const spots: Array<[number, number]> = [];
for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) spots.push([r, c]);

interface Row {
  pair: string;
  classes: string;
  kept: number;
  entries: number;
  lives: number;
}
const rows: Row[] = [];

for (let i = 0; i < spots.length; i += 1) {
  for (let j = i + 1; j < spots.length; j += 1) {
    const mine = [spots[i], spots[j]];
    const start = build(mine, [], "B");

    // What the shape is worth with the opponent moving first.
    const kept = play(start, "B", PLIES, -Infinity, Infinity);

    // And whether a stone put inside it can be made to live.
    let entries = 0;
    let lives = 0;
    for (const mv of local(start, "B")) {
      if (mv.row + mv.col > 3) continue; // inside the corner triangle only
      entries += 1;
      const invaded = build(mine, [[mv.row, mv.col]], "A");
      if (findForcedCapture({ ...invaded, currentPlayer: "A" }, "A", 9, 1200) === null) lives += 1;
    }

    rows.push({
      pair: `${nm(spots[i][0], spots[i][1])} ${nm(spots[j][0], spots[j][1])}`,
      classes: `${cls(spots[i][0], spots[i][1])} ${cls(spots[j][0], spots[j][1])}`,
      kept,
      entries,
      lives,
    });
  }
}

rows.sort((a, b) => b.kept - a.kept || a.lives / (a.entries || 1) - b.lives / (b.entries || 1));

console.log(`two-stone corner starts, opponent to move, ${PLIES} plies of local play\n`);
console.log(
  `${"pair".padStart(8)}${"classes".padStart(14)}${"kept".padStart(7)}` +
    `${"invader lives".padStart(16)}`,
);
for (const r of rows.slice(0, 12)) {
  console.log(
    `${r.pair.padStart(8)}${r.classes.padStart(14)}${String(r.kept).padStart(7)}` +
      `${`${r.lives}/${r.entries}`.padStart(16)}`,
  );
}

console.log(`\nthe two the player asked about`);
for (const want of ["C2 B3", "D1 C2", "C2 A4", "D1 B3"]) {
  const found = rows.find((r) => r.pair === want);
  if (!found) continue;
  console.log(
    `${found.pair.padStart(8)}${found.classes.padStart(14)}${String(found.kept).padStart(7)}` +
      `${`${found.lives}/${found.entries}`.padStart(16)}` +
      `${`rank ${rows.indexOf(found) + 1} of ${rows.length}`.padStart(20)}`,
  );
}
