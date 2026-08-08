/**
 * Does the term actually save the group, or only change the move?
 *
 * At turn 13 it plays E8 where the engine played D9. Both raise the group's
 * liberties and D9 still lost, so "it defends" is not the question — "does the
 * group live" is. Plays the position out with both sides searching.
 *
 * Read with its limit in mind: the opponent here is the engine, and the engine
 * does not hunt a three-liberty group the way the person who won these games
 * did. A group that survives this may still not survive them.
 */
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
const PLIES = Number(process.env.PLIES ?? 16);

for (const [game, point, from] of [["1", "C8", 13], ["2", "D8", 13]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const human: Player = rec.playerSide;
  const ai = opponent(human);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };

  let base: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (m.turn === from) break;
    base = m.type === "PASS" ? applyAction(base, { type: "PASS" })
      : applyAction(base, { type: "PLACE", row: m.row!, col: m.col! });
  }

  console.log(`\ngame ${game}, group ${point}, playing out from turn ${from}`);
  for (const w of [0, 60, 150]) {
    tuning.sealedWeight = w;
    let s = base;
    let outcome = "still alive";
    for (let ply = 0; ply < PLIES; ply += 1) {
      const mv = findBestMoveVeryHard(s, s.currentPlayer, 3000);
      s = applyAction(s, mv);
      if (s.winner) { outcome = s.winner === ai ? "engine WINS by capture" : "engine LOSES by capture"; break; }
      const g = getConnectedGroup(s.board, anchor.row, anchor.col);
      if (g.length === 0) { outcome = "group gone"; break; }
    }
    const g = getConnectedGroup(s.board, anchor.row, anchor.col);
    const libs = g.length ? getGroupLiberties(s.board, g).size : 0;
    console.log(`  sealedWeight ${String(w).padStart(3)}: ${outcome.padEnd(24)} group at ${libs} liberties after ${PLIES} plies`);
  }
  tuning.sealedWeight = 0;
}
