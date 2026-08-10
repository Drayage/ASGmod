/**
 * The six-cell frame while it is still being built.
 *
 * Finished, (1,2) (0,3) (2,1) (3,0) encloses six cells and the opponent cannot
 * come in at all — confirmed territory is unplayable by either side, so "if they
 * invade" only applies before the fourth stone lands.
 *
 * So this interrupts it. Two stones down, then three, and the opponent gets a
 * free move anywhere inside or on the frame line. For each intrusion: can the
 * defender still reach a confirmed cell within their next two moves, and can the
 * intruding stone be captured?
 *
 *   npx vite-node frame-under-attack.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const at = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0]) });
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

function build(mine: string[], theirs: string[], toMove: "A" | "B"): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const p of mine) { const c = at(p); board[c.row][c.col] = playerCell("A"); }
  for (const p of theirs) { const c = at(p); board[c.row][c.col] = playerCell("B"); }
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

/** Most cells A can confirm within `depth` of its own moves, opponent passing. */
function bestReach(state: GameState, depth: number): number {
  let best = state.territories.A.length;
  if (depth === 0) return best;
  for (const mv of getLegalMoves(state, "A")) {
    const board = state.board.map((r) => [...r]);
    board[mv.row][mv.col] = playerCell("A");
    const next: GameState = { ...state, board, territories: calculateTerritories(board) };
    best = Math.max(best, bestReach(next, depth - 1));
  }
  return best;
}

const FRAME = ["C2", "D1", "B3", "A4"];
const area = ["A1", "B1", "C1", "A2", "B2", "A3", "C3", "B4", "D2", "A5", "E1"];

for (const built of [2, 3]) {
  const mine = FRAME.slice(0, built);
  console.log(`\n${built} of the frame down: ${mine.join(" ")}`);
  console.log(`  ${"they play".padEnd(11)}${"A can confirm".padStart(14)}${"in moves".padStart(10)}${"their stone".padStart(14)}`);
  for (const spot of area) {
    const c = at(spot);
    const before = build(mine, [], "B");
    if (before.board[c.row][c.col] !== "EMPTY") continue;
    const after = build(mine, [spot], "A");
    let cells = 0;
    let need = 0;
    for (let d = 1; d <= 2; d += 1) {
      cells = bestReach(after, d);
      if (cells > 0) { need = d; break; }
    }
    const theirs = findForcedCapture({ ...after, currentPlayer: "A" }, "A", 7, 1500);
    console.log(
      `  ${spot.padEnd(11)}${String(cells).padStart(14)}${(need || "-").toString().padStart(10)}` +
        `${(theirs ? `dies to ${nm((theirs.move as any).row, (theirs.move as any).col)}` : "lives").padStart(14)}`,
    );
  }
}
