/**
 * One position, one disagreement, term by term.
 *
 * `window-diff.mts` turned up the engine wanting F1 in game 18 on turns 22, 24,
 * 26, 30 and 32 — the same point five times over ten plies, rated 550-750 points
 * above whatever the human played, while the human developed elsewhere and won.
 * A number that stubborn is either a real move everyone else is missing or a
 * term reading the same thing wrong every time.
 *
 * `evaluateComponents` exists to answer exactly this: it restates the score the
 * search uses as a named breakdown. So this prints it for both moves side by
 * side, and the difference per term.
 *
 *   GAME=18 TURN=22 npx vite-node drill.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents, evaluateState } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { AIAction, GameState, Player } from "./src/games/alley-boss-cats/types";

const GAME = Number(process.env.GAME ?? 18);
const TURN = Number(process.env.TURN ?? 22);
const ALT = process.env.ALT ?? "F1";

const COLS = "ABCDEFGHI";
const toCoord = (s: string) => ({ row: Number(s.slice(1)) - 1, col: COLS.indexOf(s[0].toUpperCase()) });
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
    console.log(`game ${GAME}: human is ${human}, ${rec.winner === human ? "human won" : "engine won"} by ${rec.winReason}`);
    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const before = state;
      turn += 1;
      const played = m.type === "PLACE" ? nameOf(m.row, m.col) : "PASS";
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (turn !== TURN) continue;

      const mover = before.currentPlayer;
      const alt = toCoord(ALT);
      const altAction: AIAction = { type: "PLACE", row: alt.row, col: alt.col };
      const afterAlt = applyAction(before, altAction);

      console.log(`turn ${TURN}, ${mover === human ? "human" : "engine"} to move`);
      console.log(`  played ${played}, alternative ${ALT}\n`);
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        const cells: string[] = [];
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          const here = nameOf(row, col);
          const cell = before.board[row][col];
          if (here === played) cells.push("h");
          else if (here === ALT) cells.push("e");
          else if (cell === playerCell(mover)) cells.push("O");
          else if (cell === playerCell(opponent(mover))) cells.push("X");
          else if (cell === "NEUTRAL") cells.push("+");
          else cells.push(".");
        }
        console.log(`  ${String(row + 1).padStart(2)} ${cells.join(" ")}`);
      }

      const a = evaluateComponents(state, mover);
      const b = evaluateComponents(afterAlt, mover);
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      console.log(`\n  ${"term".padEnd(26)}${`after ${played}`.padStart(14)}${`after ${ALT}`.padStart(14)}${"difference".padStart(14)}`);
      const rows = keys
        .map((k) => ({ k, a: (a as any)[k] ?? 0, b: (b as any)[k] ?? 0 }))
        .filter((r) => Math.abs(r.b - r.a) > 0.5)
        .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));
      for (const r of rows) {
        console.log(
          `  ${r.k.padEnd(26)}${r.a.toFixed(0).padStart(14)}${r.b.toFixed(0).padStart(14)}${(r.b - r.a).toFixed(0).padStart(14)}`,
        );
      }
      console.log(
        `  ${"TOTAL".padEnd(26)}${evaluateState(state, mover).toFixed(0).padStart(14)}` +
          `${evaluateState(afterAlt, mover).toFixed(0).padStart(14)}` +
          `${(evaluateState(afterAlt, mover) - evaluateState(state, mover)).toFixed(0).padStart(14)}`,
      );
    }
  }
}
