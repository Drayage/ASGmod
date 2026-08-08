/**
 * What restoring the decisive points costs in search depth.
 *
 * Adding candidates can only lower nodes per second, and depth is what pays.
 * The addition is meant to be cheap because it fires only where a group is
 * already in atari — but "meant to be" is not a measurement, and a fix that
 * buys sound tactics by making the engine a ply shallower everywhere might not
 * be worth it.
 *
 *   npx vite-node depth-cost.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastSearchDepth } from "./src/games/alley-boss-cats/engine/minimax";
import { setDecisivePointsEnabled } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 1200);
const depths = new Map<boolean, number[]>([[true, []], [false, []]]);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        for (const on of [true, false]) {
          setDecisivePointsEnabled(on);
          findBestMoveVeryHard(state, ai, BUDGET);
          depths.get(on)!.push(lastSearchDepth);
        }
        setDecisivePointsEnabled(true);
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`search depth reached at ${BUDGET}ms per move\n`);
for (const on of [false, true]) {
  const xs = depths.get(on)!;
  const hist = new Map<number, number>();
  for (const d of xs) hist.set(d, (hist.get(d) ?? 0) + 1);
  console.log(
    `  decisive points ${on ? "ON " : "OFF"}: mean ${mean(xs).toFixed(2)}` +
      `   ${[...hist.keys()].sort((a, b) => a - b).map((k) => `d${k}x${hist.get(k)}`).join(" ")}`,
  );
}
const a = mean(depths.get(false)!), b = mean(depths.get(true)!);
console.log(`\n  cost: ${(b - a).toFixed(2)} ply (n=${depths.get(true)!.length} positions)`);
