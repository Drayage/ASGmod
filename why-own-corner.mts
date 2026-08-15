/**
 * After the book stops, 70% of the engine's stones go back into a corner it
 * already holds, and the full search picks the majority of them itself. Why
 * does the evaluation like those points?
 *
 * `evaluateComponents` itemises the score, so this compares the move actually
 * played (into its own corner) against the best move available outside every
 * corner, term by term. Whichever term is doing the work is the one to argue
 * with.
 *
 *   npx vite-node why-own-corner.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents, evaluateState } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 1200);
const CORNER_DEPTH = Number(process.env.DEPTH ?? 3);

function inCorner(row: number, col: number, size: number): boolean {
  return Math.min(row, size - 1 - row) <= CORNER_DEPTH && Math.min(col, size - 1 - col) <= CORNER_DEPTH;
}

const diffs = new Map<string, number[]>();
let cases = 0;
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    const decided: Array<{ ply: number; stage: string; state: GameState; row: number; col: number }> = [];
    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      ply += 1;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        findBestMoveVeryHard(state, engine, THINK);
        decided.push({ ply, stage: lastDecision.stage, state, row: m.row!, col: m.col! });
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const bookTurns = decided.filter((d) => d.stage.startsWith("1.88") || d.stage.startsWith("0 opening"));
    const bookEnd = bookTurns.length > 0 ? bookTurns[bookTurns.length - 1].ply : 0;

    for (const d of decided) {
      if (d.ply <= bookEnd) continue;
      if (!d.stage.startsWith("4 ")) continue; // the search's own choices only
      const size = d.state.board.length;
      if (!inCorner(d.row, d.col, size)) continue;
      // Does it already hold that corner?
      let mine = 0;
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (!inCorner(r, c, size)) continue;
          if (Math.sign(r - size / 2) !== Math.sign(d.row - size / 2)) continue;
          if (Math.sign(c - size / 2) !== Math.sign(d.col - size / 2)) continue;
          if (d.state.board[r][c] === playerCell(engine)) mine += 1;
        }
      }
      if (mine === 0) continue;

      // Best legal move outside every corner.
      let best: { row: number; col: number; score: number } | null = null;
      for (const mv of getLegalMoves(d.state, engine)) {
        if (inCorner(mv.row, mv.col, size)) continue;
        const s = evaluateState(applyAction(d.state, { type: "PLACE", row: mv.row, col: mv.col }), engine);
        if (!best || s > best.score) best = { ...mv, score: s };
      }
      if (!best) continue;

      cases += 1;
      const played = evaluateComponents(applyAction(d.state, { type: "PLACE", row: d.row, col: d.col }), engine);
      const outside = evaluateComponents(
        applyAction(d.state, { type: "PLACE", row: best.row, col: best.col }),
        engine,
      );
      for (const k of new Set([...Object.keys(played), ...Object.keys(outside)])) {
        const delta = (played[k] ?? 0) - (outside[k] ?? 0);
        diffs.set(k, [...(diffs.get(k) ?? []), delta]);
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`search-chosen own-corner moves compared against the best move outside any corner: ${cases}\n`);
console.log(`${"term".padEnd(20)}${"mean advantage of the corner move".padStart(36)}`);
const sorted = [...diffs.entries()].map(([k, v]) => [k, mean(v)] as const).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) {
  if (Math.abs(v) < 0.5) continue;
  console.log(`${k.padEnd(20)}${v.toFixed(1).padStart(36)}`);
}
console.log(`\ntotal: ${sorted.reduce((a, [, v]) => a + v, 0).toFixed(1)} points (100 = one cell)`);
