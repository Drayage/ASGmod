/**
 * Did the person's move choice get better, measured against a fixed yardstick?
 *
 * The previous attempt used their final territory and concluded it had not.
 * That was wrong: territory is jointly produced by both players, so a stronger
 * opponent pushes it down at the same time as improving skill pushes it up, and
 * the two cannot be separated in one number.
 *
 * This uses a yardstick that does not move with the opponent. For every move
 * the person played, rank all their legal moves by `evaluateState` from their
 * own side and record where the played move sat. The evaluator is identical
 * across all games, so a drift in the percentile is a drift in move choice.
 *
 * Its limits, stated: the evaluator is the engine's, it is imperfect, and a
 * stronger player may well choose moves it underrates. Read as a coarse drift
 * check, not a rating.
 *
 *   npx vite-node move-quality.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const byBuild = new Map<string, number[]>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const build = rec.appVersion ?? "?";
    const list = byBuild.get(build) ?? [];
    byBuild.set(build, list);
    const human: Player = rec.playerSide;
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      if (mover === human && m.type === "PLACE") {
        const { pool } = getSafeActions(state, human);
        if (pool.length >= 4) {
          const scored = pool.map((a) => ({
            a,
            s: evaluateState(applyAction(state, a), human),
          }));
          scored.sort((x, y) => y.s - x.s);
          const at = scored.findIndex(
            (e) => e.a.type === "PLACE" && e.a.row === m.row && e.a.col === m.col,
          );
          // Percentile: 100 = the evaluator's own top choice, 0 = its worst.
          if (at >= 0) list.push(((scored.length - 1 - at) / (scored.length - 1)) * 100);
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
console.log(`the human's own moves, ranked by a fixed evaluator (100 = its top pick)\n`);
console.log(`${"build".padEnd(12)}${"moves".padStart(8)}${"mean pct".padStart(11)}${"median".padStart(9)}${"top-5 rate".padStart(12)}`);
for (const [build, xs] of [...byBuild.entries()].sort((a, b) => a[1].length - b[1].length)) {
  const top5 = xs.filter((v) => v >= 95).length / xs.length * 100;
  console.log(
    `${build.padEnd(12)}${String(xs.length).padStart(8)}${mean(xs).toFixed(1).padStart(11)}` +
      `${median(xs).toFixed(1).padStart(9)}${`${top5.toFixed(0)}%`.padStart(12)}`,
  );
}
