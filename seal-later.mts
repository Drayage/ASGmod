/**
 * What happened to the cells the engine declined to bank.
 *
 * The engine sees the seal, scores it 202 points higher than what it plays, and
 * plays elsewhere anyway — 113 times in 32 games. Re-deciding on the current
 * build reproduces it: 35 of 38 still skipped, and even the 17 that reach the
 * full search take the seal twice.
 *
 * One explanation would make that behaviour correct: sealing locks a region at
 * its current size, and holding off keeps the option of a bigger one. So this
 * asks the game itself. For each skipped seal, the cells it would have settled
 * are looked up on the final board of the game that actually followed — kept,
 * lost to the opponent, or left unsettled by anyone.
 *
 *   npx vite-node seal-later.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);
/** Only games that ended the way the count decides them, when set. A game cut
 * short by a capture leaves everything unsettled, which would read as the
 * engine losing ground it simply never had time to settle. */
const ONLY = process.env.ONLY_REASON ?? "";
/**
 * Which side's declined seals to follow. The engine's were the question first,
 * but the human plays the same way on purpose — start small, and take the
 * bigger frame when the opponent does not contest it — so the same measurement
 * on their side says whether declining is a skill or a leak.
 */
const SIDE = process.env.SIDE === "human" ? "human" : "ai";

let skips = 0;
let cellsDeclined = 0;
let kept = 0;
let lost = 0;
let neutral = 0;
/** Of the skips, how many ended with the engine holding every declined cell. */
let fullyKept = 0;
/** And how many later grew that same corner into something bigger. */
let grew = 0;
/**
 * The same pocket is offered turn after turn, so counting cells per skip counts
 * one two-cell corner five times. These are the distinct cells per game, which
 * is the only version that can be read as "cells a game".
 */
let games = 0;
let distinctDeclined = 0;
let distinctNeutral = 0;
let distinctKept = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    const human: Player = rec.playerSide;
    const ai: Player = opponent(human);
    const mover: Player = SIDE === "human" ? human : ai;

    // The final board of the game as it was actually played.
    let final: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (final.winner) break;
      final = m.type === "PASS"
        ? applyAction(final, { type: "PASS" })
        : applyAction(final, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const finalT = calculateTerritories(final.board);
    const mine = new Set(finalT[mover].map((c: Coord) => `${c.row},${c.col}`));
    const theirs = new Set(finalT[opponent(mover)].map((c: Coord) => `${c.row},${c.col}`));

    games += 1;
    const declinedCells = new Set<string>();
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const isAI = state.currentPlayer === mover;
      const before = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (!isAI || m.type !== "PLACE") continue;

      const seals = findSealingMoves(before, mover).filter((s) => s.gained.length >= MIN_CELLS);
      if (seals.length === 0) continue;
      const playedKey = `${m.row},${m.col}`;
      if (seals.some((s) => `${s.move.row},${s.move.col}` === playedKey)) continue;

      const best = seals[0];
      skips += 1;
      cellsDeclined += best.gained.length;
      let keptHere = 0;
      for (const cell of best.gained) {
        const key = `${cell.row},${cell.col}`;
        declinedCells.add(key);
        if (mine.has(key)) { kept += 1; keptHere += 1; }
        else if (theirs.has(key)) lost += 1;
        else neutral += 1;
      }
      if (keptHere === best.gained.length) fullyKept += 1;
      // Did waiting actually buy a bigger region? Count the engine's final
      // territory connected to the declined cells.
      if (keptHere > 0) {
        const stack = best.gained.filter((c) => mine.has(`${c.row},${c.col}`));
        const visited = new Set(stack.map((c) => `${c.row},${c.col}`));
        let size = 0;
        while (stack.length) {
          const cur = stack.pop()!;
          size += 1;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = `${cur.row + dr},${cur.col + dc}`;
            if (mine.has(k) && !visited.has(k)) {
              visited.add(k);
              stack.push({ row: cur.row + dr, col: cur.col + dc });
            }
          }
        }
        if (size > best.gained.length) grew += 1;
      }
    }

    for (const key of declinedCells) {
      distinctDeclined += 1;
      if (mine.has(key)) distinctKept += 1;
      else if (!theirs.has(key)) distinctNeutral += 1;
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`side: ${SIDE}`);
console.log(`skipped seals: ${skips}, cells declined: ${cellsDeclined}\n`);
console.log(`where those cells ended up:`);
console.log(`  the engine's territory anyway : ${kept} (${pct(kept, cellsDeclined)})`);
console.log(`  the opponent's                : ${lost} (${pct(lost, cellsDeclined)})`);
console.log(`  nobody's                      : ${neutral} (${pct(neutral, cellsDeclined)})`);
console.log(`\nper skip:`);
console.log(`  kept every declined cell      : ${fullyKept} (${pct(fullyKept, skips)})`);
console.log(`  ...and the region grew bigger : ${grew} (${pct(grew, skips)})`);
console.log(`\ndistinct cells, deduped within each game (${games} game(s)):`);
console.log(`  ever declined     : ${distinctDeclined} (${(distinctDeclined / games).toFixed(1)} a game)`);
console.log(`  kept anyway       : ${distinctKept} (${pct(distinctKept, distinctDeclined)})`);
console.log(`  ended up nobody's : ${distinctNeutral} (${(distinctNeutral / games).toFixed(1)} a game)`);
