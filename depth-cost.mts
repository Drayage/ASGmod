/**
 * What the ordering change costs, at the budget the app actually uses.
 *
 * The first version of this ran at 1200ms and reported +0.04 ply. The app runs
 * at 3000ms and its own game records reported -0.87. So the bench was measuring
 * something the engine does not do, and this measures the engine's condition
 * instead: the shipped budget, and the shipped worker's own default.
 *
 * Also reports budget overruns, which the earlier version never looked at and
 * which turned out to be the clearest symptom in the records.
 *
 * Which switch it toggles is a parameter, because every candidate-generation
 * change since has had to answer the same question in the same conditions.
 *
 *   BUDGET=3000 SWITCH=decisive|edge STRIDE=1 npx vite-node depth-cost.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastSearchDepth } from "./src/games/alley-boss-cats/engine/minimax";
import { setDecisivePointsEnabled, setEdgeFramingEnabled } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const STRIDE = Number(process.env.STRIDE ?? 1);
const SWITCH = process.env.SWITCH ?? "decisive";
const setSwitch = SWITCH === "edge" ? setEdgeFramingEnabled : setDecisivePointsEnabled;
let sampled = 0;
const stats = new Map<boolean, { depths: number[]; over: number; elapsed: number[] }>([
  [true, { depths: [], over: 0, elapsed: [] }],
  [false, { depths: [], over: 0, elapsed: [] }],
]);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai && sampled++ % STRIDE === 0) {
        // Both arms see the identical position, and the order they run in
        // alternates per turn so a warm-up advantage cannot accrue to one.
        const order = state.moveHistory.length % 2 === 0 ? [false, true] : [true, false];
        for (const on of order) {
          setSwitch(on);
          const started = Date.now();
          findBestMoveVeryHard(state, ai, BUDGET);
          const took = Date.now() - started;
          const s = stats.get(on)!;
          s.depths.push(lastSearchDepth);
          s.elapsed.push(took);
          if (took > BUDGET) s.over += 1;
        }
        setSwitch(false);
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`at ${BUDGET}ms per move — the budget the app uses\n`);
for (const on of [false, true]) {
  const s = stats.get(on)!;
  console.log(
    `  ${SWITCH.padEnd(8)} ${on ? "ON " : "OFF"}: depth ${mean(s.depths).toFixed(2)}` +
      `   over budget ${s.over}/${s.depths.length}` +
      `   mean ${mean(s.elapsed).toFixed(0)}ms  max ${Math.max(...s.elapsed)}ms`,
  );
}
const a = mean(stats.get(false)!.depths), b = mean(stats.get(true)!.depths);
console.log(`\n  cost: ${(b - a).toFixed(2)} ply over ${stats.get(true)!.depths.length} positions`);
console.log(`  (the records put the shipped a48f11b build 0.87 ply below 7e3b556)`);
