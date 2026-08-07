/**
 * Does the territory term ever decide anything?
 *
 * Three different territory evaluations have now measured exactly zero: the
 * learned ownership head at full replacement (-0.196, CI [-0.85, +0.46]), the
 * urgent-seal shortlist (void, it never fired), and closability discounting
 * (+0.083, CI [-0.22, +0.38] over 25 clusters). Three independent ideas
 * landing on the same null is itself a finding, and the obvious reading is
 * that the fault is not in any of them.
 *
 * `evaluateState` sums the territory term with a row of shape terms:
 *
 *   projectedMargin * 100  +  liberties*5 - theirs*6  +  atari*45 - mine*90
 *                          +  nearAtari*16 - mine*34  +  thin*7 - mine*15
 *                          +  immortal*30  +  connected*3  -  isolated*5
 *
 * A cell of influence moves the first line by 0.12 * 100 = 12 points. Three
 * liberties move the second by 15. So the two are the same size, and a
 * territory term can be as right as it likes while the shape terms pick the
 * move regardless.
 *
 * This measures that directly, on real positions: across the candidate moves
 * the engine is actually choosing between, how much does the territory part
 * vary, how much does everything else vary, and how often does deleting the
 * territory part entirely change which move comes top?
 *
 *   npx vite-node term-weight.mts
 */
import { readFileSync, existsSync } from "node:fs";
import {
  applyAction,
  evaluateState,
  getSafeActions,
  projectedMargin,
  tuning,
  type AIAction,
} from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { FIRST_PLAYER_MARGIN } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

/** The exact expression `evaluateState` adds for territory. */
const territoryPart = (state: GameState, player: Player) => projectedMargin(state, player) * 100;

interface Move {
  type: string;
  row?: number;
  col?: number;
}

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));

/** Spread of a term across the candidate moves — what it can swing a decision by. */
const territorySpread: number[] = [];
const otherSpread: number[] = [];
const ratio: number[] = [];
let positions = 0;
let topChanged = 0;
let decidedByTerritory = 0;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    records: Array<{ moveHistory: Move[] }>;
  };
  for (const record of parsed.records) {
    let state: GameState = createInitialState();
    let ply = 0;

    for (const move of record.moveHistory) {
      if (state.winner) break;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      ply += 1;
      if (ply < 12 || ply % 4 !== 0) continue;

      const player = state.currentPlayer;
      const { pool } = getSafeActions(state, player);
      if (pool.length < 2) continue;

      // Score every candidate the way the search's leaves would, split into
      // the territory part and everything else.
      const scored = pool.map((action: AIAction) => {
        const next = applyAction(state, action);
        const total = evaluateState(next, player);
        const territory = territoryPart(next, player);
        return { action, total, territory, other: total - territory };
      });

      const span = (values: number[]) => Math.max(...values) - Math.min(...values);
      const tSpan = span(scored.map((s) => s.territory));
      const oSpan = span(scored.map((s) => s.other));
      // `evaluateState` returns +/-NEAR_DECISIVE outright when a group is in
      // atari, so those positions carry spans in the tens of thousands and
      // would set any mean by themselves. They are also not positions where a
      // territory term should be deciding anything.
      if (oSpan > 10000) continue;
      territorySpread.push(tSpan);
      otherSpread.push(oSpan);
      if (oSpan > 0) ratio.push(tSpan / oSpan);

      const best = (key: "total" | "other") =>
        scored.reduce((a, b) => (b[key] > a[key] ? b : a)).action;
      const withTerm = best("total");
      const withoutTerm = best("other");
      positions += 1;
      if (withTerm !== withoutTerm) topChanged += 1;

      // Stronger question: is the top move by territory alone ever the winner?
      const bestByTerritory = scored.reduce((a, b) => (b.territory > a.territory ? b : a)).action;
      if (bestByTerritory === withTerm) decidedByTerritory += 1;
    }
  }
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const show = (label: string, values: number[]) => {
  const s = summarize(values);
  console.log(
    `  ${label.padEnd(28)} median ${String(median(values)?.toFixed(1) ?? "—").padStart(9)}  ` +
      `mean ${String(s.mean ?? "—").padStart(10)}`,
  );
};

console.log(`${positions} positions from ${files.length} file(s), ply 12+, every 4th ply`);
console.log(`(territory term = projectedMargin * 100, first-player margin ${FIRST_PLAYER_MARGIN},`);
console.log(` closabilityDecay ${tuning.closabilityDecay})\n`);

console.log("how far each part can swing a decision, across the candidate moves:");
show("territory term", territorySpread);
show("everything else", otherSpread);
show("territory / everything else", ratio);

const pct = (part: number) => (positions === 0 ? "—" : `${((part / positions) * 100).toFixed(1)}%`);
console.log(`\ndeleting the territory term changes the top move: ${pct(topChanged)} of positions`);
console.log(`the move the territory term likes most is chosen: ${pct(decidedByTerritory)}`);
