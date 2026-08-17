/**
 * The book is supposed to stop once each corner has its pair. The player's
 * report is that the engine keeps piling stones into its own corners well past
 * that, and that this is wrong on its face — those stones are not buying much.
 *
 * So this counts, for every engine turn *after* the corner book has stopped
 * answering, where the stone actually went: into a corner the engine already
 * has stones in, into a corner it does not, or out in the rest of the board.
 * And it names the stage that decided each one, so "why" has an answer rather
 * than a guess.
 *
 *   npx vite-node own-corner-after-book.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
const THINK = Number(process.env.THINK ?? 1200);
/** A cell counts as "in a corner" when both edge distances are this or less. */
const CORNER_DEPTH = Number(process.env.DEPTH ?? 3);

function cornerOf(row: number, col: number, size: number): string | null {
  const dr = Math.min(row, size - 1 - row);
  const dc = Math.min(col, size - 1 - col);
  if (dr > CORNER_DEPTH || dc > CORNER_DEPTH) return null;
  return `${row < size / 2 ? "T" : "B"}${col < size / 2 ? "L" : "R"}`;
}

let afterBookTurns = 0;
let intoOwnCorner = 0;
let intoEmptyCorner = 0;
let intoTheirCorner = 0;
let elsewhere = 0;
/** Stones already in that corner when the engine added another. */
const stackDepth: number[] = [];
const stagesForOwn = new Map<string, number>();
const seen = new Set<string>();
const lines: string[] = [];

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    // Pass one: find the last turn the book decided.
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
      afterBookTurns += 1;
      const size = d.state.board.length;
      const q = cornerOf(d.row, d.col, size);
      if (!q) {
        elsewhere += 1;
        continue;
      }
      // Who is already in that corner?
      let mine = 0;
      let theirs = 0;
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (cornerOf(r, c, size) !== q) continue;
          if (d.state.board[r][c] === playerCell(engine)) mine += 1;
          else if (d.state.board[r][c] === playerCell(human)) theirs += 1;
        }
      }
      if (mine > 0) {
        intoOwnCorner += 1;
        stackDepth.push(mine);
        stagesForOwn.set(d.stage, (stagesForOwn.get(d.stage) ?? 0) + 1);
        if (lines.length < 12) {
          lines.push(
            `  ply ${String(d.ply).padStart(3)}  ${nm(d.row, d.col)} into ${q} ` +
              `(already ${mine} mine, ${theirs} theirs)  [${d.stage}]`,
          );
        }
      } else if (theirs > 0) intoTheirCorner += 1;
      else intoEmptyCorner += 1;
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number) => `${((100 * n) / Math.max(1, afterBookTurns)).toFixed(0)}%`;
console.log(`engine turns after the book stopped: ${afterBookTurns}\n`);
console.log(`  into a corner it already holds:  ${intoOwnCorner} (${pct(intoOwnCorner)})`);
console.log(`  into a corner only they hold:    ${intoTheirCorner} (${pct(intoTheirCorner)})`);
console.log(`  into an empty corner:            ${intoEmptyCorner} (${pct(intoEmptyCorner)})`);
console.log(`  everywhere else:                 ${elsewhere} (${pct(elsewhere)})`);
console.log(`\nstones already there when it added another: mean ${mean(stackDepth).toFixed(1)}`);
console.log(`\nwhich stage sent it back into its own corner\n`);
for (const [s, n] of [...stagesForOwn.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(30)}${String(n).padStart(5)}`);
}
console.log(`\nthe first few\n`);
for (const l of lines) console.log(l);
