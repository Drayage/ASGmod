/** Which stage picks the eye-filling move, and does the evaluation ever get a say? */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision, lastSearchScore } from "./src/games/alley-boss-cats/engine/minimax";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const C = "ABCDEFGHI";
const F = process.argv[2]!;
for (const [game, turn, eye] of [["1", 13, "C9"], ["2", 13, "D9"]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const ai: Player = opponent(rec.playerSide);
  let s: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (m.turn === turn) break;
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" }) : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
  }
  console.log(`\ngame ${game} turn ${turn} (eye point ${eye})`);
  for (const w of [0, 60, 300]) {
    tuning.eyeSpaceWeight = w;
    const mv = findBestMoveVeryHard(s, ai, 3000);
    const at = mv.type === "PLACE" ? `${C[mv.col]}${mv.row + 1}` : "PASS";
    console.log(
      `  w${String(w).padStart(3)}: ${at.padEnd(4)}${at === eye ? " (fills its own eye)" : ""}` +
        `   score ${lastSearchScore.toFixed(0).padStart(8)}` +
        `   stage ${lastDecision.stage} (${lastDecision.candidates}/${lastDecision.poolSize})`,
    );
  }
  tuning.eyeSpaceWeight = 0;
}
