/**
 * Is a three-stone corner eye really unkillable?
 *
 * The player's shape: when pressed, play diagonally and aim to make one eye with
 * three stones. One eye is life here, so if the shape both makes an eye and
 * cannot be taken, it is a complete answer to being attacked — and worth knowing
 * exactly, since the engine's whole defensive ladder is built on liberty counts.
 *
 * So this builds the small corner shapes by hand, asks the rules whether they
 * enclose a confirmed point, and then hands the position to the capture reader
 * with the opponent to move and a deep budget to try to refute it.
 *
 *   npx vite-node eye-shapes.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const at = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0]) });

function build(mine: string[], theirs: string[] = []): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const p of mine) { const c = at(p); board[c.row][c.col] = playerCell("A"); }
  for (const p of theirs) { const c = at(p); board[c.row][c.col] = playerCell("B"); }
  const territories = calculateTerritories(board);
  return { ...base, board, territories, currentPlayer: "B" };
}

const shapes: Array<{ name: string; mine: string[] }> = [
  { name: "corner pair, diagonal   A2 B1", mine: ["A2", "B1"] },
  { name: "corner triangle         A2 B2 B1", mine: ["A2", "B2", "B1"] },
  { name: "corner diagonal three   A3 B2 C1", mine: ["A3", "B2", "C1"] },
  { name: "corner three, bent      A2 B2 C1", mine: ["A2", "B2", "C1"] },
  { name: "edge three, solid       A2 B2 C2", mine: ["A2", "B2", "C2"] },
  { name: "edge four, box          A2 B2 A3 B3", mine: ["A2", "B2", "A3", "B3"] },
  { name: "diagonal three, open    B2 C3 D4", mine: ["B2", "C3", "D4"] },
];

console.log(`three-stone corner shapes, asked of the rules and then of the capture reader\n`);
console.log(`${"shape".padEnd(28)}${"eye cells".padStart(11)}${"which".padStart(10)}${"opponent can force a capture".padStart(30)}`);
for (const { name, mine } of shapes) {
  const state = build(mine);
  const eyes = state.territories.A;
  const forced = findForcedCapture(state, "B", 9, 3000);
  console.log(
    `${name.padEnd(28)}${String(eyes.length).padStart(11)}` +
      `${(eyes.map((c) => `${COLS[c.col]}${c.row + 1}`).join(",") || "-").padStart(10)}` +
      `${(forced ? `yes, ${COLS[(forced.move as any).col]}${(forced.move as any).row + 1}` : "no").padStart(30)}`,
  );
}
void BOARD_SIZE;
