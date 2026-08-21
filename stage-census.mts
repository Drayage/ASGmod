/**
 * Does each stage of the ladder actually do its job?
 *
 * Three bugs in one session shared a shape: a rule whose stated intent and
 * whose behaviour had come apart, with no test pinning either. Two ways that
 * shows up in a census, and both have already caught something real —
 *
 *   - a stage that never fires is dead code wearing a comment (1.9 finishes a
 *     framework on 0.7% of turns against a 15.7% opportunity);
 *   - a stage that fires and then abandons its shortlist did not do the thing
 *     its name claims (1.87 widened on 14 of 14 turns across four games).
 *
 * So this replays the recorded games, re-decides every engine turn, and reports
 * both rates per stage. Anything at 0%, or anything whose reason evaporates
 * most of the time, is a rule to go and read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision, cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const MS = Number(process.env.MS ?? 1500);
const STRIDE = Number(process.env.STRIDE ?? 5);

applyAIVariant((process.env.V ?? "EYE_INSIDE") as any);
// See the warning on applyAIVariant: a silent no-op here would report STANDARD.
if (!cornerBookEnabled) throw new Error("variant did not take");

const fired = new Map<string, number>();
const widened = new Map<string, number>();
let turns = 0;
let seen = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng && m.type === "PLACE") {
        seen += 1;
        if (seen % STRIDE === 0) {
          turns += 1;
          findBestMoveVeryHard(s, eng, MS);
          const full = lastDecision.stage;
          const stage = full.split(" +")[0];
          fired.set(stage, (fired.get(stage) ?? 0) + 1);
          if (full.includes("widened")) widened.set(stage, (widened.get(stage) ?? 0) + 1);
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(`엔진 턴 ${turns}개 (${STRIDE}턴마다, ${MS}ms)\n`);
console.log(`${"단계".padEnd(30)}${"발동".padStart(7)}${"비중".padStart(9)}${"이유 증발".padStart(12)}`);
for (const [stage, n] of [...fired.entries()].sort((a, b) => b[1] - a[1])) {
  const w = widened.get(stage) ?? 0;
  console.log(
    `${stage.padEnd(30)}${String(n).padStart(7)}${`${((n / turns) * 100).toFixed(1)}%`.padStart(9)}` +
    `${(w === 0 ? "-" : `${w} (${((w / n) * 100).toFixed(0)}%)`).padStart(12)}`,
  );
}
