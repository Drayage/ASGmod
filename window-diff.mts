/**
 * The human's move against the engine's, position by position, in the window
 * where the game is actually decided.
 *
 * Every hypothesis this branch built from aggregate statistics — human mean
 * against engine mean — has turned out to be a symptom or too small to matter,
 * eight times. Both fixes that ever worked came from opening a single position
 * and looking at one move: the two "captures" that captured nothing, and the eye
 * point that sat unplayed for nine turns.
 *
 * The settled-territory gap reaches 82% of its final size by 34 stones, so this
 * takes the human's own positions in that window, asks the engine what it would
 * play there, and prints the disagreements with the board — sorted so the ones
 * worth reading by hand come first.
 *
 *   STRIDE=1 TOP=12 npx vite-node window-diff.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const STRIDE = Number(process.env.STRIDE ?? 1);
const MIN_STONES = Number(process.env.MIN_STONES ?? 10);
const MAX_STONES = Number(process.env.MAX_STONES ?? 34);
const TOP = Number(process.env.TOP ?? 12);

const COLS = "ABCDEFGHI";
const name = (row: number, col: number) => `${COLS[col]}${row + 1}`;

function render(state: GameState, human: Player, humanMove: string, engineMove: string): string {
  const lines: string[] = [`     ${COLS.split("").join(" ")}`];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const here = name(row, col);
      const cell = state.board[row][col];
      if (here === humanMove && here === engineMove) cells.push("*");
      else if (here === humanMove) cells.push("h");
      else if (here === engineMove) cells.push("e");
      else if (cell === playerCell(human)) cells.push("O");
      else if (cell === playerCell(opponent(human))) cells.push("X");
      else if (cell === "NEUTRAL") cells.push("+");
      else cells.push(".");
    }
    lines.push(`  ${String(row + 1).padStart(2)} ${cells.join(" ")}`);
  }
  return lines.join("\n");
}

interface Case {
  game: number;
  turn: number;
  stones: number;
  humanMove: string;
  engineMove: string;
  /** How much worse the engine rates the human's move than its own. */
  gap: number;
  stage: string;
  humanSeals: number;
  engineSeals: number;
  board: string;
}
const cases: Case[] = [];

const seen = new Set<string>();
let gameNo = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    gameNo += 1;
    const human: Player = rec.playerSide;

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
      if (m.type !== "PLACE" || mover !== human) continue;

      let stones = 0;
      for (const row of before.board) for (const cell of row) if (cell !== "EMPTY") stones += 1;
      if (stones < MIN_STONES || stones > MAX_STONES) continue;
      if ((turn / 2) % STRIDE !== 0) continue;
      if (getSafeActions(before, human).winningMove) continue;

      // What the engine would play from the human's seat.
      const chosen = findBestMoveVeryHard(before, human, BUDGET);
      if (chosen.type !== "PLACE") continue;
      const engineMove = name(chosen.row, chosen.col);
      const humanMove = name(m.row, m.col);
      if (engineMove === humanMove) continue;

      const afterEngine = evaluateState(applyAction(before, chosen), human);
      const afterHuman = evaluateState(state, human);
      const sealsOf = (s: GameState) =>
        findSealingMoves(s, human).reduce((best, x) => Math.max(best, x.gained.length), 0);

      cases.push({
        game: gameNo,
        turn,
        stones,
        humanMove,
        engineMove,
        gap: afterEngine - afterHuman,
        stage: lastDecision.stage,
        humanSeals: sealsOf(state),
        engineSeals: sealsOf(applyAction(before, chosen)),
        board: render(before, human, humanMove, engineMove),
      });
    }
  }
}

cases.sort((a, b) => b.gap - a.gap);
console.log(
  `${cases.length} positions at ${MIN_STONES}-${MAX_STONES} stones where the engine would not play the human's move\n` +
    `O = human, X = engine's side, h = human played, e = engine would play, + = neutral centre\n`,
);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`mean gap the engine sees between its move and the human's: ${mean(cases.map((c) => c.gap)).toFixed(0)}`);
const stages = new Map<string, number>();
for (const c of cases) stages.set(c.stage, (stages.get(c.stage) ?? 0) + 1);
console.log(`stage that answered, from the human's seat:`);
for (const [stage, n] of [...stages].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stage.padEnd(28)}${n}`);
}
console.log(
  `\nseal on offer after the move — human ${mean(cases.map((c) => c.humanSeals)).toFixed(2)} cells, ` +
    `engine ${mean(cases.map((c) => c.engineSeals)).toFixed(2)}`,
);

for (const c of cases.slice(0, TOP)) {
  console.log(
    `\n${"=".repeat(46)}\ngame ${c.game} turn ${c.turn} (${c.stones} stones)  ` +
      `human ${c.humanMove}, engine ${c.engineMove}  gap ${c.gap.toFixed(0)}  [${c.stage}]`,
  );
  console.log(c.board);
}
