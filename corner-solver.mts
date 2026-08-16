/**
 * Fight one corner out, instead of arguing about it from statistics.
 *
 * Every measurement so far has been indirect: whole games, where the corner
 * line is buried under everything else, or arena runs where the position never
 * arises. The player's suggestion is the direct instrument — take a single
 * corner, let both sides play it to the end, and count.
 *
 * B opens somewhere in the corner, A answers, and this scores every answer.
 * The corner model itself lives in corner-core.mts.
 *
 *   npx vite-node corner-solver.mts                 # answers to (1,2)
 *   OPEN=1,1 npx vite-node corner-solver.mts        # answers to another opening
 *   BUDGET=4 DEPTH=10 npx vite-node corner-solver.mts
 *   JSON=1 npx vite-node corner-solver.mts          # one object, for the viewer
 */
import { REGION, boardWith, cells, newMemo, nm, search } from "./corner-core";
import type { Line } from "./corner-core";
import type { Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 10);
/**
 * Stones each side may spend in the corner in total, B's opening included, so
 * neither side gets a free extra stone. Either side may decline to add one, so
 * this is a ceiling, not a quota.
 */
const BUDGET = Number(process.env.BUDGET ?? 6);

const [oa, ob] = (process.env.OPEN ?? "1,2").split(",").map(Number);
const asJson = process.env.JSON === "1";
// In JSON mode stdout carries one object and nothing else, so the page can read
// a run straight off the pipe.
if (!asJson) {
  console.log(`corner solver — the ${REGION + 1}x${REGION + 1} corner, ${BUDGET} stones a side, depth ${DEPTH}, pass allowed`);
  console.log(`B opens at (${oa},${ob}) = ${nm(oa, ob)}; A to answer. Score is A's corner cells minus B's.\n`);
}

const opening = [{ row: oa, col: ob, side: "B" as Player }];
/** ANSWER=A2,B1 solves only those replies. A wide corner takes hours per reply. */
const only = (process.env.ANSWER ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const answers = cells
  .filter((c) => !(c.row === oa && c.col === ob))
  .filter((c) => only.length === 0 || only.includes(nm(c.row, c.col)))
  .map((c) => {
    const started = Date.now();
    const state = boardWith([...opening, { ...c, side: "A" }]);
    const { score, line }: Line = search(
      state,
      "A",
      "B",
      { A: BUDGET - 1, B: BUDGET - 1 },
      DEPTH,
      -Infinity,
      Infinity,
      newMemo(),
    );
    const dr = Math.min(c.row, 8 - c.row);
    const dc = Math.min(c.col, 8 - c.col);
    const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
    // Progress on stderr as each reply lands: a wide corner can run for hours,
    // and a run that reports nothing until the end is a run you cannot steer.
    console.error(
      `[${new Date().toISOString().slice(11, 19)}] ${nm(c.row, c.col)} (${a},${b}) ` +
        `= ${score} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    return { cell: c, label: `(${a},${b})`, name: nm(c.row, c.col), score, line };
  })
  .sort((x, y) => y.score - x.score);

if (asJson) {
  // Emitted for the review page, which needs the whole variation rather than
  // the summary line — same numbers, machine-readable.
  console.log(JSON.stringify({
    opening: { a: oa, b: ob, name: nm(oa, ob) },
    budget: BUDGET,
    depth: DEPTH,
    region: REGION,
    answers: answers.map((a) => ({
      name: a.name,
      point: a.label,
      row: a.cell.row,
      col: a.cell.col,
      score: a.score,
      line: [`B:${nm(oa, ob)}`, `A:${a.name}`, ...a.line],
    })),
  }));
} else {
  console.log(`${"answer".padEnd(10)}${"point".padEnd(8)}${"A - B".padStart(7)}   continuation (best play by both)`);
  for (const a of answers) {
    console.log(
      `${a.name.padEnd(10)}${a.label.padEnd(8)}${a.score.toFixed(0).padStart(7)}   ` +
        `B:${nm(oa, ob)} A:${a.name} ${a.line.join(" ")}`,
    );
  }
}
