/**
 * Marks which fixture cases have a move worth pinning.
 *
 * The stage a position routes to is stable; the move inside that stage is not
 * always, because the search is on a clock and a tie between two candidates can
 * fall either way depending on how much of the last iteration fits. Two of 63
 * cases drifted that way between the generator and the test run, which would
 * make the suite fail on a busy machine and teach everyone to ignore it.
 *
 * So rather than loosen the assertion with a tolerance — which would hide a
 * narrow real regression as readily as it hides a tie — this decides each case
 * repeatedly and records whether the move was ever in doubt. The test then pins
 * the moves that are facts about the position and leaves the ties to the
 * routing assertion, which covers them anyway.
 *
 *   npx vite-node screen-stage-fixture.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision, cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const PATH = "src/games/alley-boss-cats/engine/stageRouting.fixture.json";
const RUNS = Number(process.env.RUNS ?? 6);
const COLS = "ABCDEFGHI";

type Case = { stage: string; move: string; moves: Array<[number, number]>; engine: Player; moveStable?: boolean };
const fixture = JSON.parse(readFileSync(PATH, "utf8")) as {
  variant: string; budgetMs: number; cases: Case[];
};

applyAIVariant(fixture.variant as any);
if (!cornerBookEnabled) throw new Error("variant did not take");

let stable = 0;
for (const kase of fixture.cases) {
  const seen = new Set<string>();
  const stages = new Set<string>();
  for (let run = 0; run < RUNS; run += 1) {
    let s: GameState = createInitialState();
    for (const [r, c] of kase.moves) s = applyAction(s, { type: "PLACE", row: r, col: c });
    const a = findBestMoveVeryHard(s, kase.engine as Player, fixture.budgetMs);
    seen.add(a.type === "PLACE" ? `${COLS[a.col]}${a.row + 1}` : "PASS");
    stages.add(lastDecision.stage.split(" +")[0]);
  }
  kase.moveStable = seen.size === 1 && seen.has(kase.move);
  if (kase.moveStable) stable += 1;
  else console.error(`  흔들림 ${kase.stage} ${kase.moves.length + 1}수: ${[...seen].join(" / ")}`);
  if (stages.size > 1) console.error(`  ** 단계도 흔들림: ${[...stages].join(" / ")}`);
}

writeFileSync(PATH, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`\n${fixture.cases.length}개 중 수까지 고정 가능한 것 ${stable}개 (${RUNS}회 일치)`);
