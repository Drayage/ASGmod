/** What does the engine actually play differently, ply by ply, under the new term? */
import { readFileSync } from "node:fs";
import { applyAction, setSealedLibertyThreshold, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";

const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const [path, recordId, fromArg, threshArg, weightArg, upToArg] = process.argv.slice(2);
const from = Number(fromArg);
const threshold = Number(threshArg);
const weight = Number(weightArg);
const upTo = Number(upToArg ?? 45);

const all = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records;
const rec = all.find((r: any) => r.id === recordId);
const human: Player = rec.playerSide;
const ai = opponent(human);

applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);
setSealedLibertyThreshold(threshold);
tuning.sealedWeight = weight;

let s: GameState = createInitialState();
let ply = 0;
for (const m of rec.moveHistory) {
  if (s.winner) break;
  ply += 1;
  if (ply > upTo) break;
  if (ply < from) {
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" })
      : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
    continue;
  }
  if (s.currentPlayer === ai) {
    const mv = findBestMoveVeryHard(s, ai, 2600);
    const recordedStr = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
    const playedStr = mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS";
    const same = mv.type === m.type && (mv.type !== "PLACE" || (mv.row === m.row && mv.col === m.col));
    console.log(`ply ${String(ply).padStart(3)}  engine played ${playedStr.padEnd(4)} (recorded: ${recordedStr})${same ? "" : "  <-- DIFFERENT"}`);
    s = applyAction(s, mv);
  } else {
    if (m.type === "PLACE" && !isLegalMove(s, m.row!, m.col!, human)) {
      console.log(`ply ${ply}  recorded human move ${nm(m.row!, m.col!)} no longer legal here -- stopping`);
      break;
    }
    const playedStr = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
    console.log(`ply ${String(ply).padStart(3)}  human played  ${playedStr}`);
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" })
      : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
  }
}
tuning.sealedWeight = 0;
setSealedLibertyThreshold(3);
