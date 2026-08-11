/**
 * When the engine passes an enclosure, does it ever come back for it?
 *
 * The player, watching it split a large region instead of stepping two down for
 * three more cells: there is no reason to do that. There is a possible one, and
 * it is worth checking before agreeing. A seal that will still be there next
 * turn costs nothing to defer, so a search that believes the ground is permanent
 * will always find something else to do first. That is only a mistake if the
 * belief is wrong.
 *
 * So this follows every seal the engine passed up. Was the same point still
 * sealable on its next turn, and the one after? Did it ever take it? And what
 * happened to those cells by the end — did it get them anyway, or did they go?
 *
 *   npx vite-node seal-deferred.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const LEAST = Number(process.env.LEAST ?? 3);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Passed {
  side: string;
  ply: number;
  point: string;
  worth: number;
  /** Own turns the same point stayed sealable after being passed. */
  stayed: number;
  /** It was eventually played by the side that passed it. */
  taken: boolean;
  /** Cells of that enclosure the passer held at the end. */
  kept: number;
}

const all: Passed[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;

    // Replay once, keeping every position and move so the future can be read.
    const states: GameState[] = [];
    const moves: Array<{ mover: Player; row: number; col: number } | null> = [];
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      states.push(state);
      moves.push(m.type === "PLACE" ? { mover: state.currentPlayer, row: m.row!, col: m.col! } : null);
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const final = state;

    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      if (!move) continue;
      const seals = findSealingMoves(states[i], move.mover);
      const best = seals[0];
      if (!best || best.gained.length < LEAST) continue;
      const mine = seals.find((s) => s.move.row === move.row && s.move.col === move.col);
      if ((mine?.gained.length ?? 0) >= best.gained.length) continue; // took it

      // Walk their later turns: was the same point still a seal, and did they
      // ever play it?
      let stayed = 0;
      let taken = false;
      let counting = true;
      for (let j = i + 1; j < moves.length; j += 1) {
        const later = moves[j];
        if (!later || later.mover !== move.mover) continue;
        if (later.row === best.move.row && later.col === best.move.col) {
          taken = true;
          break;
        }
        if (counting) {
          const stillThere = findSealingMoves(states[j], move.mover).some(
            (s) => s.move.row === best.move.row && s.move.col === best.move.col,
          );
          if (stillThere) stayed += 1;
          else counting = false;
        }
      }

      const held = new Set(
        (final.territories[move.mover] as Array<{ row: number; col: number }>).map(
          (c) => `${c.row},${c.col}`,
        ),
      );
      const kept = best.gained.filter((c: { row: number; col: number }) =>
        held.has(`${c.row},${c.col}`),
      ).length;

      all.push({
        side: move.mover === human ? "human" : "ai",
        ply: i + 1,
        point: nm(best.move.row, best.move.col),
        worth: best.gained.length,
        stayed,
        taken,
        kept,
      });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

console.log(`enclosures of ${LEAST}+ cells that were passed up\n`);
console.log(
  `${"side".padEnd(8)}${"times".padStart(7)}${"worth".padStart(8)}` +
    `${"still there next turn".padStart(23)}${"ever taken".padStart(12)}` +
    `${"cells kept at the end".padStart(23)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((p) => p.side === side);
  if (g.length === 0) continue;
  console.log(
    `${side.padEnd(8)}${String(g.length).padStart(7)}${mean(g.map((p) => p.worth)).toFixed(1).padStart(8)}` +
      `${pct(g.filter((p) => p.stayed >= 1).length, g.length).padStart(23)}` +
      `${pct(g.filter((p) => p.taken).length, g.length).padStart(12)}` +
      `${`${mean(g.map((p) => p.kept)).toFixed(1)} of ${mean(g.map((p) => p.worth)).toFixed(1)}`.padStart(23)}`,
  );
}

console.log(`\nhow long it stayed on the board after being passed\n`);
console.log(`${"side".padEnd(8)}${"stayed".padStart(10)}${"times".padStart(8)}${"ever taken".padStart(12)}${"kept".padStart(8)}`);
for (const side of ["human", "ai"]) {
  const g = all.filter((p) => p.side === side);
  for (const [label, pick] of [
    ["gone at once", (p: Passed) => p.stayed === 0],
    ["1-2 turns", (p: Passed) => p.stayed >= 1 && p.stayed <= 2],
    ["3+ turns", (p: Passed) => p.stayed >= 3],
  ] as Array<[string, (p: Passed) => boolean]>) {
    const x = g.filter(pick);
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(10)}${String(x.length).padStart(8)}` +
        `${pct(x.filter((p) => p.taken).length, x.length).padStart(12)}` +
        `${mean(x.map((p) => p.kept)).toFixed(1).padStart(8)}`,
    );
  }
}
