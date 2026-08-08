/** Does offering the walling move change what the guard picks, and the outcome? */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision, setEyeMakingDefenceEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const F = process.argv[2]!;
const PLIES = Number(process.env.PLIES ?? 14);
const EYE_W = Number(process.env.EYE_W ?? 0);

for (const [game, point, eye, turn] of [["1","C8","C9",13],["2","D8","D9",13]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const human: Player = rec.playerSide;
  const ai = opponent(human);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };
  let s: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (m.turn === turn) break;
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" }) : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
  }
  console.log(`\ngame ${game} turn ${turn}: group ${point}, eye point ${eye}   (eyeSpaceWeight ${EYE_W})`);
  tuning.eyeSpaceWeight = EYE_W;
  for (const on of [false, true]) {
    setEyeMakingDefenceEnabled(on);
    const mv = findBestMoveVeryHard(s, ai, 3000);
    const at = mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS";
    let play = s;
    let outcome = "no capture";
    for (let ply = 0; ply < PLIES; ply += 1) {
      play = applyAction(play, findBestMoveVeryHard(play, play.currentPlayer, 3000));
      if (play.winner) { outcome = play.winner === ai ? "engine WINS" : "engine LOSES by capture"; break; }
    }
    const g = getConnectedGroup(play.board, anchor.row, anchor.col);
    console.log(
      `  walling ${on ? "ON " : "OFF"}: plays ${at.padEnd(4)}${at === eye ? "(fills its own eye)" : ""}` +
        `  [${lastDecision.stage}, ${lastDecision.candidates}/${lastDecision.poolSize}]` +
        `  →  ${outcome}, group ${g.length ? `alive on ${getGroupLiberties(play.board, g).size}` : "GONE"}`,
    );
  }
  setEyeMakingDefenceEnabled(false);
  tuning.eyeSpaceWeight = 0;
}
