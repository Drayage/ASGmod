/**
 * The same question, with the one check that decides whether "lost" means lost.
 *
 * seal-fate.mts found the dominant failure in the new build is a seal point
 * going away without the opponent ever playing it — 25 of 35. But a region can
 * stop being a one-move seal for innocent reasons: it merged into a bigger
 * region, or those cells became territory by another route. Neither is a loss.
 *
 * So resolve each opportunity against the final board: did the cells that seal
 * would have settled end up as the engine's territory anyway?
 *
 *   npx vite-node seal-fate2.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const C = "ABCDEFGHI";
const pt = (r: number, c: number) => `${C[c]}${r + 1}`;

interface Opp { size: number; cells: string[]; taken: boolean; }
const byBuild = new Map<string, { opps: Opp[]; kept: number; lostCells: number; games: number }>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const build = rec.appVersion ?? "?";
    const slot = byBuild.get(build) ?? { opps: [], kept: 0, lostCells: 0, games: 0 };
    byBuild.set(build, slot);
    slot.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    const seen = new Map<string, Opp>();
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        for (const s of findSealingMoves(state, ai)) {
          if (s.gained.length < 2) continue;
          const k = pt(s.move.row, s.move.col);
          if (!seen.has(k)) {
            seen.set(k, { size: s.gained.length, cells: s.gained.map((g) => pt(g.row, g.col)), taken: false });
          }
        }
      }
      if (m.type === "PLACE" && state.currentPlayer === ai) {
        const o = seen.get(pt(m.row, m.col));
        if (o) o.taken = true;
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }

    // The verdict that matters: did those cells end up the engine's anyway?
    const finalT = new Set(calculateTerritories(state.board)[ai].map((c) => pt(c.row, c.col)));
    for (const o of seen.values()) {
      slot.opps.push(o);
      if (o.taken) continue;
      const kept = o.cells.filter((c) => finalT.has(c)).length;
      slot.kept += kept;
      slot.lostCells += o.size - kept;
    }
  }
}

for (const [build, s] of [...byBuild.entries()].sort((a, b) => a[1].games - b[1].games)) {
  const declined = s.opps.filter((o) => !o.taken);
  const declinedCells = declined.reduce((a, o) => a + o.size, 0);
  console.log(`\n=== ${build}  (${s.games} games)`);
  console.log(`  seal opportunities        ${s.opps.length}   (taken ${s.opps.filter((o) => o.taken).length})`);
  console.log(`  declined, cells at stake  ${declinedCells}`);
  console.log(`  ...ended up ours anyway   ${s.kept}  (${((s.kept / declinedCells) * 100).toFixed(0)}%)`);
  console.log(`  ...genuinely lost         ${s.lostCells}  = ${(s.lostCells / s.games).toFixed(1)} cells per game`);
}
