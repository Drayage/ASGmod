/**
 * Does the closability term actually break up the blob?
 *
 * The term measured zero in the arena, but the arena turned out to be playing
 * a regime where the defect is largely absent — the engine converts 22% of its
 * influence against itself and 10% against a person. So the arena result is
 * not evidence the term does nothing; it is evidence it does nothing where
 * there was little to do.
 *
 * Before asking anyone to spend an evening playing a test build, this checks
 * the mechanism instead of the outcome. The engine holds 82% of its influence
 * in one region averaging 21.5 cells where humans hold about half of theirs in
 * regions of eight. If the term is right about anything, turning it on should
 * move those numbers. If it does not, there is nothing to test.
 *
 * Positions come from the recorded games, and only from turns the engine would
 * actually have been choosing on. The move is picked by static evaluation over
 * the safe pool rather than by the full search — a proxy, and stated as one,
 * but the same proxy for both settings, so the comparison is fair even where
 * the absolute numbers are not the engine's final word.
 *
 *   npx vite-node close-effect.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions, tuning } from "./src/games/alley-boss-cats/ai";
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

/** Connected regions of one side's influence: how many, and how big the biggest. */
function regions(state: GameState, side: Player): { count: number; largest: number; total: number } {
  const owners = influenceOwnerMap(state.board);
  const at = (row: number, col: number) => row * BOARD_SIZE + col;
  const seen = new Array<boolean>(BOARD_SIZE * BOARD_SIZE).fill(false);
  const sizes: number[] = [];
  let total = 0;

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (owners[at(row, col)] !== side) continue;
      total += 1;
      if (seen[at(row, col)]) continue;
      let size = 0;
      const stack: Array<[number, number]> = [[row, col]];
      seen[at(row, col)] = true;
      while (stack.length > 0) {
        const [r, c] = stack.pop()!;
        size += 1;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= BOARD_SIZE || nc >= BOARD_SIZE) continue;
          if (owners[at(nr, nc)] !== side || seen[at(nr, nc)]) continue;
          seen[at(nr, nc)] = true;
          stack.push([nr, nc]);
        }
      }
      sizes.push(size);
    }
  }
  return { count: sizes.length, largest: sizes.length === 0 ? 0 : Math.max(...sizes), total };
}

// Only games this engine actually played, and only its own turns. The pro and
// community records are human against human, so a "mover" there is a person
// and their shape says nothing about the engine.
const files = ["src/games/alley-boss-cats/testdata/humanGames.json"].filter((path) =>
  existsSync(path),
);
const results: Record<string, { count: number[]; largest: number[]; share: number[] }> = {
  "played (full search)": { count: [], largest: [], share: [] },
  "eval only, shipped": { count: [], largest: [], share: [] },
  "eval only, decay 0.6": { count: [], largest: [], share: [] },
  "eval only, connection 0": { count: [], largest: [], share: [] },
  "eval only, both": { count: [], largest: [], share: [] },
};
let positions = 0;
let differentMove = 0;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    records: Array<{ playerSide: Player; moveHistory: Move[] }>;
  };
  for (const record of parsed.records) {
    const engineSide: Player = record.playerSide === "A" ? "B" : "A";
    let state: GameState = createInitialState();
    let ply = 0;

    for (const move of record.moveHistory) {
      const player = state.currentPlayer;
      const before = state;
      if (state.winner) break;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      ply += 1;
      if (ply < 12 || player !== engineSide || move.type !== "PLACE") continue;

      const { pool } = getSafeActions(before, player);
      if (pool.length < 2) continue;
      positions += 1;

      // What the engine actually did, with its full search behind it.
      const playedShape = regions(state, player);
      results["played (full search)"].count.push(playedShape.count);
      results["played (full search)"].largest.push(playedShape.largest);
      if (playedShape.total > 0) {
        results["played (full search)"].share.push((playedShape.largest / playedShape.total) * 100);
      }

      const chosen: Record<string, GameState> = {};
      for (const [label, decay, connection] of [
        ["eval only, shipped", 1, 1],
        ["eval only, decay 0.6", 0.6, 1],
        ["eval only, connection 0", 1, 0],
        ["eval only, both", 0.6, 0],
      ] as const) {
        tuning.closabilityDecay = decay;
        tuning.connectionWeight = connection;
        let best = pool[0];
        let bestScore = -Infinity;
        for (const action of pool) {
          const score = evaluateState(applyAction(before, action), player);
          if (score > bestScore) {
            bestScore = score;
            best = action;
          }
        }
        chosen[label] = applyAction(before, best);
        const shape = regions(chosen[label], player);
        results[label].count.push(shape.count);
        results[label].largest.push(shape.largest);
        if (shape.total > 0) results[label].share.push((shape.largest / shape.total) * 100);
      }
      if (JSON.stringify(chosen["eval only, shipped"].board) !== JSON.stringify(chosen["eval only, both"].board)) {
        differentMove += 1;
      }
    }
  }
}
tuning.closabilityDecay = 1;
tuning.connectionWeight = 1;

console.log(`${positions} engine turns from ${files.length} file(s), ply 12+`);
console.log(`shipped and "both" pick a different move on ${((differentMove / positions) * 100).toFixed(1)}%\n`);
console.log("shape of the mover's influence after the move it picks:");
console.log(`${"".padEnd(26)}${"regions".padStart(10)}${"largest".padStart(10)}${"largest share".padStart(16)}`);
for (const [label, data] of Object.entries(results)) {
  console.log(
    `${label.padEnd(26)}${(summarize(data.count).mean ?? 0).toFixed(2).padStart(10)}` +
      `${(summarize(data.largest).mean ?? 0).toFixed(2).padStart(10)}` +
      `${`${(summarize(data.share).mean ?? 0).toFixed(1)}%`.padStart(16)}`,
  );
}
console.log("\nfor reference, measured over the same recorded games:");
console.log("  engine in real play   3.74 regions, largest 21.53, share 81.8%");
console.log("  humans                5.6-6.3 regions, largest ~8.4, share ~50%");
