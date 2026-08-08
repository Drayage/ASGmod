/** Does the term actually move when the eye point is filled? */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const C = "ABCDEFGHI";
const at = (p: string) => ({ row: Number(p.slice(1)) - 1, col: C.indexOf(p[0]) });
const F = process.argv[2]!;
tuning.eyeSpaceWeight = 1; // 1 point per unit, so the number *is* the count
for (const [game, turn, eye, alts] of [
  ["1", 13, "C9", ["B9", "D9", "C7"]],
  ["2", 13, "D9", ["C9", "E9", "C8"]],
] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const ai: Player = opponent(rec.playerSide);
  let s: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (m.turn === turn) break;
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" }) : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
  }
  const before = evaluateComponents(s, ai).eyeSpace ?? 0;
  console.log(`\ngame ${game} turn ${turn}: eyeSpace before any move = ${before}`);
  for (const p of [eye, ...alts]) {
    const parts = evaluateComponents(applyAction(s, { type: "PLACE", ...at(p) }), ai);
    console.log(
      `  after ${p}${p === eye ? " (the eye point)" : ""}: eyeSpace ${(parts.eyeSpace ?? 0).toFixed(0)}` +
        `   myLiberties ${(parts.myLiberties ?? 0).toFixed(0)}   thin ${(parts.thin ?? 0).toFixed(0)}`,
    );
  }
}
tuning.eyeSpaceWeight = 0;
