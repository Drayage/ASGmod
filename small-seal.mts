/**
 * Does the engine take the small seal when a bigger one is there?
 *
 * The player's charge, looking at a live board: it could have enclosed more and
 * settled for less, and choosing the small one when the big one is available is
 * just being bad at the game.
 *
 * That is countable rather than arguable. `findSealingMoves` already reports,
 * for a position, every move that closes ground and how many cells each closes.
 * So at every turn the engine took, this asks what the best available seal was
 * worth and what the move it actually played was worth, and how often the second
 * number is smaller than the first.
 *
 * The player's own turns are counted the same way, because "it left cells on the
 * board" only means something against how often a human does.
 *
 *   npx vite-node small-seal.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const SINCE = process.env.SINCE ?? "";

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Turn { took: number; best: number; ply: number; move: string; bestMove: string }
const turns: Record<string, Turn[]> = { human: [], ai: [] };
const worst: Array<{ side: string; game: string; ply: number; move: string; took: number; best: number; bestMove: string }> = [];

const seen = new Set<string>();
let games = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (SINCE && (rec.appVersion ?? "") !== SINCE) continue;
    const human: Player = rec.playerSide;
    games += 1;

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      ply += 1;
      if (m.type === "PLACE") {
        const seals = findSealingMoves(state, mover);
        const best = seals[0];
        if (best && best.gained.length > 0) {
          const mine = seals.find((s) => s.move.row === m.row && s.move.col === m.col);
          const took = mine ? mine.gained.length : 0;
          const name = mover === human ? "human" : "ai";
          turns[name].push({
            took,
            best: best.gained.length,
            ply,
            move: nm(m.row!, m.col!),
            bestMove: nm(best.move.row, best.move.col),
          });
          // Declining a seal is only a mistake if taking it was safe. The engine
          // has every reason to pass one up that hands over a group, and a
          // capture ends the game outright.
          const after = applyAction(state, { type: "PLACE", ...best.move });
          const safe = !after.winner && !opponentCanForceCapture(after, mover, 7, 300);
          if (best.gained.length - took >= 3 && safe) {
            worst.push({
              side: name,
              game: String(rec.id ?? ""),
              ply,
              move: nm(m.row!, m.col!),
              took,
              best: best.gained.length,
              bestMove: nm(best.move.row, best.move.col),
            });
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

console.log(`turns where some move would have closed ground, ${games} games\n`);
console.log(
  `${"side".padEnd(8)}${"turns".padStart(8)}${"best on offer".padStart(15)}` +
    `${"what it took".padStart(14)}${"took the best".padStart(15)}${"took nothing".padStart(14)}`,
);
for (const [name, ts] of Object.entries(turns)) {
  if (ts.length === 0) continue;
  console.log(
    `${name.padEnd(8)}${String(ts.length).padStart(8)}` +
      `${mean(ts.map((t) => t.best)).toFixed(2).padStart(15)}` +
      `${mean(ts.map((t) => t.took)).toFixed(2).padStart(14)}` +
      `${pct(ts.filter((t) => t.took === t.best).length, ts.length).padStart(15)}` +
      `${pct(ts.filter((t) => t.took === 0).length, ts.length).padStart(14)}`,
  );
}

console.log(`\nby how big the best seal on offer was\n`);
console.log(
  `${"side".padEnd(8)}${"best was".padStart(10)}${"turns".padStart(8)}` +
    `${"took the best".padStart(15)}${"took nothing".padStart(14)}`,
);
for (const [name, ts] of Object.entries(turns)) {
  for (const [label, pick] of [
    ["1-2 cells", (t: Turn) => t.best <= 2],
    ["3-5", (t: Turn) => t.best >= 3 && t.best <= 5],
    ["6+", (t: Turn) => t.best >= 6],
  ] as Array<[string, (t: Turn) => boolean]>) {
    const g = ts.filter(pick);
    if (g.length === 0) continue;
    console.log(
      `${name.padEnd(8)}${label.padStart(10)}${String(g.length).padStart(8)}` +
        `${pct(g.filter((t) => t.took === t.best).length, g.length).padStart(15)}` +
        `${pct(g.filter((t) => t.took === 0).length, g.length).padStart(14)}`,
    );
  }
}

console.log(`\nthe turns that left three or more cells on the board, where taking them was safe\n`);
for (const w of worst.slice(0, 14)) {
  console.log(
    `  ${w.side.padEnd(7)}ply ${String(w.ply).padStart(3)}  played ${w.move}` +
      `  closing ${w.took}, where ${w.bestMove} would have closed ${w.best}`,
  );
}
console.log(`  ... ${worst.filter((w) => w.side === "ai").length} such turns for the engine,` +
  ` ${worst.filter((w) => w.side === "human").length} for the player`);
