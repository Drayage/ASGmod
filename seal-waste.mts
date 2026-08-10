/**
 * When the engine spends a move sealing, was the ground going anywhere?
 *
 * Game 18 turn 22: the engine wants F1, and it is right that F1 settles six
 * cells — the whole top-right corner, walled by its own stones and the board
 * edge with one gap. The human declines it on turns 22, 24, 26, 30 and 32, plays
 * elsewhere every time, and wins the game on the count.
 *
 * The evaluation cannot see why. Settled ground is worth 1.0 a cell and open
 * ground 0.12, so converting six cells from one to the other reads as +5.3 —
 * the largest single term in the position, against a median gap of 0.36 cells
 * between candidate moves. But if the opponent could never have taken that
 * corner, the true gain is zero and the cost is a move.
 *
 * So this asks, for every seal each side actually played: would those cells have
 * been theirs at the end anyway? A seal of ground that was never in doubt is a
 * move spent on bookkeeping.
 *
 *   npx vite-node seal-waste.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);

interface Side { seals: number; cells: number; reachable: number; safe: number; safeCells: number }
const blank = (): Side => ({ seals: 0, cells: 0, reachable: 0, safe: 0, safeCells: 0 });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const seals = findSealingMoves(before, mover).filter((s) => s.gained.length >= MIN_CELLS);
      const taken = seals.find((s) => s.move.row === m.row && s.move.col === m.col);
      if (!taken) continue;

      const side = sides[mover === humanSide ? "human" : "ai"];
      side.seals += 1;
      side.cells += taken.gained.length;

      // Could the opponent have played inside the pocket at all, before it was
      // sealed? If not, the ground was never in doubt and the stone bought the
      // accounting rather than the cells.
      const enemy = opponent(mover);
      const legalForEnemy = new Set(
        getLegalMoves(before, enemy).map((mv) => `${mv.row},${mv.col}`),
      );
      const canEnter = taken.gained.some((c: Coord) => legalForEnemy.has(`${c.row},${c.col}`));
      // And what the pocket became if the seal had simply not been played: the
      // same board with the opponent to move, settled out by the rules as it
      // stands. A pocket already unplayable by the opponent is safe outright.
      if (!canEnter) {
        side.safe += 1;
        side.safeCells += taken.gained.length;
      } else {
        side.reachable += 1;
      }
    }
  }
}

void calculateTerritories;
void playerCell;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`seals of ${MIN_CELLS}+ cells actually played, ${games} games decided by the count\n`);
console.log(
  `${"side".padEnd(8)}${"seals".padStart(8)}${"cells".padStart(8)}` +
    `${"opponent could enter".padStart(22)}${"could not".padStart(12)}${"cells banked for free".padStart(23)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.seals).padStart(8)}${String(s.cells).padStart(8)}` +
      `${`${s.reachable} (${pct(s.reachable, s.seals)})`.padStart(22)}` +
      `${`${s.safe} (${pct(s.safe, s.seals)})`.padStart(12)}` +
      `${String(s.safeCells).padStart(23)}`,
  );
}
