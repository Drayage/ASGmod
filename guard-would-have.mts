/**
 * Would the guard I removed have defended the group?
 *
 * The captured group sat at three liberties for four consecutive engine turns
 * while the opponent built around it, with moves available the whole time that
 * would have raised its liberty count. `thinGroupDanger` — stage 1.75 — exists
 * to find exactly those, and it was switched off earlier today on an arena run
 * that reported captures suffered unchanged at 22:22.
 *
 * This replays those turns with the guard both ways and prints what each plays,
 * alongside whether the move raises the group's liberties at all.
 *
 *   npx vite-node guard-would-have.mts <export.json> <game#> <point> <turn...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision, setThinGroupGuardEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const [, , path, gameArg, pointArg, ...turnArgs] = process.argv;
const rec = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records[Number(gameArg) - 1];
const human: Player = rec.playerSide;
const ai = opponent(human);
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const anchor = { row: Number(pointArg.slice(1)) - 1, col: C.indexOf(pointArg[0].toUpperCase()) };
const wanted = new Set(turnArgs.map(Number));

console.log(`game ${gameArg}: AI ${ai}, group at ${pointArg}\n`);
let state: GameState = createInitialState();
for (const m of rec.moveHistory) {
  if (state.winner) break;
  if (wanted.has(m.turn) && state.currentPlayer === ai) {
    const g = getConnectedGroup(state.board, anchor.row, anchor.col);
    const libs = getGroupLiberties(state.board, g).size;
    const raises = (act: any) => {
      if (act.type !== "PLACE") return false;
      const next = applyAction(state, act);
      if (next.winner) return false;
      const after = getConnectedGroup(next.board, anchor.row, anchor.col);
      return after.length > 0 && getGroupLiberties(next.board, after).size > libs;
    };
    const played = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
    console.log(`  turn ${String(m.turn).padStart(2)}  group at ${libs} liberties, played ${played} on the day`);
    for (const guard of [false, true]) {
      setThinGroupGuardEnabled(guard);
      const mv = findBestMoveVeryHard(state, ai, 3000);
      const at = mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS";
      console.log(
        `        guard ${guard ? "ON " : "OFF"}: ${at.padEnd(4)} ` +
          `${raises(mv) ? "raises its liberties" : "does not help the group"}` +
          `   [${lastDecision.stage}]`,
      );
    }
    setThinGroupGuardEnabled(false);
  }
  state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
    : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
}
