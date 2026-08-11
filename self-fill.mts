/**
 * Does the engine play inside its own area and cut it in half?
 *
 * The player's charge is not about deferring: the move they saw took ground the
 * engine already had, splitting its own region, where the same stone two cells
 * lower would have done everything that one did and enclosed three more. That is
 * a dominated move, not a judgement call.
 *
 * The recognisable version of it is a stone played deep inside ground your own
 * influence already owns, with nothing of theirs near enough to be answering.
 * Every such stone costs a cell of your own area outright — the point it sits on
 * — and buys whatever the outside of the region would have bought instead.
 *
 * So this counts them, for both sides, and asks what the cell was worth: was it
 * territory of the mover's at the end of the game, or did the region not close
 * anyway.
 *
 *   npx vite-node self-fill.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** How far an enemy stone must be for the move to count as unforced. */
const CLEAR = Number(process.env.CLEAR ?? 2);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Fill { side: string; ply: number; move: string; bestSeal: number; tookSeal: number }
const fills: Fill[] = [];
const turnsBySide: Record<string, number> = { human: 0, ai: 0 };
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      ply += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;
      const name = mover === human ? "human" : "ai";
      turnsBySide[name] += 1;

      // Mine by influence already, and nothing of theirs within reach.
      const owners = influenceOwnerMap(before.board);
      if (owners[m.row! * 9 + m.col!] !== mover) continue;
      let clear = true;
      for (let r = 0; r < 9 && clear; r += 1) {
        for (let c = 0; c < 9; c += 1) {
          if (before.board[r][c] !== playerCell(opponent(mover))) continue;
          if (Math.max(Math.abs(r - m.row!), Math.abs(c - m.col!)) <= CLEAR) { clear = false; break; }
        }
      }
      if (!clear) continue;

      const seals = findSealingMoves(before, mover);
      const best = seals[0];
      const mine = seals.find((s) => s.move.row === m.row && s.move.col === m.col);
      fills.push({
        side: name,
        ply,
        move: nm(m.row!, m.col!),
        bestSeal: best?.gained.length ?? 0,
        tookSeal: mine?.gained.length ?? 0,
      });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

console.log(`stones played inside ground their own influence already held,`);
console.log(`with no enemy stone within ${CLEAR} steps\n`);
console.log(
  `${"side".padEnd(8)}${"such moves".padStart(12)}${"of all turns".padStart(14)}` +
    `${"closed nothing".padStart(16)}${"best seal going begging".padStart(25)}`,
);
for (const side of ["human", "ai"]) {
  const g = fills.filter((f) => f.side === side);
  if (g.length === 0) continue;
  console.log(
    `${side.padEnd(8)}${String(g.length).padStart(12)}` +
      `${pct(g.length, turnsBySide[side]).padStart(14)}` +
      `${pct(g.filter((f) => f.tookSeal === 0).length, g.length).padStart(16)}` +
      `${mean(g.map((f) => f.bestSeal)).toFixed(2).padStart(25)}`,
  );
}

console.log(`\nthe engine's, where a seal of 3+ was on offer and it closed nothing\n`);
const bad = fills.filter((f) => f.side === "ai" && f.tookSeal === 0 && f.bestSeal >= 3);
for (const f of bad.slice(0, 12)) {
  console.log(`  ply ${String(f.ply).padStart(3)}  played ${f.move} inside its own ground, ${f.bestSeal} cells were sealable`);
}
console.log(`  ... ${bad.length} of them, against ${fills.filter((f) => f.side === "human" && f.tookSeal === 0 && f.bestSeal >= 3).length} for the player`);
