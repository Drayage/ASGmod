/**
 * Where the frame actually breaks: the building phase, not the finished shape.
 *
 * frame-scaling.mts showed the triangular scaling holds exactly — 1, 3, 6, 10,
 * 15 cells for 2..6 stones. It also reported that no invader survives at any
 * depth, but that was vacuous: it built each frame complete, and a complete
 * frame's interior is confirmed territory nobody may legally enter, so there was
 * nothing to try. It cannot see the risk the player describes.
 *
 * The risk lives in the moves before the last one. So this leaves the frame one
 * stone short — every choice of which stone is missing — and asks two things of
 * every point the opponent could enter at:
 *
 *   - does the invading stone live? Read by the capture search, the same one the
 *     engine uses, so "dies" means dies by force and not by hope.
 *   - what is the corner still worth? Both sides then play on, choosing by the
 *     rules' own territory count, alpha-beta so it can see five plies.
 *
 * If the player is right that five stones is where invasion gets easy, the count
 * of viable entry points has to grow with depth. That is the number to watch.
 *
 *   npx vite-node frame-building.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const PLIES = Number(process.env.PLIES ?? 5);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

function build(
  mine: Array<[number, number]>,
  theirs: Array<[number, number]>,
  toMove: Player,
): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

/**
 * Moves worth considering while the fight is local: empty points inside the
 * corner or one line beyond the frame. Anything further away is a different
 * fight and would only add branches the search has to chew through.
 */
function localMoves(state: GameState, side: Player, reach: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const mv of getLegalMoves(state, side)) {
    if (mv.row + mv.col <= reach) out.push([mv.row, mv.col]);
  }
  return out;
}

/** Settled cells A keeps, both sides playing on for `plies`, A to move. */
function play(
  state: GameState,
  side: Player,
  plies: number,
  reach: number,
  alpha: number,
  beta: number,
): number {
  const settled = state.territories.A.length - state.territories.B.length;
  if (plies === 0) return settled;
  const moves = localMoves(state, side, reach);
  if (moves.length === 0) return settled;
  let best = side === "A" ? -Infinity : Infinity;
  for (const [row, col] of moves) {
    const board = state.board.map((r) => [...r]);
    board[row][col] = playerCell(side);
    const next: GameState = {
      ...state,
      board,
      territories: calculateTerritories(board),
      currentPlayer: side === "A" ? "B" : "A",
    };
    const score = play(next, side === "A" ? "B" : "A", plies - 1, reach, alpha, beta);
    if (side === "A") {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

console.log(`the frame one stone short, every gap and every entry — ${PLIES} plies of answer\n`);
console.log(
  `${"stones".padStart(7)}${"finished".padStart(10)}${"entries".padStart(9)}` +
    `${"invader lives".padStart(15)}${"kept, worst".padStart(13)}${"kept, mean".padStart(12)}` +
    `${"worst line".padStart(22)}`,
);

for (let n = 2; n <= 6; n += 1) {
  const line: Array<[number, number]> = [];
  for (let a = 0; a <= n - 1; a += 1) line.push([a, n - 1 - a]);
  const finished = (n * (n - 1)) / 2;
  const reach = n; // the frame line is a+b = n-1, so one line beyond it

  let entries = 0;
  let lives = 0;
  let worst = Infinity;
  let worstLine = "";
  const kept: number[] = [];

  for (let skip = 0; skip < n; skip += 1) {
    const partial = line.filter((_, i) => i !== skip);
    const state = build(partial, [], "B");
    for (const [row, col] of localMoves(state, "B", reach)) {
      entries += 1;
      const invaded = build(partial, [[row, col]], "A");
      if (findForcedCapture({ ...invaded, currentPlayer: "A" }, "A", 9, 2000) === null) lives += 1;
      const score = play(invaded, "A", PLIES, reach, -Infinity, Infinity);
      kept.push(score);
      if (score < worst) {
        worst = score;
        worstLine = `no ${nm(line[skip][0], line[skip][1])}, they take ${nm(row, col)}`;
      }
    }
  }

  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  console.log(
    `${String(n).padStart(7)}${String(finished).padStart(10)}${String(entries).padStart(9)}` +
      `${`${lives} (${Math.round((100 * lives) / entries)}%)`.padStart(15)}` +
      `${String(worst).padStart(13)}${mean.toFixed(1).padStart(12)}${worstLine.padStart(22)}`,
  );
}
