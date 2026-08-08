/**
 * How the engine is being captured, position by position.
 *
 * Two games on the same build ended the same way at move 20, and the player
 * reports it was nearly the same method both times. A shared method is worth
 * more than a shared outcome: it means one shape the engine does not read, which
 * is findable.
 *
 * Prints the board a few moves before the end, what the engine played each turn,
 * and what its own search thought at the time.
 *
 *   npx vite-node capture-post.mts <export.json> <game#> [movesBack]
 */
import { readFileSync } from "node:fs";
import { applyAction, projectedMargin } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findEndangeredGroups, getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { BOARD_SIZE, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const [, , path, gameArg, backArg] = process.argv;
const BACK = Number(backArg ?? 8);
const rec = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records[Number(gameArg) - 1];
const human: Player = rec.playerSide;
const ai = opponent(human);
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;

function render(s: GameState): string {
  const out = [`     ${[...C].join(" ")}`];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const v = s.board[r][c];
      row.push(v === "PLAYER_A" ? "A" : v === "PLAYER_B" ? "B" : v === "NEUTRAL" ? "#" : ".");
    }
    out.push(`  ${String(r + 1).padStart(2)} ${row.join(" ")}`);
  }
  return out.join("\n");
}

console.log(`game ${gameArg}: human ${human}, AI ${ai} — ${rec.winReason}, ${rec.moveHistory.length} moves`);
console.log(`the AI is ${ai}\n`);

const total = rec.moveHistory.length;
let state: GameState = createInitialState();
for (const [i, m] of rec.moveHistory.entries()) {
  if (state.winner) break;
  const mover = state.currentPlayer;
  const show = i >= total - BACK;
  if (show) {
    const label = mover === ai ? "AI  " : "human";
    const at = m.type === "PLACE" ? nm(m.row, m.col) : "PASS";
    // The engine's own read, and which of its groups were already thin.
    const thin = getAllGroups(state.board, ai)
      .map((g) => ({ g, libs: getGroupLiberties(state.board, g).size }))
      .filter((x) => x.libs <= 2)
      .map((x) => `{${x.g.map((s) => nm(s.row, s.col)).join(" ")}}:${x.libs}`);
    const atari = findEndangeredGroups(state, ai).length;
    console.log(
      `  move ${String(m.turn).padStart(2)} ${label} ${at.padEnd(4)}` +
        `   AI margin ${projectedMargin(state, ai).toFixed(1).padStart(6)}` +
        `   AI groups at <=2 libs: ${thin.length ? thin.join(", ") : "none"}` +
        (atari ? `   IN ATARI: ${atari}` : ""),
    );
  }
  state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
    : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
}

console.log(`\nfinal position (AI = ${ai}):`);
console.log(render(state));
console.log(`\nwinner ${state.winner} by ${state.winReason}`);
if (state.capturedGroup) {
  console.log(`captured group: ${state.capturedGroup.map((c: any) => nm(c.row, c.col)).join(" ")}`);
}
