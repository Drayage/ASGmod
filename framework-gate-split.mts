/**
 * Which gate throws the big frames away.
 *
 * Widening the shape dictionary changed nothing the denial stage could act on:
 * with strips on, the opponent has 9-, 18- and 27-cell frames on the board and
 * the stage still only ever sees six-cell triangles. So the dictionary is not
 * the last gate. Stage 1.87 requires `secure && 0 < movesToClose <= 3`, and
 * those two ask different questions with different answers — "an invader lives
 * in it" and "it is too far from done" need opposite fixes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { rankFrameworks } from "./src/games/alley-boss-cats/engine/frameworks";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
applyAIVariant((process.env.V ?? "EYE_STRIP") as any);
const STRIDE = Number(process.env.STRIDE ?? 6);
const BIG = Number(process.env.BIG ?? 10);

let seen = 0;
let bothFail = 0;
let onlyInsecure = 0;
let onlyTooFar = 0;
let pass = 0;
const gaps: number[] = [];

let turn = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng) {
        turn += 1;
        if (turn % STRIDE === 0) {
          for (const v of rankFrameworks(s, human, 300)) {
            if (v.frame.enclosed.length < BIG) continue; // only the ones worth denying
            seen += 1;
            const insecure = !v.secure;
            const tooFar = v.movesToClose === 0 || v.movesToClose > 3;
            if (insecure && tooFar) bothFail += 1;
            else if (insecure) onlyInsecure += 1;
            else if (tooFar) onlyTooFar += 1;
            else pass += 1;
            if (insecure) gaps.push(v.movesToClose);
          }
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const pc = (n: number) => `${((n / seen) * 100).toFixed(1)}%`;
console.log(`${BIG}칸 이상 상대 틀 ${seen}개 (${STRIDE}턴마다 표본)\n`);
console.log(`  둘 다 실패            ${String(bothFail).padStart(6)}  ${pc(bothFail)}`);
console.log(`  침입이 산다 (secure X) ${String(onlyInsecure).padStart(6)}  ${pc(onlyInsecure)}`);
console.log(`  완성까지 멀다 (3수 초과)${String(onlyTooFar).padStart(6)}  ${pc(onlyTooFar)}`);
console.log(`  통과                  ${String(pass).padStart(6)}  ${pc(pass)}`);
gaps.sort((a, b) => a - b);
console.log(`\n침입이 산다고 판정된 틀의 '완성까지 남은 수' 중앙값 ${gaps[Math.floor(gaps.length / 2)]}`);
