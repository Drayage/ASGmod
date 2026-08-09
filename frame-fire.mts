/**
 * Does the edge-framing slot fire, and does it change what the engine plays?
 *
 * Five evaluation terms aimed at territory measured zero before anyone asked
 * whether they could fire. So this asks first, on real positions from recorded
 * games, in the order that matters: how often the slot supplies a candidate the
 * ordering had cut, then how often the engine's move actually changes.
 *
 *   npx vite-node frame-fire.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { edgeFramingPoints, orderedCandidates, setEdgeFramingEnabled } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const DECIDE = process.env.DECIDE !== "0";

const positions: { state: GameState; player: Player }[] = [];
const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) positions.push({ state, player: ai });
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

// Stage one: does the slot add anything the 14-move cut had dropped?
let offered = 0;
let novel = 0;
const spans: number[] = [];
for (const { state, player } of positions) {
  const base = orderedCandidates(state, player, 14, undefined, false);
  const present = new Set(base.map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS")));
  const frames = edgeFramingPoints(state, player);
  if (frames.length > 0) offered += 1;
  for (const f of frames) {
    if (f.type !== "PLACE") continue;
    if (!present.has(`${f.row},${f.col}`)) novel += 1;
  }
}
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`positions (engine to move): ${positions.length}`);
console.log(`  offered at least one framing point : ${offered} (${pct(offered, positions.length)})`);
console.log(`  framing points the cut had dropped : ${novel} (${(novel / positions.length).toFixed(2)} per position)`);
if (!DECIDE) process.exit(0);

// Stage two: with the same positions and the shipped budget, does the engine's
// chosen move change? Alternating order so any drift in machine load falls on
// both arms equally.
let changed = 0;
let considered = 0;
const key = (a: any) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS");
const STRIDE = Number(process.env.STRIDE ?? 1);
positions.forEach(({ state, player }, i) => {
  if (i % STRIDE !== 0) return;
  if (getSafeActions(state, player).winningMove) return;
  considered += 1;
  const runs = i % 2 === 0 ? [false, true] : [true, false];
  const got: Record<string, string> = {};
  for (const on of runs) {
    setEdgeFramingEnabled(on);
    got[String(on)] = key(findBestMoveVeryHard(state, player, BUDGET));
  }
  if (got["true"] !== got["false"]) changed += 1;
  if (considered % 25 === 0) console.log(`  ...${considered} decided, ${changed} changed`);
});
setEdgeFramingEnabled(false);
console.log(`\ndecisions at ${BUDGET}ms: ${changed} of ${considered} changed (${pct(changed, considered)})`);
