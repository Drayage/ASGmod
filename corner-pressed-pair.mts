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
 * So this puts one enemy stone at every point in the corner in turn and extends
 * both ways from (1,2). The first version asked what each shape kept after five
 * plies and whether it could be forced, and both columns came back flat — twelve
 * placements, every one level, nothing killable. Three stones have too many
 * liberties to die and too few to settle anything inside a five-ply horizon.
 *
 * So it asks what actually discriminated in the empty case instead: of the
 * points left inside the corner, at how many can the opponent put a second stone
 * and keep it alive. Alongside it, the liberties the defending shape is left
 * with once the opponent has played its best local move — the closest thing to
 * "does it have an eye" that does not need a deep read.
 *
 *   npx vite-node corner-pressed-pair.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
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

interface Shape { lives: number; entries: number; room: number }
interface Row { enemy: string; middle: Shape; edge: Shape }
const rows: Row[] = [];

for (let r = 0; r < 5; r += 1) {
  for (let c = 0; c < 5; c += 1) {
    if (r === PRO[0] && c === PRO[1]) continue;
    if (r + c > REACH) continue;
    const base = build([PRO], [[r, c]], "A");
    if (base.board[r][c] !== playerCell("B")) continue;

    const tried: Record<"middle" | "edge", Shape | null> = { middle: null, edge: null };
    for (const [key, spot] of [["middle", MIDDLE], ["edge", EDGE]] as Array<["middle" | "edge", [number, number]]>) {
      if (spot[0] === r && spot[1] === c) continue;
      if (!isLegalMove(base, spot[0], spot[1], "A")) continue;
      const after = build([PRO, spot], [[r, c]], "B");

      // A second enemy stone, at every point still inside the corner triangle.
      let lives = 0;
      let entries = 0;
      for (const mv of local(after, "B")) {
        if (mv.row + mv.col > 3) continue;
        entries += 1;
        const invaded = build([PRO, spot], [[r, c], [mv.row, mv.col]], "A");
        if (findForcedCapture({ ...invaded, currentPlayer: "A" }, "A", 9, 1200) === null) lives += 1;
      }

      // Breathing room left to the defender's thinnest group once the opponent
      // has taken its best local point.
      let worstRoom = Infinity;
      for (const mv of local(after, "B")) {
        const pressed = build([PRO, spot], [[r, c], [mv.row, mv.col]], "A");
        let least = Infinity;
        for (const [gr, gc] of [PRO, spot] as Array<[number, number]>) {
          if (pressed.board[gr][gc] !== playerCell("A")) continue;
          least = Math.min(
            least,
            getGroupLiberties(pressed.board, getConnectedGroup(pressed.board, gr, gc)).size,
          );
        }
        worstRoom = Math.min(worstRoom, least);
      }

      tried[key] = { lives, entries, room: worstRoom === Infinity ? 0 : worstRoom };
    }
    if (!tried.middle || !tried.edge) continue;

    rows.push({ enemy: nm(r, c), middle: tried.middle, edge: tried.edge });
  }
}

console.log(`one enemy stone in the corner, then extending from C2 either way`);
console.log(`middle = B3 (2,1), edge = D1 (0,3); ${PLIES} plies of local play after\n`);
console.log(
  `${"enemy at".padStart(10)}${"middle: lives".padStart(15)}${"room".padStart(7)}` +
    `${"edge: lives".padStart(14)}${"room".padStart(7)}${"tighter".padStart(10)}`,
);
let middleBetter = 0;
let edgeBetter = 0;
let level = 0;
for (const row of rows) {
  const m = row.middle.entries ? row.middle.lives / row.middle.entries : 0;
  const e = row.edge.entries ? row.edge.lives / row.edge.entries : 0;
  const better = m < e ? "middle" : e < m ? "edge" : "level";
  if (better === "middle") middleBetter += 1;
  else if (better === "edge") edgeBetter += 1;
  else level += 1;
  console.log(
    `${row.enemy.padStart(10)}${`${row.middle.lives}/${row.middle.entries}`.padStart(15)}` +
      `${String(row.middle.room).padStart(7)}` +
      `${`${row.edge.lives}/${row.edge.entries}`.padStart(14)}${String(row.edge.room).padStart(7)}` +
      `${better.padStart(10)}`,
  );
}
const rate = (pick: (r: Row) => Shape) => {
  const lives = rows.reduce((a, r) => a + pick(r).lives, 0);
  const entries = rows.reduce((a, r) => a + pick(r).entries, 0);
  return `${lives}/${entries} (${entries ? Math.round((100 * lives) / entries) : 0}%)`;
};
console.log(
  `\nover ${rows.length} enemy placements: middle tighter ${middleBetter}, edge tighter ${edgeBetter},` +
    ` level ${level}`,
);
console.log(`invaders that live: middle ${rate((r) => r.middle)}, edge ${rate((r) => r.edge)}`);
const avg = (pick: (r: Row) => Shape) =>
  (rows.reduce((a, r) => a + pick(r).room, 0) / rows.length).toFixed(2);
console.log(`liberties left under pressure: middle ${avg((r) => r.middle)}, edge ${avg((r) => r.edge)}`);
void play; void killable; void PLIES;
