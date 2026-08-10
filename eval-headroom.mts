/**
 * How much room is there in the evaluation for a territory idea at all?
 *
 * The region curve does reward the dividing move — its advantage over the other
 * candidates roughly doubles, from 0.16 open-ground units under the flat count
 * to 0.29 under the curve. And the engine's split rate still did not move.
 *
 * 0.29 units is 0.29 * 0.12 * 100 = 3.5 points of the evaluation. So this asks
 * what 3.5 points buys: the spread of `evaluateState` across the candidate moves
 * at the same positions, and how far apart the top few are. A term that moves a
 * move by less than the gap to the next one cannot change which one is chosen,
 * however well calibrated it is.
 *
 * This is the general shape of five earlier territory terms measuring zero, so
 * it is worth a number rather than an argument.
 *
 *   npx vite-node eval-headroom.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const FROM_TURN = Number(process.env.FROM_TURN ?? 21);

const gapToSecond: number[] = [];
const gapToFifth: number[] = [];
const spread: number[] = [];

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE" || mover !== ai || turn < FROM_TURN) continue;

      const { pool } = getSafeActions(before, ai);
      const scores = pool
        .map((a) => evaluateState(applyAction(before, a), ai))
        // A move that wins or loses outright is not what a territory term is
        // competing with; those are decided by the tactical short-circuits.
        .filter((s) => Math.abs(s) < 100_000)
        .sort((a, b) => b - a);
      if (scores.length < 6) continue;
      gapToSecond.push(scores[0] - scores[1]);
      gapToFifth.push(scores[0] - scores[4]);
      spread.push(scores[0] - scores[scores.length - 1]);
    }
  }
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`evaluation gaps between candidate moves, ${gapToSecond.length} engine positions from turn ${FROM_TURN}\n`);
console.log(`${"".padEnd(22)}${"median".padStart(10)}${"mean".padStart(10)}${"25th".padStart(10)}`);
const row = (name: string, xs: number[]) =>
  console.log(`${name.padEnd(22)}${q(xs, 0.5).toFixed(0).padStart(10)}${mean(xs).toFixed(0).padStart(10)}${q(xs, 0.25).toFixed(0).padStart(10)}`);
row("best minus second", gapToSecond);
row("best minus fifth", gapToFifth);
row("best minus worst", spread);
console.log(`\nthe region curve moves a dividing move by about 3.5 points`);
const beats = gapToSecond.filter((g) => g < 3.5).length;
console.log(`  positions where that could flip even the top two: ${beats} of ${gapToSecond.length} (${((beats / gapToSecond.length) * 100).toFixed(0)}%)`);
