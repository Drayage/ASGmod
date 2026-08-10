/**
 * A move that dies scores nothing — so what does the evaluation think a doomed
 * group is worth?
 *
 * `influenceOwnerMap` fills the board from every stone standing on it. Nothing
 * in that fill asks whether the stone's group can live. A group the opponent can
 * capture by force still projects influence over the empty ground beside it, and
 * `projectedMarginFrom` prices that ground at 0.12 a cell and hands the total to
 * the search as territory it is on course to own.
 *
 * This walks the recorded positions, asks the capture search which groups are
 * already lost, and re-prices each position with those stones taken off. The gap
 * is what the engine is paying itself for stones that are not going to be there.
 *
 *   npx vite-node dead-influence.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import {
  influenceCountFromMap,
  influenceOwnerMap,
} from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { getAllGroups } from "./src/games/alley-boss-cats/groups";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

/** The rate `projectedMarginFrom` prices open ground at, mirrored from ai.ts. */
const INFLUENCE_TO_TERRITORY = 0.12;

const STRIDE = Number(process.env.STRIDE ?? 2);
const DEPTH = Number(process.env.DEPTH ?? 7);
const BUDGET = Number(process.env.BUDGET ?? 400);

const settledKeys = (state: GameState) => {
  const keys = new Set<string>();
  for (const side of ["A", "B"] as Player[]) {
    for (const c of state.territories[side]) keys.add(`${c.row},${c.col}`);
  }
  return keys;
};

/** The engine's own projected margin for `side`, from a board and its settled set. */
function projected(board: Board, state: GameState, side: Player): number {
  const owners = influenceOwnerMap(board, settledKeys(state));
  const open = influenceCountFromMap(owners);
  const other = opponent(side);
  return (
    state.territories[side].length -
    state.territories[other].length +
    (open[side] - open[other]) * INFLUENCE_TO_TERRITORY
  );
}

interface Row { doomed: number; overpay: number; margin: number }
const rows: Record<string, Row[]> = { human: [], ai: [] };
let positions = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      ply += 1;
      if (ply % STRIDE !== 0) continue;
      if (state.winner) break;

      for (const [name, side] of [["human", human], ["ai", engine]] as Array<[string, Player]>) {
        // Groups of `side` that the other player, to move, can capture by force.
        const attacker = opponent(side);
        const probe: GameState = { ...state, currentPlayer: attacker };
        const doomed: Array<{ row: number; col: number }> = [];
        for (const group of getAllGroups(state.board, side)) {
          const only: Board = state.board.map((r) => [...r]);
          for (const other of getAllGroups(state.board, side)) {
            if (other === group) continue;
            for (const c of other) only[c.row][c.col] = "EMPTY";
          }
          const kill = findForcedCapture({ ...probe, board: only }, attacker, DEPTH, BUDGET);
          if (kill !== null) doomed.push(...group);
        }

        const before = projected(state.board, state, side);
        if (doomed.length === 0) {
          rows[name].push({ doomed: 0, overpay: 0, margin: before });
          continue;
        }
        const without: Board = state.board.map((r) => [...r]);
        for (const c of doomed) without[c.row][c.col] = "EMPTY";
        const after = projected(without, { ...state, territories: calculateTerritories(without) }, side);
        rows[name].push({ doomed: doomed.length, overpay: before - after, margin: before });
      }
      positions += 1;
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = (xs: number[]) => {
  if (xs.length < 2) return "-";
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return `${m.toFixed(2)} +/- ${((1.96 * sd) / Math.sqrt(xs.length)).toFixed(2)}`;
};

console.log(`what the evaluation pays itself for stones that are already lost`);
console.log(`${positions} positions, every ${STRIDE} plies, capture read ${DEPTH} deep\n`);
console.log(
  `${"side".padEnd(8)}${"positions".padStart(11)}${"with a doomed group".padStart(21)}` +
    `${"doomed stones".padStart(15)}${"overpaid margin".padStart(18)}`,
);
for (const [name, xs] of Object.entries(rows)) {
  const hit = xs.filter((r) => r.doomed > 0);
  console.log(
    `${name.padEnd(8)}${String(xs.length).padStart(11)}` +
      `${`${hit.length} (${Math.round((100 * hit.length) / xs.length)}%)`.padStart(21)}` +
      `${(hit.length ? mean(hit.map((r) => r.doomed)).toFixed(2) : "-").padStart(15)}` +
      `${ci(hit.map((r) => r.overpay)).padStart(18)}`,
  );
}
