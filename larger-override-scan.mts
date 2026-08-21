/**
 * Does the "larger enclosure" upgrade ever overrule a stage that said ground
 * does not compete?
 *
 * findBestMoveVeryHard runs largerVersionOf on whatever the ladder returned,
 * with no regard for which stage returned it. Stage 1's own comment says a
 * forced capture "still outranks any amount of ground", and stage 1.5's says
 * "no amount of ground is actually a competing option" — and both are handed
 * to a function whose entire job is to trade the move for more ground. The only
 * check on the swap is that the replacement is not itself capturable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision, cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
applyAIVariant("EYE_INSIDE");
if (!cornerBookEnabled) throw new Error("variant did not take");
const STRIDE = Number(process.env.STRIDE ?? 4);
const urgent = (s: string) => /^(1 |1\.5 |1\.75 |1\.85 |1\.86 )/.test(s);

const hits = new Map<string, number>();
let turns = 0, seen = 0, larger = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s = createInitialState();
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng && m.type === "PLACE") {
        seen += 1;
        if (seen % STRIDE === 0) {
          turns += 1;
          findBestMoveVeryHard(s, eng, 900);
          const full = lastDecision.stage;
          if (full.includes("+ larger")) {
            larger += 1;
            const base = full.split(" +")[0];
            if (urgent(base)) hits.set(base, (hits.get(base) ?? 0) + 1);
          }
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}
console.log(`엔진 턴 ${turns}개 중 "+ larger" 로 바뀐 수 ${larger}개 (${((larger / turns) * 100).toFixed(1)}%)`);
console.log(`그 중 급한 단계(1, 1.5, 1.75, 1.85, 1.86)의 수를 바꾼 것:`);
if (hits.size === 0) console.log("  없음");
for (const [k, v] of [...hits.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)}${v}`);
