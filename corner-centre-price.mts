/**
 * What the corner study cannot see: the price of the centre.
 *
 * corner-solver.mts scores the cells inside one corner block and nothing else.
 * A move that concedes a corner cell to take the middle therefore shows up in
 * that table as a loss, because the thing it bought is outside the frame. The
 * player named the case: against an answer at (0,1), blocking at B1 settles the
 * corner level, while B3 gives the corner cell away and faces the centre.
 *
 * This prices those choices on the whole 9x9 board instead. Each candidate is
 * played out to a count many times with play allowed to vary, so the number is
 * the position's own value rather than one game's luck, and the two candidates
 * are compared on the same seeds so the between-game spread differences away.
 *
 *   npx vite-node corner-centre-price.mts
 *   LINE=C2,A2 CANDIDATES=B1,B3,D1 PLAYOUTS=200 npx vite-node corner-centre-price.mts
 */
import { parsePoint, nm } from "./corner-core";
import { playoutToCount, seededRandom } from "./src/games/alley-boss-cats/labelPlayout";
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const LINE = (process.env.LINE ?? "C2,A2").split(",").map((s) => s.trim()).filter(Boolean);
const CANDIDATES = (process.env.CANDIDATES ?? "B1,B3").split(",").map((s) => s.trim()).filter(Boolean);
const PLAYOUTS = Number(process.env.PLAYOUTS ?? 120);
const TOPK = Number(process.env.TOPK ?? 3);

const sideAt = (ply: number): Player => (ply % 2 === 1 ? "B" : "A");

let base: GameState = createInitialState();
for (let i = 0; i < LINE.length; i += 1) {
  const side = sideAt(i + 1);
  const { row, col } = parsePoint(LINE[i]);
  if (!isLegalMove(base, row, col, side)) throw new Error(`illegal at move ${i + 1}: ${LINE[i]}`);
  base = applyMove({ ...base, currentPlayer: side }, row, col);
}
const toMove = sideAt(LINE.length + 1);

console.log(`whole-board price — ${PLAYOUTS} playouts each, topK ${TOPK}`);
console.log(`after ${LINE.map((p, i) => `${i + 1}.${sideAt(i + 1)}:${p}`).join(" ")}, move ${LINE.length + 1} is ${toMove}'s`);
console.log(`margin is A's final cells minus B's — lower is better for B.\n`);

/** Paired: every candidate sees the same playout seeds. */
const results = CANDIDATES.map((point) => {
  const { row, col } = parsePoint(point);
  if (!isLegalMove(base, row, col, toMove)) throw new Error(`illegal candidate: ${point}`);
  const start = applyMove({ ...base, currentPlayer: toMove }, row, col);
  const margins: number[] = [];
  for (let run = 0; run < PLAYOUTS; run += 1) {
    margins.push(playoutToCount(start, seededRandom(1_000_003 + run * 7919), { topK: TOPK }));
  }
  const mean = margins.reduce((s, v) => s + v, 0) / margins.length;
  const sd = Math.sqrt(margins.reduce((s, v) => s + (v - mean) ** 2, 0) / (margins.length - 1));
  return { point: nm(row, col), mean, sd, se: sd / Math.sqrt(margins.length), margins };
});

console.log(`${"move".padEnd(8)}${"margin".padStart(9)}${"± 95%".padStart(9)}   (A cells - B cells, ${PLAYOUTS} playouts)`);
for (const r of results) {
  console.log(`${r.point.padEnd(8)}${r.mean.toFixed(2).padStart(9)}${(1.96 * r.se).toFixed(2).padStart(9)}`);
}

// Paired differences, which is what the shared seeds were for.
for (let i = 1; i < results.length; i += 1) {
  const a = results[0];
  const b = results[i];
  const diffs = a.margins.map((v, k) => v - b.margins[k]);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  console.log(
    `\n${a.point} - ${b.point} = ${mean.toFixed(2)} +- ${(1.96 * se).toFixed(2)} (paired)` +
      `${Math.abs(mean) > 1.96 * se ? "" : "  — not separated"}`,
  );
}
