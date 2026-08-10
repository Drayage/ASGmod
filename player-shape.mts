/**
 * The player's actual shape, tested as described.
 *
 * Not the corner anti-diagonal I first built — theirs starts on the (1,2) point
 * and steps diagonally along the edge: (0,1) towards the corner for the small
 * version, (0,3) the other way when the opponent attacks. In the top-left that
 * is C2, then B1, then D1, each a diagonal step from the last.
 *
 * Asked of the rules: what does each stage enclose, and can it be taken? The
 * opponent is given the move and a deep capture read at every stage, and then
 * the same again after the most natural attacking stone.
 *
 *   npx vite-node player-shape.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const at = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0]) });
const cls = (s: string) => {
  const { row, col } = at(s);
  const dr = Math.min(row, 8 - row);
  const dc = Math.min(col, 8 - col);
  return dr <= dc ? `(${dr},${dc})` : `(${dc},${dr})`;
};

function build(mine: string[], theirs: string[] = []): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const p of mine) { const c = at(p); board[c.row][c.col] = playerCell("A"); }
  for (const p of theirs) { const c = at(p); board[c.row][c.col] = playerCell("B"); }
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: "B" };
}

function report(label: string, mine: string[], theirs: string[] = []) {
  const state = build(mine, theirs);
  const eyes = state.territories.A.map((c) => `${COLS[c.col]}${c.row + 1}`).sort();
  const forced = findForcedCapture(state, "B", 9, 3000);
  console.log(
    `${label.padEnd(34)}${String(eyes.length).padStart(6)}  ${(eyes.join(",") || "-").padEnd(18)}` +
      `${forced ? "CAPTURABLE" : "safe"}`,
  );
}

console.log(`stones            ${["C2", "B1", "D1"].map((s) => `${s} ${cls(s)}`).join("   ")}\n`);
console.log(`${"position".padEnd(34)}${"cells".padStart(6)}  ${"which".padEnd(18)}opponent to move`);
report("C2 alone", ["C2"]);
report("C2 B1  (small, towards corner)", ["C2", "B1"]);
report("C2 B1 D1  (attacked, spread)", ["C2", "B1", "D1"]);
console.log();
report("...with an enemy stone at C3", ["C2", "B1", "D1"], ["C3"]);
report("...enemy C3 and E2", ["C2", "B1", "D1"], ["C3", "E2"]);
report("...enemy C3, E2, A2", ["C2", "B1", "D1"], ["C3", "E2", "A2"]);
console.log();
console.log(`the wider version — one more diagonal step outward`);
report("C2 B1 D1 F1", ["C2", "B1", "D1", "F1"]);
report("C2 B1 D1 E2", ["C2", "B1", "D1", "E2"]);
report("C2 B1 E2 F1", ["C2", "B1", "E2", "F1"]);
report("B1 D1 F1  (edge, all (0,x))", ["B1", "D1", "F1"]);
