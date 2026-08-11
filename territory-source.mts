/**
 * Where does the player's territory come from?
 *
 * The corner book is fixed and fires, the diagonal is out, and the engine still
 * finishes a game around eight cells against the player's sixteen. Engine
 * against engine it makes 10.4 in the games that reach a count, so it is not
 * that the player is holding it down — the gap is that the player makes more.
 *
 * Two finished corner frames are twelve cells. The player finishes on sixteen to
 * twenty-one. So this asks where each side's cells actually sit: in the corner
 * quadrants, along an edge, or in the middle — and how many separate regions
 * they come in, because one big region and four small ones are different games.
 *
 *   npx vite-node territory-source.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const SINCE = process.env.SINCE ?? "";

/** Which part of the board a cell sits in. */
function zoneOf(row: number, col: number): "corner" | "edge" | "middle" {
  const dr = Math.min(row, 8 - row);
  const dc = Math.min(col, 8 - col);
  if (dr <= 2 && dc <= 2) return "corner";
  if (dr <= 1 || dc <= 1) return "edge";
  return "middle";
}

interface Side {
  total: number[];
  corner: number[];
  edge: number[];
  middle: number[];
  regions: number[];
  biggest: number[];
}
const blank = (): Side => ({ total: [], corner: [], edge: [], middle: [], regions: [], biggest: [] });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (SINCE && (rec.appVersion ?? "") !== SINCE) continue;
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    games += 1;

    for (const [name, side] of [["human", human], ["ai", opponent(human)]] as Array<[string, Player]>) {
      const cells = state.territories[side] as Array<{ row: number; col: number }>;
      const s = sides[name];
      s.total.push(cells.length);
      for (const zone of ["corner", "edge", "middle"] as const) {
        s[zone].push(cells.filter((c) => zoneOf(c.row, c.col) === zone).length);
      }

      // Separate regions, so one big enclosure can be told from several small ones.
      const left = new Set(cells.map((c) => `${c.row},${c.col}`));
      const sizes: number[] = [];
      while (left.size > 0) {
        const start = left.values().next().value as string;
        const queue = [start];
        left.delete(start);
        let size = 0;
        while (queue.length > 0) {
          const [r, c] = queue.pop()!.split(",").map(Number);
          size += 1;
          for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const key = `${r + dr},${c + dc}`;
            if (!left.has(key)) continue;
            left.delete(key);
            queue.push(key);
          }
        }
        sizes.push(size);
      }
      s.regions.push(sizes.length);
      s.biggest.push(sizes.length ? Math.max(...sizes) : 0);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = (xs: number[]) => {
  if (xs.length < 2) return "-";
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return `${m.toFixed(1)} +/- ${((1.96 * sd) / Math.sqrt(xs.length)).toFixed(1)}`;
};

console.log(`where the cells sit at the end, ${games} game${games === 1 ? "" : "s"}`);
console.log(`corner = both edge distances 2 or less, edge = on the first two lines, middle = the rest\n`);
console.log(
  `${"side".padEnd(8)}${"total".padStart(14)}${"corner".padStart(14)}${"edge".padStart(14)}` +
    `${"middle".padStart(14)}${"regions".padStart(12)}${"biggest".padStart(14)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${ci(s.total).padStart(14)}${ci(s.corner).padStart(14)}` +
      `${ci(s.edge).padStart(14)}${ci(s.middle).padStart(14)}` +
      `${mean(s.regions).toFixed(2).padStart(12)}${ci(s.biggest).padStart(14)}`,
  );
}
