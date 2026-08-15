/**
 * The corner opening, built from games rather than from theory.
 *
 * This game's fights start in the corners, so the corner sequence is its
 * opening book, and until now nothing here has derived one — the engine's book
 * is a set of points someone chose, checked only against win rates. The record
 * available is better than that: pro games (including 이세돌), community games,
 * human-vs-human sets, and every recorded game against this engine.
 *
 * Method. Each corner of each game is reduced to a canonical sequence: the
 * moves played inside it, in order, each written as the pair of edge distances
 * from that corner with the smaller first. That normalisation makes all four
 * corners and both diagonal reflections the same position, so eight physical
 * corners collapse into one line of play. Sequences are then scored by what the
 * corner was finally worth to each side.
 *
 * Reading it: "who moves" is relative to whoever played into the corner first,
 * so the tables are about the fight, not about colours.
 *
 *   npx vite-node corner-joseki-book.mts <file ...>
 *
 * DEPTH=3   how far from the corner still counts as being in it
 * MIN=4     how many examples a line needs before it is printed
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 3);
const MIN = Number(process.env.MIN ?? 4);
const PREFIX = Number(process.env.PREFIX ?? 4);

interface Move { first: boolean; a: number; b: number }
interface Fight { seq: Move[]; firstCells: number; secondCells: number; source: string }

const fights: Fight[] = [];
const seen = new Set<string>();

function loadRecords(path: string): any[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const recs = raw.records ?? raw.games ?? raw;
  return Array.isArray(recs) ? recs : [];
}

for (const path of process.argv.slice(2)) {
  let recs: any[];
  try { recs = loadRecords(path); } catch { continue; }
  const source = path.split("/").pop() ?? path;

  for (const rec of recs) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (!rec.moveHistory) continue;

    let state: GameState = createInitialState();
    const size = state.board.length;
    const corners = [
      { name: "TL", r: 0, c: 0 },
      { name: "TR", r: 0, c: size - 1 },
      { name: "BL", r: size - 1, c: 0 },
      { name: "BR", r: size - 1, c: size - 1 },
    ];
    const seq = new Map<string, Array<{ side: Player; a: number; b: number }>>();

    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (m.type === "PLACE") {
        const side = state.currentPlayer;
        for (const corner of corners) {
          const dr = Math.abs(m.row - corner.r);
          const dc = Math.abs(m.col - corner.c);
          if (dr > DEPTH || dc > DEPTH) continue;
          // Only the nearest corner owns the move.
          const nearest = corners.reduce((best, k) =>
            Math.abs(m.row - k.r) + Math.abs(m.col - k.c) <
            Math.abs(m.row - best.r) + Math.abs(m.col - best.c) ? k : best);
          if (nearest.name !== corner.name) continue;
          const [a, b] = dr <= dc ? [dr, dc] : [dc, dr]; // reflection-normalised
          seq.set(corner.name, [...(seq.get(corner.name) ?? []), { side, a, b }]);
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }

    const terr = calculateTerritories(state.board);
    for (const corner of corners) {
      const entries = seq.get(corner.name);
      if (!entries || entries.length === 0) continue;
      const firstSide = entries[0].side;
      const cellsFor = (side: Player) =>
        terr[side].filter((cell) => {
          const dr = Math.abs(cell.row - corner.r);
          const dc = Math.abs(cell.col - corner.c);
          if (dr > DEPTH || dc > DEPTH) return false;
          const nearest = corners.reduce((best, k) =>
            Math.abs(cell.row - k.r) + Math.abs(cell.col - k.c) <
            Math.abs(cell.row - best.r) + Math.abs(cell.col - best.c) ? k : best);
          return nearest.name === corner.name;
        }).length;

      fights.push({
        seq: entries.map((e) => ({ first: e.side === firstSide, a: e.a, b: e.b })),
        firstCells: cellsFor(firstSide),
        secondCells: cellsFor(opponent(firstSide)),
        source,
      });
    }
  }
}

const label = (m: Move) => `${m.first ? "" : "*"}(${m.a},${m.b})`;

console.log(`corner fights collected: ${fights.length}`);
console.log(`  "(a,b)" = the mover who entered first, "*(a,b)" = the answerer`);
console.log(`  a,b are edge distances from that corner, smaller first\n`);

/** Group by the first N moves of the sequence. */
function report(n: number) {
  const groups = new Map<string, Fight[]>();
  for (const f of fights) {
    if (f.seq.length < n) continue;
    const key = f.seq.slice(0, n).map(label).join(" ");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const rows = [...groups.entries()]
    .filter(([, fs]) => fs.length >= MIN)
    .map(([k, fs]) => {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      return {
        k,
        n: fs.length,
        first: mean(fs.map((f) => f.firstCells)),
        second: mean(fs.map((f) => f.secondCells)),
      };
    })
    .sort((a, b) => b.first - b.second - (a.first - a.second));

  if (rows.length === 0) return;
  console.log(`\n=== after ${n} move${n > 1 ? "s" : ""} in the corner ===`);
  console.log(`${"line".padEnd(34)}${"n".padStart(5)}${"entered".padStart(10)}${"answered".padStart(10)}${"edge".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `${r.k.padEnd(34)}${String(r.n).padStart(5)}${r.first.toFixed(1).padStart(10)}` +
        `${r.second.toFixed(1).padStart(10)}${(r.first - r.second).toFixed(1).padStart(8)}`,
    );
  }
}

for (let n = 1; n <= PREFIX; n += 1) report(n);
