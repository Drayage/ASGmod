/**
 * Is stage 1.85's alarm real?
 *
 * Re-deciding the seals the engine walked past put 10 of 38 positions on
 * `pocketSealDanger`, which took the seal in none of them. It sits ahead of the
 * territorial stages, so whenever it fires the engine is defending rather than
 * taking ground — and it fires on a condition no liberty count would flag,
 * which is exactly what makes it hard to tell a real alarm from a false one.
 *
 * The guard's own test is that a single opponent move could shrink the group's
 * reachable space to a small, one-sided pocket. That is not the same as the
 * group dying: one eye is life here, and a group sealed into four cells with an
 * eye in them is alive. So this counts how often it fires and then asks the game
 * what became of the group it was worried about.
 *
 *   npx vite-node guard-185.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { pocketSealDanger, setPocketSealDangerGuardEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

void setPocketSealDangerGuardEnabled;

let aiTurns = 0;
let fired = 0;
/** Turns where it fired while a 2+ cell seal was also on the table. */
let firedOverSeal = 0;
let games = 0;
/** Games where it fired at least once, and games where the engine lost a group. */
let gamesFired = 0;
let gamesCaptured = 0;
/** Per firing: was any of the mover's groups captured later in this game? */
let firedAndLostAGroup = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);
    games += 1;

    // Did the engine ever lose a group in this game? A capture ends it, so the
    // question is only whether the losing side was the engine.
    let final: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (final.winner) break;
      final = m.type === "PASS"
        ? applyAction(final, { type: "PASS" })
        : applyAction(final, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const engineLostAGroup = final.winReason === "CAPTURE" && final.winner !== ai;
    if (engineLostAGroup) gamesCaptured += 1;

    let firedThisGame = false;
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        aiTurns += 1;
        const moves = pocketSealDanger(state, ai);
        if (moves.length > 0) {
          fired += 1;
          firedThisGame = true;
          if (engineLostAGroup) firedAndLostAGroup += 1;
          const seals = findSealingMoves(state, ai).filter((s) => s.gained.length >= 2);
          if (seals.length > 0) firedOverSeal += 1;
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    if (firedThisGame) gamesFired += 1;
  }
}

void getAllGroups;
void getGroupLiberties;
void getSafeActions;
void playerCell;

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`engine turns across ${games} games: ${aiTurns}\n`);
console.log(`stage 1.85 pocketSealDanger fired : ${fired} (${pct(fired, aiTurns)} of turns)`);
console.log(`  ...while a 2+ cell seal was open: ${firedOverSeal} (${pct(firedOverSeal, fired)} of firings)`);
console.log(`\ngames where it fired at least once : ${gamesFired} of ${games} (${pct(gamesFired, games)})`);
console.log(`games where the engine lost a group: ${gamesCaptured} of ${games} (${pct(gamesCaptured, games)})`);
console.log(`firings in games that ended in the engine losing a group: ${firedAndLostAGroup} (${pct(firedAndLostAGroup, fired)})`);
