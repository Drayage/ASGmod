/**
 * What decides the engine's answer to a check?
 *
 * Where the answer lands is level: of the four moves after being checked, the
 * human puts 1.28 within two steps of it and the engine 1.29, longest local run
 * 1.14 against 1.16. So "it stays in the small fight" is not about location.
 *
 * The player's words are that it cannot respond — which points at what produces
 * the move rather than where it goes. Nine of the ten stages above the full
 * search hand it a shortlist and return, so if the danger stages fire whenever
 * an enemy stone lands nearby, the search never gets the chance to prefer a
 * bigger point somewhere else.
 *
 * So this replays the positions right after a check and records which stage
 * answered, against the same engine's stage mix on every other turn.
 *
 *   npx vite-node checked-stage.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { setCornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const STRIDE = Number(process.env.STRIDE ?? 1);
setCornerBookEnabled(process.env.CORNER !== "0");

const tally: Record<string, Map<string, number>> = {
  "after a check": new Map(),
  "every other turn": new Map(),
};

const seen = new Set<string>();
let done = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const ai: Player = opponent(rec.playerSide);

    let state: GameState = createInitialState();
    let prevWasCheck = false;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const before = state;
      const mover = before.currentPlayer;

      if (mover === ai) {
        done += 1;
        if (done % STRIDE === 0 && !getSafeActions(before, ai).winningMove) {
          findBestMoveVeryHard(before, ai, BUDGET);
          const bucket = prevWasCheck ? "after a check" : "every other turn";
          tally[bucket].set(lastDecision.stage, (tally[bucket].get(lastDecision.stage) ?? 0) + 1);
        }
      }

      // Was this move a check on the engine?
      prevWasCheck = false;
      if (m.type === "PLACE" && mover !== ai) {
        for (let dr = -1; dr <= 1 && !prevWasCheck; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const r = m.row + dr;
            const c = m.col + dc;
            if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
            if (before.board[r][c] === playerCell(ai)) { prevWasCheck = true; break; }
          }
        }
      }

      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
const stages = new Set<string>();
for (const m of Object.values(tally)) for (const k of m.keys()) stages.add(k);
console.log(`which stage answers, at ${BUDGET}ms\n`);
console.log(`${"stage".padEnd(28)}${"after a check".padStart(15)}${"every other turn".padStart(19)}`);
for (const stage of [...stages].sort()) {
  const a = tally["after a check"];
  const b = tally["every other turn"];
  const an = [...a.values()].reduce((x, y) => x + y, 0);
  const bn = [...b.values()].reduce((x, y) => x + y, 0);
  console.log(
    `${stage.padEnd(28)}${`${a.get(stage) ?? 0} (${pct(a.get(stage) ?? 0, an)})`.padStart(15)}` +
      `${`${b.get(stage) ?? 0} (${pct(b.get(stage) ?? 0, bn)})`.padStart(19)}`,
  );
}
