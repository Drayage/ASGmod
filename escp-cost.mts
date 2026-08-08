/**
 * Confirming, rather than inferring, what cost the ply.
 *
 * The ordering change measures at +0.01 ply at 3000ms, and the shipped build
 * that carried it lost 0.87. Subtracting one from the other points at
 * `escapesInOneMove` running ungated at every leaf — but that is an inference,
 * and an inference by subtraction is what put the regression live in the first
 * place.
 *
 * So measure it. escapablePressureWeight 1 skips the work entirely; any other
 * value does it. The comparison therefore mixes the cost with a small change in
 * play, which is fine here: the question is only whether doing this work at
 * every leaf is what buys most of a ply.
 *
 *   BUDGET=3000 npx vite-node escp-cost.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastSearchDepth } from "./src/games/alley-boss-cats/engine/minimax";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const stats = new Map<number, { depths: number[]; elapsed: number[] }>([
  [1, { depths: [], elapsed: [] }],
  [0, { depths: [], elapsed: [] }],
]);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        const order = state.moveHistory.length % 2 === 0 ? [1, 0] : [0, 1];
        for (const weight of order) {
          tuning.escapablePressureWeight = weight;
          const started = Date.now();
          findBestMoveVeryHard(state, ai, BUDGET);
          const s = stats.get(weight)!;
          s.depths.push(lastSearchDepth);
          s.elapsed.push(Date.now() - started);
        }
        tuning.escapablePressureWeight = 1;
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`at ${BUDGET}ms per move\n`);
console.log(`  weight 1 (work skipped): depth ${mean(stats.get(1)!.depths).toFixed(2)}   mean ${mean(stats.get(1)!.elapsed).toFixed(0)}ms`);
console.log(`  weight 0 (work done)   : depth ${mean(stats.get(0)!.depths).toFixed(2)}   mean ${mean(stats.get(0)!.elapsed).toFixed(0)}ms`);
console.log(`\n  cost of doing it: ${(mean(stats.get(0)!.depths) - mean(stats.get(1)!.depths)).toFixed(2)} ply over ${stats.get(0)!.depths.length} positions`);
