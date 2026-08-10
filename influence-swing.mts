/**
 * Where does one stone find six cells of margin?
 *
 * At game 18 turn 22 the engine rates F1 631 points above the human's move, and
 * `evaluateComponents` puts all of it in one term: territory, 916 to 1504. That
 * term is the projected margin times 100, so a single stone on the top edge is
 * moving the projected count by 5.9 cells.
 *
 * The projection prices open ground by a distance field: each empty cell goes to
 * whichever side reaches it first, and a cell both sides reach in the same number
 * of steps goes to nobody. That is a tie, and ties break all at once — so this
 * counts how many cells actually change hands, and how many of them were
 * contested rather than the opponent's.
 *
 *   GAME=18 TURN=22 ALT=F1 npx vite-node influence-swing.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents, projectedMargin, tuning } from "./src/games/alley-boss-cats/ai";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent } from "./src/games/alley-boss-cats/types";
import type { AIAction, GameState, Player } from "./src/games/alley-boss-cats/types";

const GAME = Number(process.env.GAME ?? 18);
const TURN = Number(process.env.TURN ?? 22);
const ALT = process.env.ALT ?? "F1";
const COLS = "ABCDEFGHI";
const toCoord = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0].toUpperCase()) });

function tally(state: GameState) {
  const owners = influenceOwnerMap(state.board);
  const out = { A: 0, B: 0, none: 0 };
  for (const o of owners) {
    if (o === "A") out.A += 1;
    else if (o === "B") out.B += 1;
    else out.none += 1;
  }
  return { owners, out };
}

const seen = new Set<string>();
let gameNo = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    gameNo += 1;
    if (gameNo !== GAME) continue;
    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (turn !== TURN) continue;

      const mover: Player = before.currentPlayer;
      const alt = toCoord(ALT);
      const action: AIAction = { type: "PLACE", row: alt.row, col: alt.col };
      const after = applyAction(before, action);

      const b = tally(before);
      const a = tally(after);
      console.log(`game ${GAME} turn ${TURN}, ${mover} to move, alternative ${ALT}\n`);
      console.log(`influence cells      before        after       change`);
      for (const side of ["A", "B", "none"] as const) {
        console.log(
          `  ${side.padEnd(18)}${String(b.out[side]).padStart(7)}${String(a.out[side]).padStart(13)}` +
            `${String(a.out[side] - b.out[side]).padStart(13)}`,
        );
      }
      let fromNone = 0;
      let fromThem = 0;
      for (let i = 0; i < b.owners.length; i += 1) {
        if (a.owners[i] === mover && b.owners[i] !== mover) {
          if (b.owners[i] === null) fromNone += 1;
          else fromThem += 1;
        }
      }
      console.log(`\ncells the mover gained: ${fromNone + fromThem} — ${fromNone} from contested, ${fromThem} from the opponent`);
      console.log(`projected margin: ${projectedMargin(before, mover).toFixed(2)} -> ${projectedMargin(after, mover).toFixed(2)} cells`);
      // The influence difference barely moved, so the rest has to be settled
      // ground. Printed rather than inferred.
      console.log(
        `settled territory: A ${before.territories.A.length} -> ${after.territories.A.length}, ` +
          `B ${before.territories.B.length} -> ${after.territories.B.length}`,
      );
      const cellsOf = (st: GameState, side: Player) =>
        st.territories[side].map((c) => `${COLS[c.col]}${c.row + 1}`).sort().join(" ");
      console.log(`  A after: ${cellsOf(after, "A") || "-"}`);
      console.log(`  B after: ${cellsOf(after, "B") || "-"}`);
      console.log(`  A before: ${cellsOf(before, "A") || "-"}`);
      console.log(`  B before: ${cellsOf(before, "B") || "-"}`);

      // The same swing under the calibrated pricing. If a seal of ground nobody
      // is contesting stops being worth six cells there, then §28's term does fix
      // this and the arena simply could not see it.
      // Read through evaluateComponents, not projectedMargin: the exported
      // helper builds its own plain influence count and never sees the flag, so
      // asking it would have compared the shipped term with itself.
      const territoryTerm = (st: GameState) => ((evaluateComponents(st, mover) as any).territory ?? 0) / 100;
      for (const on of [false, true]) {
        tuning.calibratedOpenGround = on;
        console.log(
          `  ${on ? "calibrated" : "shipped   "}  ${ALT}: ` +
            `${territoryTerm(before).toFixed(2)} -> ${territoryTerm(after).toFixed(2)} ` +
            `(${(territoryTerm(after) - territoryTerm(before)).toFixed(2)} cells)`,
        );
      }
      tuning.calibratedOpenGround = false;

      // What the same stone does one cell over, as a control.
      console.log(`\nthe same question for every legal move, largest swing first:`);
      const swings: Array<{ key: string; d: number }> = [];
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          if (before.board[row][col] !== "EMPTY") continue;
          try {
            const s = applyAction(before, { type: "PLACE", row, col });
            swings.push({ key: `${COLS[col]}${row + 1}`, d: projectedMargin(s, mover) - projectedMargin(before, mover) });
          } catch { /* illegal here */ }
        }
      }
      swings.sort((x, y) => y.d - x.d);
      console.log(`  ${swings.slice(0, 8).map((s) => `${s.key} ${s.d >= 0 ? "+" : ""}${s.d.toFixed(1)}`).join("   ")}`);
      console.log(`  median swing ${swings[Math.floor(swings.length / 2)].d.toFixed(2)}, worst ${swings[swings.length - 1].d.toFixed(1)}`);
    }
  }
}
