/** Does the term change the moves that lost those two games? */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const F = process.argv[2]!;
const WEIGHTS = (process.env.WEIGHTS ?? "0,60,150").split(",").map(Number);
for (const [game, point, turns] of [["1","C8",[13,15]],["2","D8",[7,9,11,13]]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const ai: Player = opponent(rec.playerSide);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };
  console.log(`\ngame ${game}, group ${point}`);
  let state: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (state.winner) break;
    if ((turns as readonly number[]).includes(m.turn) && state.currentPlayer === ai) {
      const g = getConnectedGroup(state.board, anchor.row, anchor.col);
      const libs = getGroupLiberties(state.board, g).size;
      const played = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
      const line: string[] = [];
      for (const w of WEIGHTS) {
        tuning.sealedWeight = w;
        const mv = findBestMoveVeryHard(state, ai, 3000);
        const next = applyAction(state, mv);
        const after = getConnectedGroup(next.board, anchor.row, anchor.col);
        const helps = after.length > 0 && getGroupLiberties(next.board, after).size > libs;
        line.push(`w${w}:${(mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS")}${helps ? "+" : " "}`);
      }
      tuning.sealedWeight = 0;
      console.log(`  turn ${String(m.turn).padStart(2)} libs ${libs}  played ${played.padEnd(4)}   ${line.join("   ")}`);
    }
    state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
  }
}
console.log(`\n  "+" means the move raises that group's liberty count`);
