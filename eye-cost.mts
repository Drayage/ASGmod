/** Depth cost of the eye term plus the walling candidate, at the shipped budget. */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastSearchDepth, setEyeMakingDefenceEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const BUDGET = Number(process.env.BUDGET ?? 3000);
const W = Number(process.env.EYE_W ?? 60);
const seen = new Set<string>();
const stats = new Map<boolean, { d: number[]; over: number }>([[true, { d: [], over: 0 }], [false, { d: [], over: 0 }]]);
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (s.winner) break;
      if (s.currentPlayer === ai) {
        const order = s.moveHistory.length % 2 === 0 ? [false, true] : [true, false];
        for (const on of order) {
          tuning.eyeSpaceWeight = on ? W : 0;
          setEyeMakingDefenceEnabled(on);
          const t0 = Date.now();
          findBestMoveVeryHard(s, ai, BUDGET);
          const took = Date.now() - t0;
          const st = stats.get(on)!;
          st.d.push(lastSearchDepth);
          if (took > BUDGET) st.over += 1;
        }
        tuning.eyeSpaceWeight = 0;
        setEyeMakingDefenceEnabled(false);
      }
      s = m.type === "PASS" ? applyAction(s, { type: "PASS" }) : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
console.log(`at ${BUDGET}ms, eyeSpaceWeight ${W} + walling candidates\n`);
for (const on of [false, true]) {
  const st = stats.get(on)!;
  console.log(`  ${on ? "ON " : "OFF"}: depth ${mean(st.d).toFixed(2)}   over budget ${st.over}/${st.d.length}`);
}
console.log(`\n  cost: ${(mean(stats.get(true)!.d) - mean(stats.get(false)!.d)).toFixed(2)} ply over ${stats.get(true)!.d.length} positions`);
