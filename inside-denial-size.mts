/**
 * How big are the frames stage 1.87 falls inside of?
 *
 * The arena says the inside fallback costs games: 42.9% of 240, with the upper
 * end of the interval below even, while holding *more* territory (+0.28 cells).
 * That combination is what a stone dying inside enemy ground looks like — one
 * capture ends the game, so a few extra cells and a worse record is exactly the
 * trade a doomed invasion makes.
 *
 * The rule fires without ever asking what the region is worth. A corner cut of
 * depth d encloses d(d+1)/2 cells — 6, 10, 15, 21, 28 — so "deny it from the
 * inside" currently risks a stone on a six-cell frame the same as on a
 * twenty-one-cell one. This counts which sizes it actually fires on, so the
 * threshold is picked from the distribution rather than from taste.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import type { AIAction } from "./src/games/alley-boss-cats/ai";
import { rankFrameworks } from "./src/games/alley-boss-cats/engine/frameworks";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const FRAMEWORK_MAX_GAPS = 3;
applyAIVariant((process.env.V ?? "EYE_DENY") as any);

const bySize = new Map<number, number>();
let turns = 0;
let firing = 0;

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
        turns += 1;
        const pool = getSafeActions(s, eng).pool as AIAction[];
        const safe = new Set(
          pool.filter((a): a is Extract<AIAction, { type: "PLACE" }> => a.type === "PLACE")
            .map((a) => `${a.row},${a.col}`),
        );
        let best = 0;
        for (const v of rankFrameworks(s, human, 300)) {
          if (!v.secure) continue;
          if (v.movesToClose === 0 || v.movesToClose > FRAMEWORK_MAX_GAPS) continue;
          // Only frames it could actually play inside of.
          const usable = v.frame.enclosed.some(
            (c) => safe.has(`${c.row},${c.col}`) && isLegalMove(s, c.row, c.col, eng),
          );
          if (usable) best = Math.max(best, v.frame.enclosed.length);
        }
        if (best > 0) {
          firing += 1;
          bySize.set(best, (bySize.get(best) ?? 0) + 1);
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(`엔진 턴 ${turns}개 중 안쪽 견제가 발동 가능한 턴 ${firing}개 (${((firing / turns) * 100).toFixed(1)}%)\n`);
console.log(`${"틀 크기".padStart(8)}${"턴".padStart(8)}${"발동 중 비중".padStart(14)}${"이 값 이상만 허용시 남는 턴".padStart(28)}`);
const sizes = [...bySize.keys()].sort((a, b) => a - b);
for (const size of sizes) {
  const atLeast = sizes.filter((s) => s >= size).reduce((n, s) => n + (bySize.get(s) ?? 0), 0);
  console.log(
    `${String(size).padStart(8)}${String(bySize.get(size)).padStart(8)}` +
    `${`${(((bySize.get(size) ?? 0) / firing) * 100).toFixed(1)}%`.padStart(14)}` +
    `${`${atLeast} (${((atLeast / firing) * 100).toFixed(1)}%)`.padStart(28)}`,
  );
}
