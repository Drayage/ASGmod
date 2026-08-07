/**
 * Does either side take a one-point eye when it is there for the taking?
 *
 * `findSealingMoves` already returns every move that settles at least one
 * cell, single points included, so the engine is not blind to them. And in
 * this game a single point is not a scrap: confirmed territory is unplayable
 * by either side, so one point of it is life for the group beside it as well
 * as a point on the board.
 *
 * An earlier measurement of sealing behaviour set `MIN_SIZE = 2` and called
 * one-cell seals noise. That threw away exactly the case that matters here, so
 * this counts them on their own — how often a one-point seal was available,
 * and how often each side played it.
 *
 *   npx vite-node one-point.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { evaluateState, getSafeActions, tuning, type AIAction } from "./src/games/alley-boss-cats/ai";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  firstRole?: string;
  secondRole?: string;
  moveHistory: Move[];
}

interface Tally {
  turns: number;
  /** Turns where a seal of exactly one cell was on offer. */
  onePointAvailable: number;
  onePointTaken: number;
  /** Turns where a bigger seal was on offer. */
  biggerAvailable: number;
  biggerTaken: number;
}
const blank = (): Tally => ({
  turns: 0,
  onePointAvailable: 0,
  onePointTaken: 0,
  biggerAvailable: 0,
  biggerTaken: 0,
});
const tallies = new Map<string, Tally>();
const bucket = (label: string) => {
  const found = tallies.get(label);
  if (found) return found;
  const made = blank();
  tallies.set(label, made);
  return made;
};

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    const labels: Record<Player, string> | null =
      record.firstRole && record.secondRole
        ? ({ A: record.firstRole, B: record.secondRole } as Record<Player, string>)
        : record.playerSide
          ? ({
              [record.playerSide]: "human",
              [record.playerSide === "A" ? "B" : "A"]: "engine",
            } as Record<Player, string>)
          : null;
    if (!labels) continue;

    let state: GameState = createInitialState();
    for (const move of record.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const tally = bucket(labels[mover]);
      tally.turns += 1;

      const seals = findSealingMoves(state, mover);
      const single = seals.filter((seal) => seal.gained.length === 1);
      const bigger = seals.filter((seal) => seal.gained.length > 1);
      const played = (list: typeof seals) =>
        move.type === "PLACE" &&
        list.some((seal) => seal.move.row === move.row && seal.move.col === move.col);

      if (single.length > 0) {
        tally.onePointAvailable += 1;
        if (played(single)) tally.onePointTaken += 1;
      }
      if (bigger.length > 0) {
        tally.biggerAvailable += 1;
        if (played(bigger)) tally.biggerTaken += 1;
      }

      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
  }
}

/**
 * The same question asked of the engine's own choices rather than the record:
 * from each engine turn, pick a move by static evaluation and see how often
 * the *next* position offers a seal of two cells or more. Both settings of
 * `frameWeight`, same positions, so the comparison is the term and nothing
 * else. A depth-one proxy for the search, and stated as one.
 */
function frameRate(weight: number): { turns: number; withSeal: number } {
  let turns = 0;
  let withSeal = 0;
  for (const path of files) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
    for (const record of parsed.records) {
      if (!record.playerSide) continue;
      const engineSide: Player = record.playerSide === "A" ? "B" : "A";
      let state: GameState = createInitialState();
      for (const move of record.moveHistory) {
        if (state.winner) break;
        const mover = state.currentPlayer;
        const before = state;
        state =
          move.type === "PASS"
            ? applyAction(state, { type: "PASS" })
            : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
        if (mover !== engineSide) continue;
        const { pool } = getSafeActions(before, mover);
        if (pool.length < 2) continue;
        tuning.frameWeight = weight;
        let best: AIAction = pool[0];
        let bestScore = -Infinity;
        for (const action of pool) {
          const score = evaluateState(applyAction(before, action), mover);
          if (score > bestScore) {
            bestScore = score;
            best = action;
          }
        }
        const after = applyAction(before, best);
        turns += 1;
        if (findSealingMoves(after, mover).some((seal) => seal.gained.length >= 2)) withSeal += 1;
      }
    }
  }
  tuning.frameWeight = 14;
  return { turns, withSeal };
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);
console.log(`recorded games from ${files.length} file(s)\n`);
console.log(
  `${"".padEnd(10)}${"turns".padStart(8)}${"1-pt available".padStart(16)}${"took it".padStart(10)}` +
    `${"2+ available".padStart(14)}${"took it".padStart(10)}`,
);
for (const [label, t] of tallies) {
  console.log(
    `${label.padEnd(10)}${String(t.turns).padStart(8)}` +
      `${String(t.onePointAvailable).padStart(16)}` +
      `${pct(t.onePointTaken, t.onePointAvailable).padStart(10)}` +
      `${String(t.biggerAvailable).padStart(14)}` +
      `${pct(t.biggerTaken, t.biggerAvailable).padStart(10)}`,
  );
}

console.log("\nafter the engine's own move, is a 2+ seal on offer? (depth-1 proxy)");
for (const weight of [0, 14, 30, 60]) {
  const { turns, withSeal } = frameRate(weight);
  console.log(`  frameWeight ${String(weight).padStart(2)}:  ${pct(withSeal, turns)}  (${withSeal}/${turns})`);
}
console.log("  the engine's real moves, same question: 11.4%; humans 26-29%");
console.log("  (the proxy scores below the engine it stands in for — it reads one");
console.log("   ply where the engine reads seven. Weights compare to each other.)");
