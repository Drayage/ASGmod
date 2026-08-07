/**
 * How often does the evaluation actually get to choose the move?
 *
 * `findBestMoveVeryHard` is a ladder of guards. All but the last hand the search
 * a shortlist and return, and at turn 28 of game 1 one of them handed it two
 * candidates out of a pool of 48 — so the move that decided the game was picked
 * by a guard, not by the evaluation.
 *
 * If that is the normal case rather than the exception, it explains the whole
 * run of null results: five territory terms measured zero because the term
 * being tuned rarely decides anything. This counts it.
 *
 * Positions come from real recorded games, replayed to each AI turn, with the
 * real search at the real budget.
 *
 *   npx vite-node who-decides.mts [export.json ...]
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  turn?: number;
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  moveHistory: Move[];
}

/** A move budget well under the app's 3000ms, so the sweep finishes. Stated
 * because the guard ladder is budget-sensitive: less time means the reads that
 * feed stages 1.5-1.9 prove less, which if anything *understates* how often
 * they fire. */
const BUDGET = Number(process.env.BUDGET ?? 800);
const files = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SEED_FILES).filter(
  (path) => existsSync(path),
);

const counts = new Map<string, number>();
const narrowness = new Map<string, { candidates: number; pool: number }>();
let turns = 0;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    // Only games with a stated human side have an "AI side" to stand in for.
    if (!record.playerSide) continue;
    const ai = opponent(record.playerSide);

    let state: GameState = createInitialState();
    for (const move of record.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        findBestMoveVeryHard(state, ai, BUDGET);
        const { stage, candidates, poolSize } = lastDecision;
        counts.set(stage, (counts.get(stage) ?? 0) + 1);
        const seen = narrowness.get(stage) ?? { candidates: 0, pool: 0 };
        seen.candidates += candidates;
        seen.pool += poolSize;
        narrowness.set(stage, seen);
        turns += 1;
      }
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
  }
}

console.log(`${turns} AI turns from ${files.length} file(s), ${BUDGET}ms each\n`);
console.log(
  `${"stage".padEnd(26)}${"turns".padStart(8)}${"share".padStart(9)}` +
    `${"mean candidates".padStart(18)}${"of pool".padStart(10)}`,
);
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [stage, count] of rows) {
  const seen = narrowness.get(stage)!;
  console.log(
    `${stage.padEnd(26)}${String(count).padStart(8)}` +
      `${`${((count / turns) * 100).toFixed(1)}%`.padStart(9)}` +
      `${(seen.candidates / count).toFixed(1).padStart(18)}` +
      `${(seen.pool / count).toFixed(1).padStart(10)}`,
  );
}

const full = counts.get("4 full search") ?? 0;
console.log(
  `\nthe evaluation chose from the whole pool on ${full}/${turns} turns` +
    ` (${((full / turns) * 100).toFixed(1)}%).`,
);
console.log(
  `a shortlist stage decided the other ${turns - full}` +
    ` (${(((turns - full) / turns) * 100).toFixed(1)}%).`,
);
