/**
 * Adding to a corner that is already full, while another sits empty.
 *
 * The player's question: with a corner still unbuilt, is a sixth or tenth stone
 * in another one the right move? §88 says the return curve flattens — over 100
 * counted games a quadrant's cells barely move past five or six stones — and
 * that the piling is not the book's doing but the search's.
 *
 * So this counts the moves where that trade was actually available: the engine
 * adds to a quadrant it already holds five or more stones in, while some other
 * quadrant holds one or none of its stones, and reports which stage chose it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision, cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const QUADS = ["위왼", "위오", "아래왼", "아래오"];
const FULL = Number(process.env.FULL ?? 5);
const EMPTY = Number(process.env.EMPTY ?? 1);
const STRIDE = Number(process.env.STRIDE ?? 3);

applyAIVariant((process.env.V ?? "EYE_PAIR") as any);
if (!cornerBookEnabled) throw new Error("variant did not take");

const byStage = new Map<string, number>();
let turns = 0, sampled = 0, piled = 0;

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
        turns += 1;
        const mine: Record<string, number> = {};
        for (const q of QUADS) mine[q] = 0;
        for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
          if (s.board[r][c] === playerCell(eng)) mine[quad(r, c)] += 1;
        }
        const here = quad(m.row, m.col);
        const thin = QUADS.filter((q) => q !== here && mine[q] <= EMPTY);
        if (mine[here] >= FULL && thin.length > 0) {
          piled += 1;
          if (piled % STRIDE === 0) {
            sampled += 1;
            findBestMoveVeryHard(s, eng, 900);
            const stage = lastDecision.stage.split(" +")[0];
            byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
          }
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(
  `엔진 턴 ${turns}개 중, 이미 자기 돌 ${FULL}개 이상인 귀에 또 두면서 ` +
  `자기 돌 ${EMPTY}개 이하인 귀가 남아 있던 수: ${piled}개 (${((piled / turns) * 100).toFixed(1)}%)\n`,
);
console.log(`그 수를 고른 단계 (${sampled}개 표본)`);
for (const [stage, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stage.padEnd(30)}${String(n).padStart(4)}  ${((n / sampled) * 100).toFixed(0)}%`);
}
