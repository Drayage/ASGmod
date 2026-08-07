/**
 * Why the frame term did nothing.
 *
 * `frameRate` in one-point.mts showed the same move chosen at weight 0, 14 and
 * 30 on all but one of 589 recorded engine turns. Two explanations fit that:
 * the shape it pays for genuinely does not help, or the term is near-constant
 * across the moves on offer and so never changes an argmax. This separates them
 * by asking what `framePotential` actually reports.
 *
 *   npx vite-node frame-probe.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import {
  framePotential,
  findSealingMoves,
} from "./src/games/alley-boss-cats/engine/territoryPlanner";
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

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));

let turns = 0;
/** Turns where every legal move scored the same — the term cannot pick. */
let flat = 0;
let bestZero = 0;
let spreadTotal = 0;
const valueHistogram = new Map<number, number>();

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    let state: GameState = createInitialState();
    for (const move of record.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });

      const { pool } = getSafeActions(before, mover);
      if (pool.length < 2) continue;
      turns += 1;

      const here = framePotential(before.board, mover);
      valueHistogram.set(here, (valueHistogram.get(here) ?? 0) + 1);

      let low = Infinity;
      let high = -Infinity;
      for (const action of pool) {
        const after = framePotential(applyAction(before, action).board, mover);
        low = Math.min(low, after);
        high = Math.max(high, after);
      }
      spreadTotal += high - low;
      if (high === low) flat += 1;
      if (high === 0) bestZero += 1;
    }
  }
}

/**
 * The follow-up question. A spread across the pool is not yet an effect: the
 * term only matters if it moves the argmax, and the seal measurement can only
 * be read once that is known. Same positions, same pool, only the weight
 * differing — so any change of move is the term and nothing else.
 */
function argmaxChanges(weight: number): { turns: number; changed: number } {
  let seen = 0;
  let changed = 0;
  for (const path of files) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
    for (const record of parsed.records) {
      let state: GameState = createInitialState();
      for (const move of record.moveHistory) {
        if (state.winner) break;
        const mover = state.currentPlayer;
        const before = state;
        state =
          move.type === "PASS"
            ? applyAction(state, { type: "PASS" })
            : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });

        const { pool } = getSafeActions(before, mover);
        if (pool.length < 2) continue;
        const pick = (w: number): string => {
          tuning.frameWeight = w;
          let best = pool[0];
          let bestScore = -Infinity;
          for (const action of pool) {
            const score = evaluateState(applyAction(before, action), mover);
            if (score > bestScore) {
              bestScore = score;
              best = action;
            }
          }
          return best.type === "PASS" ? "PASS" : `${best.row},${best.col}`;
        };
        seen += 1;
        if (pick(0) !== pick(weight)) changed += 1;
      }
    }
  }
  tuning.frameWeight = 0;
  return { turns: seen, changed };
}

const pct = (part: number) => `${((part / turns) * 100).toFixed(1)}%`;
console.log(`turns examined: ${turns}\n`);
console.log(`no move changes the term at all:      ${flat} (${pct(flat)})`);
console.log(`the best move still scores zero:      ${bestZero} (${pct(bestZero)})`);
console.log(`mean spread across the move pool:     ${(spreadTotal / turns).toFixed(2)} points`);
console.log(`\nframePotential of the position itself:`);
for (const value of [...valueHistogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(value).padStart(3)}: ${String(valueHistogram.get(value)).padStart(5)}`);
}

/**
 * The baseline `frameRate` should have been measured against, and was not.
 *
 * The 24-27% figure quoted for humans counts turns where a 2+ seal was on offer
 * *before* the move. `frameRate` asks whether one is on offer *after* the move
 * it picked. Those are different questions, and the gap between 5.9% and 24%
 * is partly just the difference between them. This asks the recorded games the
 * after-the-move question, for every side, so there is something honest to
 * compare against.
 */
const afterMove = new Map<string, { turns: number; withSeal: number }>();
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
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });

      const label = labels[mover];
      const seen = afterMove.get(label) ?? { turns: 0, withSeal: 0 };
      seen.turns += 1;
      if (findSealingMoves(state, mover).some((seal) => seal.gained.length >= 2)) {
        seen.withSeal += 1;
      }
      afterMove.set(label, seen);
    }
  }
}
console.log(`\nafter the recorded move, does the mover have a 2+ seal on offer?`);
for (const [label, seen] of afterMove) {
  console.log(
    `  ${label.padEnd(10)} ${((seen.withSeal / seen.turns) * 100).toFixed(1)}%` +
      ` (${seen.withSeal}/${seen.turns})`,
  );
}

console.log(`\ndoes the term move the chosen move? (depth-1 argmax, same positions)`);
for (const weight of [14, 30, 60]) {
  const { turns: seen, changed } = argmaxChanges(weight);
  console.log(
    `  weight ${String(weight).padStart(2)} vs 0: ${changed}/${seen} moves differ` +
      ` (${((changed / seen) * 100).toFixed(1)}%)`,
  );
}
