/**
 * Does one enemy stone flip which way to extend?
 *
 * §65 settled the empty case: from the (1,2) point, the middle pair (1,2)+(2,1)
 * kills an invader at all eight entry points and the off-centre (1,2)+(0,3)
 * lets five of eight live, so the book now breaks its tie toward the middle.
 *
 * The player then drew a line through it: with an enemy stone already nearby
 * (0,3) is the safe move, because it makes an eye and the group cannot die,
 * and it is only a wasted move when nothing is threatening. That is a different
 * claim — about survival rather than about size — and it has a different test.
 *
 * So this puts one enemy stone at every point in the corner in turn, extends
 * both ways from (1,2), and asks the rules both questions: can the opponent kill
 * the group, and what does it end up holding. If the player is right the two
 * columns disagree, with (0,3) safer and (2,1) bigger.
 *
 *   npx vite-node corner-pressed-pair.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const PLIES = Number(process.env.PLIES ?? 5);
const REACH = Number(process.env.REACH ?? 4);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

const PRO: [number, number] = [1, 2];
const MIDDLE: [number, number] = [2, 1];
const EDGE: [number, number] = [0, 3];

function build(mine: Array<[number, number]>, theirs: Array<[number, number]>, toMove: Player): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

const local = (state: GameState, side: Player) =>
  getLegalMoves(state, side).filter((m) => m.row + m.col <= REACH);

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

/** After A extends, can B force a capture anywhere? */
const killable = (state: GameState) =>
  findForcedCapture({ ...state, currentPlayer: "B" }, "B", 9, 1200) !== null;

interface Row { enemy: string; middleKept: number; edgeKept: number; middleDies: boolean; edgeDies: boolean }
const rows: Row[] = [];

for (let r = 0; r < 5; r += 1) {
  for (let c = 0; c < 5; c += 1) {
    if (r === PRO[0] && c === PRO[1]) continue;
    if (r + c > REACH) continue;
    const base = build([PRO], [[r, c]], "A");
    if (base.board[r][c] !== playerCell("B")) continue;

    const tried: Record<"middle" | "edge", { kept: number; dies: boolean } | null> = {
      middle: null,
      edge: null,
    };
    for (const [key, spot] of [["middle", MIDDLE], ["edge", EDGE]] as Array<["middle" | "edge", [number, number]]>) {
      if (spot[0] === r && spot[1] === c) continue;
      if (!isLegalMove(base, spot[0], spot[1], "A")) continue;
      const after = build([PRO, spot], [[r, c]], "B");
      tried[key] = { kept: play(after, "B", PLIES, -Infinity, Infinity), dies: killable(after) };
    }
    if (!tried.middle || !tried.edge) continue;

    rows.push({
      enemy: nm(r, c),
      middleKept: tried.middle.kept,
      edgeKept: tried.edge.kept,
      middleDies: tried.middle.dies,
      edgeDies: tried.edge.dies,
    });
  }
}

console.log(`one enemy stone in the corner, then extending from C2 either way`);
console.log(`middle = B3 (2,1), edge = D1 (0,3); ${PLIES} plies of local play after\n`);
console.log(
  `${"enemy at".padStart(10)}${"middle keeps".padStart(14)}${"edge keeps".padStart(12)}` +
    `${"middle killable".padStart(17)}${"edge killable".padStart(15)}${"better".padStart(9)}`,
);
let middleBetter = 0;
let edgeBetter = 0;
let level = 0;
let middleKills = 0;
let edgeKills = 0;
for (const row of rows) {
  // Safety first — a group that can be forced is worth nothing, whatever it holds.
  let better = "level";
  if (row.middleDies !== row.edgeDies) better = row.middleDies ? "edge" : "middle";
  else if (row.middleKept !== row.edgeKept) better = row.middleKept > row.edgeKept ? "middle" : "edge";
  if (better === "middle") middleBetter += 1;
  else if (better === "edge") edgeBetter += 1;
  else level += 1;
  if (row.middleDies) middleKills += 1;
  if (row.edgeDies) edgeKills += 1;
  console.log(
    `${row.enemy.padStart(10)}${String(row.middleKept).padStart(14)}${String(row.edgeKept).padStart(12)}` +
      `${(row.middleDies ? "yes" : "no").padStart(17)}${(row.edgeDies ? "yes" : "no").padStart(15)}` +
      `${better.padStart(9)}`,
  );
}
console.log(
  `\nover ${rows.length} enemy placements: middle better ${middleBetter}, edge better ${edgeBetter},` +
    ` level ${level}`,
);
console.log(`killable after extending: middle ${middleKills}, edge ${edgeKills}`);
