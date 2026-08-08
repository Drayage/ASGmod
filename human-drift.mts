/**
 * Did the person get better between builds, and how much of the engine's
 * apparent improvement is really that?
 *
 * The two builds were played in sequence, so "old build" and "earlier games"
 * are the same games. Any learning by the human sits inside the comparison and
 * cannot be separated by grouping on build alone. What can be done is measure
 * the human's own play the same way the engine's is measured: if their numbers
 * moved too, the engine comparison is confounded and has to be stated that way.
 *
 *   npx vite-node human-drift.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves, influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { FIRST_PLAYER_MARGIN, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Side { turns: number; offered: number; taken: number; peak: number; finalT: number; terr: number; }
const blank = (): Side => ({ turns: 0, offered: 0, taken: 0, peak: 0, finalT: 0, terr: 0 });
const byBuild = new Map<string, { human: Side; ai: Side; games: number }>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const build = rec.appVersion ?? "?";
    const slot = byBuild.get(build) ?? { human: blank(), ai: blank(), games: 0 };
    byBuild.set(build, slot);
    slot.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);
    if (rec.winReason === "TERRITORY") {
      const hT = human === "A" ? rec.territoryA : rec.territoryB;
      const aT = human === "A" ? rec.territoryB : rec.territoryA;
      slot.human.finalT += hT; slot.human.terr += 1;
      slot.ai.finalT += aT; slot.ai.terr += 1;
    }
    const peak: Record<Player, number> = { A: 0, B: 0 };
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const side = mover === human ? slot.human : slot.ai;
      side.turns += 1;
      const seals = findSealingMoves(state, mover).filter((s) => s.gained.length >= 2);
      if (seals.length > 0) {
        side.offered += 1;
        if (m.type === "PLACE" && seals.some((s) => s.move.row === m.row && s.move.col === m.col)) side.taken += 1;
      }
      const inf = influenceCountFromMap(influenceOwnerMap(state.board));
      peak[mover] = Math.max(peak[mover], inf[mover]);
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
    slot.human.peak += peak[human];
    slot.ai.peak += peak[ai];
  }
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);
for (const who of ["human", "ai"] as const) {
  console.log(`\n=== ${who}`);
  const builds = [...byBuild.keys()].sort((a, b) => byBuild.get(a)!.games - byBuild.get(b)!.games);
  console.log(`${"".padEnd(20)}${builds.map((b) => b.padStart(12)).join("")}`);
  const row = (label: string, f: (s: Side) => string) =>
    console.log(`${label.padEnd(20)}${builds.map((b) => f(byBuild.get(b)![who]).padStart(12)).join("")}`);
  row("2+ seal offered", (s) => pct(s.offered, s.turns));
  row("  ...and taken", (s) => pct(s.taken, s.offered));
  row("peak influence", (s) => (s.peak / byBuild.get(builds[0])!.games * 0 + s.peak).toFixed(0));
  row("final territory", (s) => (s.terr ? (s.finalT / s.terr).toFixed(1) : "—"));
}
