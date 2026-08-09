/**
 * Why the engine walks past a seal.
 *
 * Across 32 recorded games the engine has won nine — every one of them by
 * capture, and none of the seventeen that reached a territory count. In the
 * four games on the current build it was offered 22 seals of two cells or more
 * and took 4, where the human was offered 7 and took 5. A seal here is exact
 * and permanent: `findSealingMoves` asks the rules which cells the move turns
 * into confirmed territory, and confirmed territory can never be played in
 * again by either side. So the cells are banked, not merely likely.
 *
 * Five evaluation terms aimed at territory measured zero, and both changes that
 * ever worked were in move generation. So this asks where the seal is lost
 * before proposing anything: is it absent from the candidate list, is it present
 * and outscored, or did a guard shortlist return before the search ever saw it?
 *
 *   npx vite-node seal-skip.mts <export.json ...>          # census, no search
 *   DECIDE=1 STRIDE=4 npx vite-node seal-skip.mts <...>    # re-decide, 3000ms
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { orderedCandidates } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const DECIDE = process.env.DECIDE === "1";
const STRIDE = Number(process.env.STRIDE ?? 1);
const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);

interface Skip {
  state: GameState;
  player: Player;
  sealKey: string;
  cells: number;
  played: string;
  inPool: boolean;
  inTop14: boolean;
  evalSeal: number;
  evalPlayed: number;
}
const skips: Skip[] = [];
let offered = 0;
let taken = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const isAI = state.currentPlayer === ai;
      const before = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (!isAI || m.type !== "PLACE") continue;

      const seals = findSealingMoves(before, ai).filter((s) => s.gained.length >= MIN_CELLS);
      if (seals.length === 0) continue;
      offered += 1;
      const playedKey = `${m.row},${m.col}`;
      if (seals.some((s) => `${s.move.row},${s.move.col}` === playedKey)) {
        taken += 1;
        continue;
      }

      const best = seals[0];
      const sealKey = `${best.move.row},${best.move.col}`;
      const pool = getSafeActions(before, ai).pool;
      const top = orderedCandidates(before, ai, 14, undefined, false);
      const has = (list: any[]) =>
        list.some((a) => a.type === "PLACE" && `${a.row},${a.col}` === sealKey);
      skips.push({
        state: before,
        player: ai,
        sealKey,
        cells: best.gained.length,
        played: playedKey,
        inPool: has(pool),
        inTop14: has(top),
        evalSeal: evaluateState(
          applyAction(before, { type: "PLACE", row: best.move.row, col: best.move.col }),
          ai,
        ),
        evalPlayed: evaluateState(state, ai),
      });
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`seals of ${MIN_CELLS}+ cells offered to the engine: ${offered}, taken ${taken} (${pct(taken, offered)})\n`);
console.log(`of the ${skips.length} it walked past:`);
console.log(`  the seal point was a legal, non-losing move  : ${skips.filter((s) => s.inPool).length} (${pct(skips.filter((s) => s.inPool).length, skips.length)})`);
console.log(`  ...and inside the 14-move candidate list     : ${skips.filter((s) => s.inTop14).length} (${pct(skips.filter((s) => s.inTop14).length, skips.length)})`);
const better = skips.filter((s) => s.evalSeal > s.evalPlayed);
console.log(`  ...and the evaluation preferred it outright  : ${better.length} (${pct(better.length, skips.length)})`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`  mean cells left on the table                 : ${mean(skips.map((s) => s.cells)).toFixed(1)}`);
// The mean is useless here: a handful of skips where sealing walks into a lost
// group score around minus a million and swamp a hundred ordinary ones.
const deltas = skips.map((s) => s.evalSeal - s.evalPlayed).sort((a, b) => a - b);
const q = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))];
console.log(
  `  static score, seal minus played              : median ${q(0.5).toFixed(0)}, ` +
    `10th ${q(0.1).toFixed(0)}, 90th ${q(0.9).toFixed(0)}`,
);
const catastrophic = skips.filter((s) => s.evalSeal - s.evalPlayed < -100_000);
console.log(`  sealing would have lost a group outright     : ${catastrophic.length} (${pct(catastrophic.length, skips.length)})`);

if (!DECIDE) process.exit(0);

// Which stage of the guard ladder answers these positions on the current build,
// and does the current engine still walk past the seal?
console.log(`\nre-deciding at ${BUDGET}ms on the current build (every ${STRIDE}${STRIDE === 1 ? "" : "th"} skip):`);
const byStage = new Map<string, { n: number; tookSeal: number }>();
let decided = 0;
let stillSkipped = 0;
skips.forEach((skip, i) => {
  if (i % STRIDE !== 0) return;
  const chosen = findBestMoveVeryHard(skip.state, skip.player, BUDGET);
  const key = chosen.type === "PLACE" ? `${chosen.row},${chosen.col}` : "PASS";
  const stage = lastDecision.stage;
  const entry = byStage.get(stage) ?? { n: 0, tookSeal: 0 };
  entry.n += 1;
  if (key === skip.sealKey) entry.tookSeal += 1;
  else stillSkipped += 1;
  byStage.set(stage, entry);
  decided += 1;
  if (decided % 20 === 0) console.log(`  ...${decided} re-decided, ${stillSkipped} still skipped`);
});
console.log(`\n${"stage".padEnd(26)}${"positions".padStart(11)}${"took the seal".padStart(15)}`);
for (const [stage, e] of [...byStage.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${stage.padEnd(26)}${String(e.n).padStart(11)}${`${e.tookSeal} (${pct(e.tookSeal, e.n)})`.padStart(15)}`);
}
console.log(`\nstill skipped: ${stillSkipped} of ${decided} (${pct(stillSkipped, decided)})`);
