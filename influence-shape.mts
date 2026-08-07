/**
 * Is the human's claim more concentrated than the engine's, or just smaller?
 *
 * §3.8 measured the gap: over the same games the engine reaches 39.1 cells of
 * influence and closes 10.2% of it, the human reaches 23.4 and closes 33.8%.
 * Two very different mechanisms produce that, and they want opposite fixes.
 *
 *   - The engine claims the same *shape* as the human, just more of it. Then
 *     `INFLUENCE_TO_TERRITORY` overprices reach and the fix is a constant.
 *   - The engine claims the same total in a worse shape: many small scattered
 *     regions with open boundaries, against a few large ones nearly enclosed.
 *     Then the constant is fine — it is right on average and wrong at the
 *     margin, since a cell added to a sprawl converts at nothing while a cell
 *     added to a closable region converts at a lot.
 *
 * The constant is 0.12 and measured conversion is 10-16%, so the first is
 * already unlikely. This checks the second directly: for every position of
 * every recorded game it splits each side's influence into connected regions
 * and reports how many there are, how big, and how much of each region's
 * boundary is not yet the claimant's own wall.
 *
 *   npx vite-node influence-shape.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  moveHistory: Move[];
}

interface Shape {
  regions: number;
  largest: number;
  /** Boundary cells of the side's regions that are neither its own stones nor its own influence. */
  openBoundaryShare: number;
}

/**
 * Connected components of one side's influence, and how sealed they are.
 *
 * A boundary neighbour is *sealed* if it is a stone of either colour or the
 * board edge — something ground cannot leak through — and *open* if it is
 * empty ground the region does not own, meaning contested cells and the
 * opponent's influence. A region ringed by walls is nearly finished ground; a
 * mostly open one is a claim in name only, and a linear influence count prices
 * the two the same.
 *
 * `influenceOwnerMap` marks every occupied cell `null`, the same value it uses
 * for contested empty ground, so the board has to be consulted to tell a wall
 * from a hole.
 */
function shapeOf(owners: Array<Player | null>, board: GameState["board"], side: Player): Shape {
  const index = (row: number, col: number) => row * BOARD_SIZE + col;
  const seen = new Array<boolean>(BOARD_SIZE * BOARD_SIZE).fill(false);
  const sizes: number[] = [];
  let openBoundary = 0;
  let totalBoundary = 0;

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (owners[index(row, col)] !== side || seen[index(row, col)]) continue;

      let size = 0;
      const stack = [[row, col] as [number, number]];
      seen[index(row, col)] = true;

      while (stack.length > 0) {
        const [r, c] = stack.pop()!;
        size += 1;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= BOARD_SIZE || nc >= BOARD_SIZE) {
            totalBoundary += 1; // the edge is a wall the region gets for free
            continue;
          }
          if (owners[index(nr, nc)] === side) {
            if (!seen[index(nr, nc)]) {
              seen[index(nr, nc)] = true;
              stack.push([nr, nc]);
            }
            continue;
          }
          totalBoundary += 1;
          if (board[nr][nc] === "EMPTY") openBoundary += 1;
        }
      }
      sizes.push(size);
    }
  }

  return {
    regions: sizes.length,
    largest: sizes.length === 0 ? 0 : Math.max(...sizes),
    openBoundaryShare: totalBoundary === 0 ? 0 : openBoundary / totalBoundary,
  };
}

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));
const stats: Record<"human" | "engine", { regions: number[]; largest: number[]; open: number[]; total: number[] }> = {
  human: { regions: [], largest: [], open: [], total: [] },
  engine: { regions: [], largest: [], open: [], total: [] },
};
let sampled = 0;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    if (!record.playerSide) continue; // side not recorded; a guess would swap the columns
    const human = record.playerSide;
    const engine: Player = human === "A" ? "B" : "A";
    let state: GameState = createInitialState();
    let ply = 0;

    for (const move of record.moveHistory) {
      if (state.winner) break;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      ply += 1;

      // Midgame only. Before ply 12 there is barely any influence to shape,
      // and both sides' numbers are dominated by the empty board.
      if (ply < 12) continue;
      const owners = influenceOwnerMap(state.board);
      sampled += 1;
      for (const [who, side] of [["human", human], ["engine", engine]] as const) {
        const shape = shapeOf(owners, state.board, side);
        if (shape.regions === 0) continue;
        stats[who].regions.push(shape.regions);
        stats[who].largest.push(shape.largest);
        stats[who].open.push(shape.openBoundaryShare);
        stats[who].total.push(owners.filter((owner) => owner === side).length);
      }
    }
  }
}

console.log(`${sampled} midgame positions from ${files.length} file(s), ply 12+\n`);
console.log(
  `${"".padEnd(9)}${"influence".padStart(11)}${"regions".padStart(10)}` +
    `${"largest".padStart(10)}${"largest share".padStart(15)}${"open boundary".padStart(15)}`,
);
for (const who of ["human", "engine"] as const) {
  const s = stats[who];
  const total = summarize(s.total).mean ?? 0;
  const largest = summarize(s.largest).mean ?? 0;
  console.log(
    `${who.padEnd(9)}${total.toFixed(2).padStart(11)}` +
      `${(summarize(s.regions).mean ?? 0).toFixed(2).padStart(10)}` +
      `${largest.toFixed(2).padStart(10)}` +
      `${(total === 0 ? "—" : `${((largest / total) * 100).toFixed(1)}%`).padStart(15)}` +
      `${`${((summarize(s.open).mean ?? 0) * 100).toFixed(1)}%`.padStart(15)}`,
  );
}
