/**
 * Scores arena games on how territory was built, not how much of it there was.
 *
 * The final margin has a 7.2-cell spread across games, so 186 of them cannot
 * resolve the two or three cells a candidate change is worth — the arena has
 * already returned two readings that were later shown to be wrong, one shipped
 * as a regression. But a change aimed at *how* regions get walled can be
 * checked against the walls, and one game supplies several of those.
 *
 * So this applies the same measurement that separated human play from the
 * engine's in the recorded games — cells of final territory per wall stone,
 * and how much of a region's boundary is board edge — to the arena's own games,
 * per engine seat.
 *
 *   npx vite-node arena-walls.mts <arena-output.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { DIRECTIONS, inBounds, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Move, Player } from "./src/games/alley-boss-cats/types";

const MIN_REGION = Number(process.env.MIN_REGION ?? 4);

function regions(cells: Coord[]): Coord[][] {
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  const seen = new Set<string>();
  const out: Coord[][] = [];
  for (const c of cells) {
    if (seen.has(`${c.row},${c.col}`)) continue;
    seen.add(`${c.row},${c.col}`);
    const group: Coord[] = [];
    const stack = [c];
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const [dr, dc] of DIRECTIONS) {
        const r = cur.row + dr, cc = cur.col + dc;
        const k = `${r},${cc}`;
        if (inBounds(r, cc) && set.has(k) && !seen.has(k)) { seen.add(k); stack.push({ row: r, col: cc }); }
      }
    }
    out.push(group);
  }
  return out;
}

interface Seat {
  games: number;
  bigRegions: number;
  bigCells: number;
  wallStones: number;
  edge: number;
  boundary: number;
  margin: number[];
  territory: number[];
}
const blank = (): Seat => ({
  games: 0, bigRegions: 0, bigCells: 0, wallStones: 0, edge: 0, boundary: 0,
  margin: [], territory: [],
});
const seats = new Map<string, Seat>();
/**
 * Engine X's margin, collected per mirrored pair and per source game.
 *
 * Y's margin is exactly the negative of X's, so differencing the two seats
 * inside a game says nothing. The unit of evidence is the pair: the same seed
 * played twice with the colours swapped, which cancels the first-player
 * advantage. Seeds drawn from the same recorded game are correlated on top of
 * that, so the source game is the cluster.
 */
const pairMargin = new Map<number, number[]>();
const clusterMargin = new Map<string, number[]>();

for (const path of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(path, "utf8"));
  for (const match of run.matches) {
    const names: Record<"X" | "Y", string> = match.engines;
    for (const game of match.games) {
      if (!game.moveHistory) {
        throw new Error(`${path} has no moveHistory — rerun the arena on a build that records it`);
      }
      // Replay to the final board. The seeded opening is in the history too,
      // so this reproduces the game exactly as it was played.
      let state: GameState = createInitialState();
      for (const m of game.moveHistory as Move[]) {
        if (state.winner) break;
        state = m.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
      }
      const finalT = calculateTerritories(state.board);

      for (const seatId of ["X", "Y"] as const) {
        const side: Player = seatId === "X" ? game.engineXSide : game.engineYSide;
        const name = names[seatId];
        const seat = seats.get(name) ?? blank();
        seats.set(name, seat);
        seat.games += 1;
        seat.territory.push(game.finalTerritory[seatId]);
        const margin = seatId === "X" ? game.finalTerritoryMargin : -game.finalTerritoryMargin;
        seat.margin.push(margin);
        if (seatId === "X") {
          const pair = pairMargin.get(game.pair) ?? [];
          pair.push(margin);
          pairMargin.set(game.pair, pair);
          const cluster = clusterMargin.get(game.seedSource ?? "unseeded") ?? [];
          cluster.push(margin);
          clusterMargin.set(game.seedSource ?? "unseeded", cluster);
        }

        const own = playerCell(side);
        for (const region of regions(finalT[side])) {
          if (region.length < MIN_REGION) continue;
          const wall = new Set<string>();
          for (const cell of region) {
            for (const [dr, dc] of DIRECTIONS) {
              const r = cell.row + dr, c = cell.col + dc;
              if (!inBounds(r, c)) { seat.edge += 1; seat.boundary += 1; continue; }
              if (state.board[r][c] === own) { wall.add(`${r},${c}`); seat.boundary += 1; }
            }
          }
          // Seed stones have no recorded turn; they still wall the region.
          if (wall.size === 0) continue;
          seat.bigRegions += 1;
          seat.bigCells += region.length;
          seat.wallStones += wall.size;
        }
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

console.log(`regions of ${MIN_REGION}+ cells, by engine seat\n`);
console.log(
  `${"engine".padEnd(14)}${"games".padStart(7)}${"big/game".padStart(10)}${"cells/game".padStart(12)}` +
    `${"cells/stone".padStart(13)}${"edge share".padStart(12)}${"territory".padStart(11)}${"margin".padStart(9)}`,
);
for (const [name, s] of seats) {
  console.log(
    `${name.padEnd(14)}${String(s.games).padStart(7)}${(s.bigRegions / s.games).toFixed(2).padStart(10)}` +
      `${(s.bigCells / s.games).toFixed(1).padStart(12)}` +
      `${(s.bigCells / Math.max(1, s.wallStones)).toFixed(2).padStart(13)}` +
      `${`${((s.edge / Math.max(1, s.boundary)) * 100).toFixed(0)}%`.padStart(12)}` +
      `${mean(s.territory).toFixed(1).padStart(11)}${mean(s.margin).toFixed(2).padStart(9)}`,
  );
}

// Mirrored pairs cancel the first-player advantage, so the pair mean is the
// arena's own unit of evidence — not the individual game.
const report = (label: string, groups: Map<unknown, number[]>) => {
  const values = [...groups.values()].filter((v) => v.length > 0).map(mean);
  if (values.length < 2) return;
  const se = sd(values) / Math.sqrt(values.length);
  const m = mean(values);
  console.log(
    `\n${label}: ${m.toFixed(2)} +/- ${(1.96 * se).toFixed(2)} cells ` +
      `over ${values.length} units (spread ${sd(values).toFixed(1)})`,
  );
  console.log(`  ${Math.abs(m) > 1.96 * se ? "excludes zero" : "includes zero — no call either way"}`);
};
report("X's margin, paired by mirrored pair", pairMargin);
report("X's margin, clustered by source game", clusterMargin);
