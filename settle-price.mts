/**
 * Why the full search walks past a cell it could have.
 *
 * Stage 4 is the biggest measured loss left: on 29-41% of the turns it answers,
 * its own shortlist held a safer-or-equal move settling more ground, and it took
 * the one settling less — usually settling nothing at all. Unlike stages 1.88 and
 * 1.9, stage 4 is not a single-move stage that never got to compare: the settle
 * was in front of the search and the search rejected it.
 *
 * Two very different faults produce that, and they need opposite fixes:
 *
 *   - the leaf evaluation prices a settled cell below what it is worth, so the
 *     settle loses on the merits at every depth; or
 *   - the leaf prefers the settle and the deeper search talks itself out of it,
 *     which is a horizon or an ordering problem.
 *
 * So this replays the recorded stage-4 turns where a settle was passed up and
 * scores both moves three ways: the leaf evaluation alone, the itemised
 * components behind it, and the depth the real search reached.
 *
 *   npx vite-node settle-price.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState } from "./src/games/alley-boss-cats/ai";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import * as engine_ from "./src/games/alley-boss-cats/engine/minimax";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 1200);
const READ = Number(process.env.READ ?? 400);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Row {
  ply: number;
  cells: number;
  chosenLeaf: number;
  settleLeaf: number;
  depth: number;
  line: string;
}
const rows: Row[] = [];
const seen = new Set<string>();
let stage4 = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      ply += 1;
      if (mover === engine && m.type === "PLACE") {
        const chosen = findBestMoveVeryHard(state, engine, THINK);
        const stage = lastDecision.stage;
        const depth = engine_.lastSearchDepth;
        if (stage.startsWith("4 ") && chosen.type === "PLACE") {
          stage4 += 1;
          const held = new Set(
            state.territories[engine].map((c) => `${c.row},${c.col}`),
          );
          const gainedBy = (row: number, col: number) => {
            const board = state.board.map((r) => [...r]);
            board[row][col] = playerCell(engine);
            return calculateTerritories(board)[engine].filter(
              (c) => !held.has(`${c.row},${c.col}`),
            ).length;
          };
          const mineCells = gainedBy(chosen.row, chosen.col);
          if (mineCells === 0) {
            // The biggest safe settle the search had on offer.
            let best: { row: number; col: number; cells: number } | null = null;
            for (const mv of lastDecision.offered ?? []) {
              const cells = gainedBy(mv.row, mv.col);
              if (cells === 0 || (best && cells <= best.cells)) continue;
              const next = applyAction(state, { type: "PLACE", row: mv.row, col: mv.col });
              if (next.winner && next.winner !== engine) continue;
              if (!next.winner && opponentCanForceCapture(next, engine, 7, READ)) continue;
              best = { row: mv.row, col: mv.col, cells };
            }
            if (best) {
              const afterChosen = applyAction(state, chosen);
              const afterSettle = applyAction(state, {
                type: "PLACE",
                row: best.row,
                col: best.col,
              });
              rows.push({
                ply,
                cells: best.cells,
                chosenLeaf: evaluateState(afterChosen, engine),
                settleLeaf: evaluateState(afterSettle, engine),
                depth,
                line:
                  `  ply ${String(ply).padStart(3)}  depth ${depth}  ` +
                  `${nm(chosen.row, chosen.col)} settles 0, ` +
                  `${nm(best.row, best.col)} settles ${best.cells}`,
              });
            }
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const leafPrefersSettle = rows.filter((r) => r.settleLeaf > r.chosenLeaf);
console.log(`stage 4 turns: ${stage4}`);
console.log(`of those, a safe settle was passed up: ${rows.length}\n`);
console.log(
  `the leaf evaluation already prefers the settle: ${leafPrefersSettle.length}` +
    ` (${((100 * leafPrefersSettle.length) / Math.max(1, rows.length)).toFixed(0)}%)`,
);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(
  `mean leaf gap (settle - chosen): ${mean(rows.map((r) => r.settleLeaf - r.chosenLeaf)).toFixed(0)}` +
    ` points, i.e. ${(mean(rows.map((r) => r.settleLeaf - r.chosenLeaf)) / 100).toFixed(2)} cells`,
);
console.log(`mean search depth on these turns: ${mean(rows.map((r) => r.depth)).toFixed(1)}`);
console.log(`mean cells passed up: ${mean(rows.map((r) => r.cells)).toFixed(1)}\n`);

console.log("by how many cells were on offer\n");
console.log(`${"cells".padEnd(8)}${"turns".padStart(7)}${"leaf prefers settle".padStart(22)}${"mean leaf gap".padStart(16)}`);
for (const c of [...new Set(rows.map((r) => r.cells))].sort((a, b) => a - b)) {
  const g = rows.filter((r) => r.cells === c);
  console.log(
    `${String(c).padEnd(8)}${String(g.length).padStart(7)}` +
      `${`${g.filter((r) => r.settleLeaf > r.chosenLeaf).length}`.padStart(22)}` +
      `${mean(g.map((r) => r.settleLeaf - r.chosenLeaf)).toFixed(0).padStart(16)}`,
  );
}

console.log(`\nthe first few\n`);
for (const r of rows.slice(0, 14)) {
  console.log(
    `${r.line}  leaf ${r.chosenLeaf.toFixed(0)} vs ${r.settleLeaf.toFixed(0)}` +
      ` (${r.settleLeaf > r.chosenLeaf ? "settle scores higher" : "chosen scores higher"})`,
  );
}
