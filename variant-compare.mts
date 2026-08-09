/**
 * The variants, judged on the games the player actually played.
 *
 * Reports the mechanism first and the margin last, deliberately. Territory
 * margin has a standard deviation of 7.2 cells across recorded games, so ten
 * games can only resolve a difference of about nine — the arena measured this
 * change at 2.4, which is far below what any feasible number of games could
 * separate. Eye-filling happens about 2.3 times a game, so a real change in it
 * shows up almost immediately. Reading these in the wrong order is how a
 * three-game sample got a working change reverted earlier.
 *
 *   npx vite-node variant-compare.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, FIRST_PLAYER_MARGIN, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Tally {
  games: number;
  aiCaptured: number;
  aiCaptures: number;
  territoryGames: number;
  margins: number[];
  aiMoves: number;
  aiEyeFills: number;
  humanMoves: number;
  humanEyeFills: number;
  overBudget: number;
  timings: number;
  depths: number[];
}
const blank = (): Tally => ({
  games: 0, aiCaptured: 0, aiCaptures: 0, territoryGames: 0, margins: [],
  aiMoves: 0, aiEyeFills: 0, humanMoves: 0, humanEyeFills: 0,
  overBudget: 0, timings: 0, depths: [],
});
const byVariant = new Map<string, Tally>();

/** Liberties of a thin group that could still be walled into an eye. */
function eyePoints(state: GameState, player: Player): Set<string> {
  const enemy = playerCell(opponent(player));
  const out = new Set<string>();
  for (const group of getAllGroups(state.board, player)) {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size > 3) continue;
    for (const key of liberties) {
      const [row, col] = key.split(",").map(Number);
      let empties = 0;
      let enemyBeside = false;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr, c = col + dc;
        if (!inBounds(r, c)) continue;
        if (state.board[r][c] === enemy) { enemyBeside = true; break; }
        if (state.board[r][c] === "EMPTY") empties += 1;
      }
      if (!enemyBeside && empties <= 2) out.add(key);
    }
  }
  return out;
}

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    // Games from before variants existed played the shipped engine.
    const key = `${rec.appVersion ?? "?"} / ${rec.aiVariant ?? "(pre-variant)"}`;
    const t = byVariant.get(key) ?? blank();
    byVariant.set(key, t);
    t.games += 1;

    const human: Player = rec.playerSide;
    const ai = opponent(human);
    if (rec.winReason === "CAPTURE") {
      if (rec.winner === ai) t.aiCaptures += 1;
      else t.aiCaptured += 1;
    } else if (rec.winReason === "TERRITORY") {
      t.territoryGames += 1;
      const aiT = ai === "A" ? rec.territoryA : rec.territoryB;
      const huT = ai === "A" ? rec.territoryB : rec.territoryA;
      t.margins.push(aiT - huT - (ai === "A" ? FIRST_PLAYER_MARGIN : -FIRST_PLAYER_MARGIN));
    }
    for (const timing of rec.aiTimings ?? []) {
      t.timings += 1;
      t.depths.push(timing.depth);
      if (timing.elapsedMs > timing.budgetMs) t.overBudget += 1;
    }

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      if (m.type === "PLACE") {
        const points = eyePoints(state, mover);
        if (mover === ai) {
          t.aiMoves += 1;
          if (points.has(`${m.row},${m.col}`)) t.aiEyeFills += 1;
        } else {
          t.humanMoves += 1;
          if (points.has(`${m.row},${m.col}`)) t.humanEyeFills += 1;
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rows = [...byVariant.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`THE MECHANISM — how often the AI plays a point that could have been its own eye\n`);
console.log(`${"build / variant".padEnd(26)}${"games".padStart(7)}${"AI fills".padStart(11)}${"per game".padStart(10)}${"human fills".padStart(13)}`);
for (const [k, t] of rows) {
  console.log(
    `${k.padEnd(26)}${String(t.games).padStart(7)}${String(t.aiEyeFills).padStart(11)}` +
      `${(t.aiEyeFills / t.games).toFixed(2).padStart(10)}${String(t.humanEyeFills).padStart(13)}`,
  );
}
console.log(`\n\nSAFETY — captures, depth, budget\n`);
console.log(`${"build / variant".padEnd(26)}${"AI captured".padStart(13)}${"AI captures".padStart(13)}${"depth".padStart(8)}${"over budget".padStart(13)}`);
for (const [k, t] of rows) {
  console.log(
    `${k.padEnd(26)}${String(t.aiCaptured).padStart(13)}${String(t.aiCaptures).padStart(13)}` +
      `${mean(t.depths).toFixed(2).padStart(8)}${`${t.overBudget}/${t.timings}`.padStart(13)}`,
  );
}
console.log(`\n\nTERRITORY — too few games to decide anything, listed for the record\n`);
for (const [k, t] of rows) {
  console.log(
    `${k.padEnd(26)}${String(t.territoryGames).padStart(4)} counted   ` +
      `mean ${Number.isNaN(mean(t.margins)) ? "—" : mean(t.margins).toFixed(1)}   ` +
      `[${t.margins.sort((a, b) => a - b).join(", ")}]`,
  );
}
