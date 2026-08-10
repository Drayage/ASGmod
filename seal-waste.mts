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
 * So this asks, for every seal each side actually played: could the opponent
 * have lived in that pocket at all? A seal of ground the opponent could never
 * have taken is a move spent on bookkeeping.
 *
 * The first version of this asked whether the opponent could legally play in the
 * pocket and got 100% for both sides, which is true and useless — anyone may
 * play into a pocket, they simply die there. So the test is a capture read: let
 * the opponent in at each entry point in turn, and ask whether the mover can
 * force the capture. A pocket where every entry is refutable was never in doubt.
 *
 *   npx vite-node seal-waste.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);
const READ_DEPTH = Number(process.env.READ_DEPTH ?? 7);
const READ_MS = Number(process.env.READ_MS ?? 200);

interface Side {
  seals: number; cells: number; reachable: number; safe: number; safeCells: number;
  /** The same split for the seals each side turned down. Taking a safe seal
   * wastes a move; turning down a contested one loses the ground. Which mistake
   * each side makes is the thing worth knowing. */
  declined: number; declinedSafe: number; declinedContestedCells: number;
}
const blank = (): Side => ({
  seals: 0, cells: 0, reachable: 0, safe: 0, safeCells: 0,
  declined: 0, declinedSafe: 0, declinedContestedCells: 0,
});
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
      if (seals.length === 0) continue;
      const taken = seals.find((s) => s.move.row === m.row && s.move.col === m.col);
      // Whether taken or declined, the pocket examined is the same one: the
      // biggest on offer, so the two arms are asking about comparable ground.
      const subject = taken ?? seals[0];
      const side = sides[mover === humanSide ? "human" : "ai"];
      if (taken) {
        side.seals += 1;
        side.cells += taken.gained.length;
      } else {
        side.declined += 1;
      }

      // Let the opponent in at each entry in turn and read whether the mover can
      // force the capture. An entry the mover cannot refute means the ground was
      // genuinely at stake and the seal bought something.
      const enemy = opponent(mover);
      const enemyToMove: GameState = { ...before, currentPlayer: enemy };
      let survivable = false;
      for (const c of subject.gained as Coord[]) {
        if (!isLegalMove(before, c.row, c.col, enemy)) continue;
        const invaded = applyAction(enemyToMove, { type: "PLACE", row: c.row, col: c.col });
        if (invaded.winner) { survivable = true; break; }
        if (findForcedCapture(invaded, mover, READ_DEPTH, READ_MS) === null) {
          survivable = true;
          break;
        }
      }
      if (taken) {
        if (!survivable) { side.safe += 1; side.safeCells += subject.gained.length; }
        else side.reachable += 1;
      } else if (!survivable) {
        side.declinedSafe += 1;
      } else {
        side.declinedContestedCells += subject.gained.length;
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
    `${"opponent could live".padStart(21)}${"could not".padStart(14)}${"cells banked for free".padStart(23)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.seals).padStart(8)}${String(s.cells).padStart(8)}` +
      `${`${s.reachable} (${pct(s.reachable, s.seals)})`.padStart(22)}` +
      `${`${s.safe} (${pct(s.safe, s.seals)})`.padStart(12)}` +
      `${String(s.safeCells).padStart(23)}`,
  );
}

console.log(`\nthe seals each side turned down — turning down a safe one costs nothing`);
console.log(
  `${"side".padEnd(8)}${"declined".padStart(10)}${"was safe".padStart(16)}` +
    `${"was contested".padStart(18)}${"cells at stake".padStart(16)}`,
);
for (const [name, s] of Object.entries(sides)) {
  const contested = s.declined - s.declinedSafe;
  console.log(
    `${name.padEnd(8)}${String(s.declined).padStart(10)}` +
      `${`${s.declinedSafe} (${pct(s.declinedSafe, s.declined)})`.padStart(16)}` +
      `${`${contested} (${pct(contested, s.declined)})`.padStart(18)}` +
      `${String(s.declinedContestedCells).padStart(16)}`,
  );
}
