/**
 * What the ordering thinks of the diagonal.
 *
 * Asked of the rules, the corner diagonal is not merely alive — it is the only
 * one of these shapes that makes anything:
 *
 *   A3 B2 C1  (diagonal three)   3 confirmed cells, uncapturable
 *   A2 B2 B1  (triangle)         1 cell
 *   A2 B2 C2  (solid edge three) 0 cells
 *
 * Three stones on the diagonal wall off the corner triangle with the two board
 * edges, and each stone's liberties include points that are now confirmed
 * territory — which neither side may ever play in, so they cannot be filled.
 * That is why nothing kills it.
 *
 * The engine plays the diagonal follow-up 20% of the time and the human 79%. So
 * this asks what `localMoveScore` says about the choice, from a real corner
 * position with one stone down.
 *
 *   npx vite-node diagonal-score.mts
 */
import { localMoveScore } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { evaluateState, applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const at = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0]) });

function build(mine: string[], theirs: string[]): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const p of mine) { const c = at(p); board[c.row][c.col] = playerCell("A"); }
  for (const p of theirs) { const c = at(p); board[c.row][c.col] = playerCell("B"); }
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: "A" };
}

// One stone on the professional point of the bottom-left corner, opponent
// approaching from outside — the position the follow-up choice is made in.
const state = build(["B8"], ["D8", "B5"]);
const options = ["A9", "C9", "B9", "A7", "C7", "A8", "C8"];

console.log(`one stone at B8, opponent at D8 and B5 — where does the second stone go?\n`);
console.log(`${"move".padEnd(7)}${"shape".padEnd(13)}${"ordering".padStart(10)}${"cells settled".padStart(15)}${"evaluation".padStart(12)}`);
const base = evaluateState(state, "A");
for (const key of options) {
  const c = at(key);
  if (state.board[c.row][c.col] !== "EMPTY") continue;
  const dr = Math.abs(c.row - at("B8").row);
  const dc = Math.abs(c.col - at("B8").col);
  const shape = dr === 1 && dc === 1 ? "diagonal" : dr + dc === 1 ? "orthogonal" : "further";
  const after = applyAction(state, { type: "PLACE", row: c.row, col: c.col });
  console.log(
    `${key.padEnd(7)}${shape.padEnd(13)}` +
      `${localMoveScore(state.board, c.row, c.col, "A").toFixed(0).padStart(10)}` +
      `${String(after.territories.A.length).padStart(15)}` +
      `${(evaluateState(after, "A") - base).toFixed(0).padStart(12)}`,
  );
}
