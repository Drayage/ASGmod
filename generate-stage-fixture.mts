/**
 * Builds the fixture behind stageRouting.test.ts.
 *
 * Three of this session's six defects changed which stage handled a position,
 * or what that stage then played, and no test noticed — the engine has 45
 * behavioural flags and 8 of them are named anywhere in the suite. A flag-value
 * test would not have caught any of the three either: each flag held exactly the
 * value it was set to, and the rule still did the wrong thing.
 *
 * What catches that is pinning the decision itself. This walks the recorded
 * games, finds positions that route to each stage of the ladder, keeps only the
 * ones that route there repeatably, and writes them out as move sequences the
 * test can replay without needing the recordings.
 *
 * Repeatability is the whole difficulty: the ladder is on a clock, so a position
 * near a boundary can land on either side of it. Each candidate is decided
 * several times and kept only if every run agrees, which leaves a fixture that
 * fails on a real change rather than on a slow machine.
 *
 *   npx vite-node generate-stage-fixture.mts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision, cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const OUT = "src/games/alley-boss-cats/engine/stageRouting.fixture.json";
const VARIANT = "EYE_INSIDE";
/** Runs that all have to agree before a position is trusted in the fixture. */
const CONFIRMATIONS = 3;
/** Budget the fixture is recorded at; the test replays at the same one. */
const MS = 1200;
/** Enough per stage to catch a routing change, few enough to stay quick. */
const PER_STAGE = 4;

applyAIVariant(VARIANT);
if (!cornerBookEnabled) throw new Error("variant did not take — see applyAIVariant's warning");

type Case = { stage: string; move: string; moves: Array<[number, number]>; engine: Player };
const chosen = new Map<string, Case[]>();
const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;

function decide(moves: Array<[number, number]>, engine: Player) {
  let s: GameState = createInitialState();
  for (const [r, c] of moves) s = applyAction(s, { type: "PLACE", row: r, col: c });
  const a = findBestMoveVeryHard(s, engine, MS);
  return { stage: lastDecision.stage, move: a.type === "PLACE" ? nm(a.row, a.col) : "PASS" };
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
outer: for (const file of files) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    const prefix: Array<[number, number]> = [];
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (m.type === "PASS") break; // the fixture replays placements only
      if (s.currentPlayer === engine) {
        const first = decide(prefix, engine);
        const stage = first.stage;
        const bucket = chosen.get(stage) ?? [];
        if (bucket.length < PER_STAGE) {
          // Same answer every time, or it is not a fact about the position.
          let stable = true;
          for (let i = 1; i < CONFIRMATIONS && stable; i += 1) {
            const again = decide(prefix, engine);
            if (again.stage !== stage || again.move !== first.move) stable = false;
          }
          if (stable) {
            bucket.push({ stage, move: first.move, moves: [...prefix], engine });
            chosen.set(stage, bucket);
            console.error(`  ${stage} <- ${file.slice(0, 8)} ${prefix.length + 1}수 (${first.move})`);
          }
        }
      }
      prefix.push([m.row, m.col]);
      s = applyAction(s, { type: "PLACE", row: m.row, col: m.col });
      if (prefix.length > 40) break;
    }
    // Enough of everything the ladder actually reaches.
    if ([...chosen.values()].every((b) => b.length >= PER_STAGE) && chosen.size >= 8) break outer;
  }
}

const cases = [...chosen.values()].flat();
writeFileSync(OUT, `${JSON.stringify({ variant: VARIANT, budgetMs: MS, cases }, null, 2)}\n`);
console.log(`\n${cases.length}개 국면, 단계 ${chosen.size}종 → ${OUT}`);
for (const [stage, bucket] of [...chosen.entries()].sort()) {
  console.log(`  ${stage.padEnd(34)}${bucket.length}`);
}
