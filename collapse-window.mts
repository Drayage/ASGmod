/**
 * The collapse window, turn by turn.
 *
 * Game 1 of the 10 August pair: the engine's own projected margin runs +4.3 at
 * turn 8, +0.3 at 14, -4.6 at 20, -11.1 at 26, and finishes at -8 exactly as it
 * predicted. It watches itself lose over a dozen plies and its reading is right,
 * so whatever goes wrong is a choice it makes, not a thing it fails to see.
 *
 * This prints that window move by move: what each side played, what the engine's
 * margin was after it, and — at the human's turns — what the engine would have
 * played from the same seat. Reading, not aggregating.
 *
 *   GAME=1 FROM=8 TO=30 npx vite-node collapse-window.mts <export.json>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions, projectedMargin } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const GAME = Number(process.env.GAME ?? 1);
const FROM = Number(process.env.FROM ?? 8);
const TO = Number(process.env.TO ?? 30);
const BUDGET = Number(process.env.BUDGET ?? 3000);
const COLS = "ABCDEFGHI";
const nameOf = (row: number, col: number) => `${COLS[col]}${row + 1}`;

const seen = new Set<string>();
let gameNo = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    gameNo += 1;
    if (gameNo !== GAME) continue;
    const human: Player = rec.playerSide;
    const ai = opponent(human);
    console.log(`game ${GAME}: human ${human}, AI ${ai} — ${rec.winReason}, final ${rec.territoryA}:${rec.territoryB}\n`);
    console.log(
      `${"turn".padStart(5)}  ${"who".padEnd(6)}${"played".padEnd(8)}${"AI margin".padStart(10)}` +
        `${"seal on offer".padStart(15)}  ${"engine would play".padStart(18)}`,
    );

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (turn < FROM || turn > TO) continue;

      const who = mover === human ? "human" : "AI";
      const played = m.type === "PLACE" ? nameOf(m.row, m.col) : "PASS";
      // The biggest seal the mover had available before moving.
      const seal = findSealingMoves(before, mover).reduce(
        (best, s) => (s.gained.length > best.n ? { n: s.gained.length, at: nameOf(s.move.row, s.move.col) } : best),
        { n: 0, at: "-" },
      );
      let alt = "";
      if (mover === human && !getSafeActions(before, human).winningMove) {
        const chosen = findBestMoveVeryHard(before, human, BUDGET);
        const key = chosen.type === "PLACE" ? nameOf(chosen.row, chosen.col) : "PASS";
        alt = key === played ? "(same)" : `${key} [${lastDecision.stage}]`;
      }
      console.log(
        `${String(turn).padStart(5)}  ${who.padEnd(6)}${played.padEnd(8)}` +
          `${projectedMargin(state, ai).toFixed(1).padStart(10)}` +
          `${(seal.n ? `${seal.n} at ${seal.at}` : "-").padStart(15)}  ${alt.padStart(18)}`,
      );
    }
  }
}
