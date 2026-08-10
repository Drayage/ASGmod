/**
 * Does a loose extension actually cost the seal supply later?
 *
 * The engine plays at distance two or three from its nearest own stone on 21% of
 * middle-game moves and the human on 5%, at the same settled score, z = 3.5. The
 * story attached to that — a wall grown attached ends with one hole, a wall
 * grown loose ends with several and no single move closes it — is a story until
 * it is measured.
 *
 * So: for every move, record whether it was loose, and then look at the mover's
 * largest available seal four of their own turns later. Compared inside strata
 * of turn band and of what the mover already had, and computed separately for
 * each player, so neither the phase of the game nor the identity of the player
 * can produce the difference on its own.
 *
 * What this cannot settle: the arrow. Playing loose may be what you do when you
 * have no shape worth attaching to, in which case both are effects of something
 * earlier. The within-player, within-stratum comparison narrows that; it does
 * not close it.
 *
 * The same test also runs on a second exposure. At a level score the engine
 * plays within one step of an enemy stone on 75% of its middle-game moves and
 * the human on 53% (z = 3.3), which `localMoveScore` would explain: it pays +6
 * for every enemy stone a move touches and +130 or +900 for threatening one.
 * Hugging the opponent builds nothing to enclose.
 *
 *   EXPOSURE=own|enemy LATER=4 npx vite-node loose-effect.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const LATER = Number(process.env.LATER ?? 4);
const FROM_TURN = Number(process.env.FROM_TURN ?? 11);
const TO_TURN = Number(process.env.TO_TURN ?? 40);
/** "own" splits on distance from the mover's own stones, "enemy" on distance
 * from the opponent's. */
const EXPOSURE = process.env.EXPOSURE ?? "own";

const largestSeal = (state: GameState, side: Player) =>
  findSealingMoves(state, side).reduce((n, s) => Math.max(n, s.gained.length), 0);

interface Row { loose: boolean; had: number; later: number; band: number; side: string }
const rows: Row[] = [];

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const human: Player = rec.playerSide;

    // Replay once, keeping states, so "four of my own turns later" is a lookup.
    const states: GameState[] = [createInitialState()];
    for (const m of rec.moveHistory) {
      const cur = states[states.length - 1];
      if (cur.winner) break;
      states.push(
        m.type === "PASS"
          ? applyAction(cur, { type: "PASS" })
          : applyAction(cur, { type: "PLACE", row: m.row!, col: m.col! }),
      );
    }

    for (let i = 0; i < states.length - 1; i += 1) {
      const turn = i + 1;
      if (turn < FROM_TURN || turn > TO_TURN) continue;
      const m = rec.moveHistory[i];
      if (!m || m.type !== "PLACE") continue;
      const before = states[i];
      const mover = before.currentPlayer;
      const laterIndex = i + 2 * LATER;
      if (laterIndex >= states.length) continue;
      const laterState = states[laterIndex];
      if (laterState.currentPlayer !== mover) continue;

      const own = playerCell(mover);
      let nearest = Infinity;
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          if (before.board[row][col] !== own) continue;
          nearest = Math.min(nearest, Math.max(Math.abs(row - m.row), Math.abs(col - m.col)));
        }
      }
      if (!Number.isFinite(nearest) || nearest >= 4) continue; // the far jump is its own thing

      const foe = playerCell(opponent(mover));
      let nearestFoe = Infinity;
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          if (before.board[row][col] !== foe) continue;
          nearestFoe = Math.min(nearestFoe, Math.max(Math.abs(row - m.row), Math.abs(col - m.col)));
        }
      }
      if (EXPOSURE === "enemy" && !Number.isFinite(nearestFoe)) continue;

      rows.push({
        // "loose" is the exposure being tested: away from my own stones, or —
        // the opposite sense — right up against the opponent's.
        loose: EXPOSURE === "enemy" ? nearestFoe <= 1 : nearest >= 2,
        had: largestSeal(before, mover),
        later: largestSeal(laterState, mover),
        band: turn < 21 ? 0 : turn < 31 ? 1 : 2,
        side: mover === human ? "human" : "ai",
      });
    }
  }
}

void opponent;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const bandName = ["11-20", "21-30", "31-40"];
console.log(
  `largest seal available ${LATER} of the mover's own turns later, ${games} games\n` +
    `strata: player, turn band, and what the mover already had on the table\n`,
);
console.log(
  `${"side".padEnd(7)}${"turns".padEnd(8)}${"had".padEnd(6)}` +
    `${(EXPOSURE === "enemy" ? "away from foe" : "attached").padStart(15)}` +
    `${(EXPOSURE === "enemy" ? "next to foe" : "loose (2-3)").padStart(15)}${"difference".padStart(18)}`,
);
for (const side of ["human", "ai"]) {
  for (let band = 0; band < 3; band += 1) {
    for (const had of [0, 1]) {
      const pick = (loose: boolean) =>
        rows
          .filter((r) => r.side === side && r.band === band && (had === 0 ? r.had === 0 : r.had > 0) && r.loose === loose)
          .map((r) => r.later);
      const a = pick(false);
      const b = pick(true);
      if (a.length < 5 || b.length < 5) continue;
      const d = mean(b) - mean(a);
      const ci = 1.96 * Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
      console.log(
        `${side.padEnd(7)}${bandName[band].padEnd(8)}${(had === 0 ? "none" : "some").padEnd(6)}` +
          `${`${mean(a).toFixed(2)} (${a.length})`.padStart(15)}${`${mean(b).toFixed(2)} (${b.length})`.padStart(15)}` +
          `${`${d >= 0 ? "+" : ""}${d.toFixed(2)} +/- ${ci.toFixed(2)}`.padStart(18)}`,
      );
    }
  }
}
const all = (side: string, loose: boolean) =>
  rows.filter((r) => r.side === side && r.loose === loose).map((r) => r.later);
console.log(`\npooled, ignoring strata:`);
for (const side of ["human", "ai"]) {
  const a = all(side, false);
  const b = all(side, true);
  const d = mean(b) - mean(a);
  const ci = 1.96 * Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  console.log(
    `  ${side.padEnd(7)}${EXPOSURE === "enemy" ? "away" : "attached"} ${mean(a).toFixed(2)} (${a.length})   ` +
      `${EXPOSURE === "enemy" ? "contact" : "loose"} ${mean(b).toFixed(2)} (${b.length})   ` +
      `${d >= 0 ? "+" : ""}${d.toFixed(2)} +/- ${ci.toFixed(2)}`,
  );
}
