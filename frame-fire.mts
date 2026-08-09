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
/** Where the chosen move lands, by distance from the edge, per arm. The arena
 * reported no change in how regions get walled — but its own engines already
 * take 38% of a region's boundary from the board edge where the shipped engine
 * took 13% against the human, so it was not reproducing the defect. This asks
 * the same question in the condition that has it. */
const lines: Record<string, number[]> = { true: new Array(5).fill(0), false: new Array(5).fill(0) };
const STRIDE = Number(process.env.STRIDE ?? 1);
positions.forEach(({ state, player }, i) => {
  if (i % STRIDE !== 0) return;
  if (getSafeActions(state, player).winningMove) return;
  considered += 1;
  const runs = i % 2 === 0 ? [false, true] : [true, false];
  const got: Record<string, string> = {};
  for (const on of runs) {
    setEdgeFramingEnabled(on);
    const chosen = findBestMoveVeryHard(state, player, BUDGET);
    got[String(on)] = key(chosen);
    if (chosen.type === "PLACE") {
      const d = Math.min(chosen.row, chosen.col, 8 - chosen.row, 8 - chosen.col);
      lines[String(on)][d] += 1;
    }
  }
  if (got["true"] !== got["false"]) changed += 1;
  if (considered % 25 === 0) console.log(`  ...${considered} decided, ${changed} changed`);
});
setEdgeFramingEnabled(false);
console.log(`\ndecisions at ${BUDGET}ms: ${changed} of ${considered} changed (${pct(changed, considered)})`);
console.log(`\nwhere the chosen move lands   (line 1 = board edge)`);
console.log(`${"arm".padEnd(10)}${["1st", "2nd", "3rd", "4th", "5th"].map((s) => s.padStart(8)).join("")}`);
for (const on of ["false", "true"]) {
  const total = lines[on].reduce((a, b) => a + b, 0);
  console.log(
    `${(on === "true" ? "edge ON" : "edge OFF").padEnd(10)}` +
      lines[on].map((c) => `${((c / total) * 100).toFixed(0)}%`.padStart(8)).join(""),
  );
}
console.log(`  (the human plays 37% / 39% / 17% / 7% across these lines)`);
