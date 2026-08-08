/**
 * The whole life of the group that got captured.
 *
 * Turn 19 it is dead; turn 17 it is already unsavable. So walk from the start:
 * for every engine turn, how many liberties the group has, whether any legal
 * move would lift it back to three or more, and what the engine actually played.
 * The last turn with an escape available is the move that lost the game.
 *
 *   npx vite-node group-trace.mts <export.json> <game#> <point-in-the-group>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const [, , path, gameArg, pointArg] = process.argv;
const rec = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records[Number(gameArg) - 1];
const human: Player = rec.playerSide;
const ai = opponent(human);
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const anchor = { row: Number(pointArg.slice(1)) - 1, col: C.indexOf(pointArg[0].toUpperCase()) };

console.log(`game ${gameArg}: AI is ${ai}, following the group at ${pointArg}\n`);
console.log(`${"turn".padStart(5)}${"by".padStart(7)}${"move".padStart(6)}${"libs".padStart(6)}   escape available?`);

let state: GameState = createInitialState();
for (const m of rec.moveHistory) {
  if (state.winner) break;
  const mover = state.currentPlayer;
  const g = getConnectedGroup(state.board, anchor.row, anchor.col);
  const libs = g.length ? getGroupLiberties(state.board, g).size : 0;

  let note = "";
  if (mover === ai && g.length > 0 && libs <= 3) {
    const lifts: string[] = [];
    for (const act of getSafeActions(state, ai).pool) {
      if (act.type !== "PLACE") continue;
      const next = applyAction(state, act);
      if (next.winner) continue;
      const after = getConnectedGroup(next.board, anchor.row, anchor.col);
      if (after.length > 0 && getGroupLiberties(next.board, after).size > libs) {
        lifts.push(nm(act.row, act.col));
      }
    }
    note = lifts.length ? `raises it: ${lifts.slice(0, 8).join(" ")}` : "nothing raises it";
  }

  const at = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
  const took = note.startsWith("raises") && note.includes(at) ? "  <- PLAYED ONE" : "";
  if (g.length > 0) {
    console.log(
      `${String(m.turn).padStart(5)}${(mover === ai ? "AI" : "human").padStart(7)}` +
        `${at.padStart(6)}${String(libs).padStart(6)}   ${note}${took}`,
    );
  }
  state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
    : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
}
