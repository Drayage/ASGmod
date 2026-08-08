/** Does the cheap test flag the group in the two lost games, and when? */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

function cheapCanBreathe(board: Board, group: Coord[], liberties: Set<string>, player: Player): boolean {
  const own = playerCell(player);
  const inGroup = new Set(group.map((s) => `${s.row},${s.col}`));
  for (const filled of liberties) {
    const [row, col] = filled.split(",").map(Number);
    const after = new Set<string>();
    for (const other of liberties) if (other !== filled) after.add(other);
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr, c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] === "EMPTY") after.add(`${r},${c}`);
      else if (board[r][c] === own && !inGroup.has(`${r},${c}`)) {
        for (const k of getGroupLiberties(board, getConnectedGroup(board, r, c))) if (k !== filled) after.add(k);
      }
    }
    if (after.size > liberties.size) return true;
  }
  return false;
}
function realCanBreathe(state: GameState, anchor: Coord, before: number, player: Player): boolean {
  for (const move of getLegalMoves(state, player)) {
    const next = applyAction(state, { type: "PLACE", row: move.row, col: move.col });
    if (next.winner) continue;
    const g = getConnectedGroup(next.board, anchor.row, anchor.col);
    if (g.length > 0 && getGroupLiberties(next.board, g).size > before) return true;
  }
  return false;
}

const C = "ABCDEFGHI";
for (const [game, point] of [["1", "C8"], ["2", "D8"]] as const) {
  const rec = (JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const ai: Player = opponent(rec.playerSide);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };
  console.log(`\ngame ${game}, group ${point} (AI = ${ai})`);
  let state: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (state.winner) break;
    if (state.currentPlayer === ai) {
      const g = getConnectedGroup(state.board, anchor.row, anchor.col);
      if (g.length > 0) {
        const libs = getGroupLiberties(state.board, g);
        if (libs.size <= 3) {
          const cheap = cheapCanBreathe(state.board, g, libs, ai);
          const real = realCanBreathe(state, anchor, libs.size, ai);
          console.log(
            `  turn ${String(m.turn).padStart(2)}  libs ${libs.size}` +
              `   cheap: ${cheap ? "can breathe" : "SEALED"}` +
              `   truth: ${real ? "can breathe" : "SEALED"}` +
              `${cheap !== real ? "   <- disagree" : ""}`,
          );
        }
      }
    }
    state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
  }
}
