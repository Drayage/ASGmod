/**
 * Old build against new, on the games actually played by a person.
 *
 * The arena said the guard change was worth about 1.8 cells and five points of
 * conversion, but the arena is engine against engine and this branch has
 * established repeatedly that it cannot see the territory defect that shows up
 * against a human. These are the games that can.
 *
 * Grouped by the build stamped into the record, so nothing has to be assumed
 * about which engine played.
 *
 *   npx vite-node build-compare.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves, influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { FIRST_PLAYER_MARGIN, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Tally {
  games: number;
  aiCaptureWins: number;
  aiCaptureLosses: number;
  territoryGames: number;
  marginSum: number;
  turns: number;
  offered: number;
  taken: number;
  peakInfluence: number;
  finalTerritory: number;
}
const blank = (): Tally => ({
  games: 0, aiCaptureWins: 0, aiCaptureLosses: 0, territoryGames: 0, marginSum: 0,
  turns: 0, offered: 0, taken: 0, peakInfluence: 0, finalTerritory: 0,
});
const byBuild = new Map<string, Tally>();

for (const path of process.argv.slice(2)) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: any[] };
  for (const rec of parsed.records) {
    const build = rec.appVersion ?? "unknown";
    const t = byBuild.get(build) ?? blank();
    byBuild.set(build, t);
    const human: Player = rec.playerSide;
    const ai = opponent(human);
    t.games += 1;
    if (rec.winReason === "CAPTURE") {
      if (rec.winner === ai) t.aiCaptureWins += 1;
      else t.aiCaptureLosses += 1;
    } else if (rec.winReason === "TERRITORY") {
      t.territoryGames += 1;
      const aiT = ai === "A" ? rec.territoryA : rec.territoryB;
      const huT = ai === "A" ? rec.territoryB : rec.territoryA;
      // Stated from the AI's side with the first-player margin applied to
      // whoever owes it, so the two seats are comparable.
      t.marginSum += aiT - huT - (ai === "A" ? FIRST_PLAYER_MARGIN : -FIRST_PLAYER_MARGIN);
      t.finalTerritory += aiT;
    }

    let state: GameState = createInitialState();
    let peak = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        t.turns += 1;
        const seals = findSealingMoves(state, ai).filter((s) => s.gained.length >= 2);
        if (seals.length > 0) {
          t.offered += 1;
          if (m.type === "PLACE" && seals.some((s) => s.move.row === m.row && s.move.col === m.col)) t.taken += 1;
        }
        peak = Math.max(peak, influenceCountFromMap(influenceOwnerMap(state.board))[ai]);
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
    t.peakInfluence += peak;
  }
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);
const order = [...byBuild.keys()].sort();
console.log(`${"".padEnd(22)}${order.map((b) => b.padStart(12)).join("")}`);
const row = (label: string, f: (t: Tally) => string) =>
  console.log(`${label.padEnd(22)}${order.map((b) => f(byBuild.get(b)!).padStart(12)).join("")}`);
row("games", (t) => String(t.games));
row("AI won by capture", (t) => String(t.aiCaptureWins));
row("AI lost by capture", (t) => String(t.aiCaptureLosses));
row("decided on territory", (t) => String(t.territoryGames));
row("AI margin (mean)", (t) => t.territoryGames ? (t.marginSum / t.territoryGames).toFixed(1) : "—");
row("AI final territory", (t) => t.territoryGames ? (t.finalTerritory / t.territoryGames).toFixed(1) : "—");
row("AI peak influence", (t) => (t.peakInfluence / t.games).toFixed(1));
row("2+ seal offered", (t) => `${pct(t.offered, t.turns)} (${t.offered}/${t.turns})`);
row("  ...and taken", (t) => pct(t.taken, t.offered));
