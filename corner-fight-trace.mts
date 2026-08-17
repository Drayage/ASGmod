/**
 * The corner fight, move by move, not averaged.
 *
 * The player's rule, stated: a corner where you could not get two stones down
 * is not a corner you will make much in, so you match their count — they play
 * a second, you play a second; they play a fourth, your third becomes forced.
 * The averages in this repo cannot check that, because they collapse the order
 * the stones arrived in, which is the whole content of the rule.
 *
 * So this prints each corner of each game as a sequence: who played there, in
 * what order, and what the corner was finally worth to each side.
 *
 *   npx vite-node corner-fight-trace.mts <export.json ...>
 *
 * SIDE=engine|human  print only that side's perspective ordering
 * DEPTH=2            how deep a cell counts as "in the corner"
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
const DEPTH = Number(process.env.DEPTH ?? 3);
const LIMIT = Number(process.env.LIMIT ?? 8);

function cornerOf(row: number, col: number, size: number): string | null {
  const dr = Math.min(row, size - 1 - row);
  const dc = Math.min(col, size - 1 - col);
  if (dr > DEPTH || dc > DEPTH) return null;
  return `${row < size / 2 ? "T" : "B"}${col < size / 2 ? "L" : "R"}`;
}

interface Entry { ply: number; side: "engine" | "human"; cell: string; myCount: number; theirCount: number }

let printed = 0;
const seen = new Set<string>();
/** Aggregated: for each (engine stones, human stones) end state, cells held. */
const outcomes = new Map<string, { games: number; engineCells: number; humanCells: number }>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);

    let state: GameState = createInitialState();
    const size = state.board.length;
    const seq = new Map<string, Entry[]>();
    const count = new Map<string, { engine: number; human: number }>();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      ply += 1;
      if (m.type === "PLACE") {
        const q = cornerOf(m.row!, m.col!, size);
        if (q) {
          const side = state.currentPlayer === engine ? "engine" : "human";
          const c = count.get(q) ?? { engine: 0, human: 0 };
          c[side] += 1;
          count.set(q, c);
          seq.set(q, [
            ...(seq.get(q) ?? []),
            {
              ply,
              side,
              cell: nm(m.row!, m.col!),
              myCount: c[side],
              theirCount: side === "engine" ? c.human : c.engine,
            },
          ]);
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }

    const terr = calculateTerritories(state.board);
    const cellsIn = (side: Player, q: string) =>
      terr[side].filter((c) => cornerOf(c.row, c.col, size) === q).length;

    for (const [q, entries] of seq) {
      const c = count.get(q)!;
      const eCells = cellsIn(engine, q);
      const hCells = cellsIn(human, q);
      const key = `${c.engine}v${c.human}`;
      const o = outcomes.get(key) ?? { games: 0, engineCells: 0, humanCells: 0 };
      o.games += 1;
      o.engineCells += eCells;
      o.humanCells += hCells;
      outcomes.set(key, o);

      if (printed < LIMIT) {
        printed += 1;
        console.log(
          `\n${rec.id ?? "?"}  corner ${q}  —  engine ${c.engine} stones / human ${c.human}, ` +
            `final cells engine ${eCells} / human ${hCells}`,
        );
        for (const e of entries) {
          console.log(
            `   ply ${String(e.ply).padStart(3)}  ${e.side === "engine" ? "ENGINE" : "human "} ` +
              `${e.cell.padEnd(3)}  (now ${e.side === "engine" ? `${e.myCount} vs ${e.theirCount}` : `${e.theirCount} vs ${e.myCount}`} engine:human)`,
          );
        }
      }
    }
  }
}

console.log(`\n\nhow every corner ended, by final stone counts (engine v human)\n`);
console.log(`${"stones".padEnd(10)}${"corners".padStart(9)}${"engine cells".padStart(15)}${"human cells".padStart(14)}`);
const rows = [...outcomes.entries()].sort((a, b) => b[1].games - a[1].games);
for (const [k, o] of rows) {
  if (o.games < 3) continue;
  console.log(
    `${k.padEnd(10)}${String(o.games).padStart(9)}` +
      `${(o.engineCells / o.games).toFixed(1).padStart(15)}${(o.humanCells / o.games).toFixed(1).padStart(14)}`,
  );
}
