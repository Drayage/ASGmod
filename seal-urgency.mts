/**
 * Do the human and the engine treat a postponable seal differently?
 *
 * The engine's territory signal knows how much ground a move settles and not
 * whether the move needs playing now. Those come apart: a seal the opponent
 * cannot really take away — block it and the same region still comes in a cell
 * smaller — is ground already banked, and spending a turn to bank it buys a
 * cell while costing the move that could have opened somewhere else.
 *
 * That would explain a result that otherwise does not fit. Given a term valuing
 * settled ground more highly, the engine took its seals nine plies earlier and
 * finished with *less* ground: 4.69 cells against 5.47. Converting sooner is
 * not the human's advantage, so the question is whether the human is instead
 * converting more *selectively*.
 *
 * This measures it on the recorded games, before any of it is built into the
 * engine. For every turn where a seal was available it records the seal's size,
 * its urgency, and whether that side took it — separately for the human and for
 * VERY_HARD, from the same games.
 *
 *   npx vite-node seal-urgency.mts -- --games src/games/alley-boss-cats/testdata/humanGames.json
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves, sealingUrgency } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";

function arg(name: string, fallback: string | null = null): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide: Player;
  moveHistory: Move[];
}

const sources = (arg("games") ?? "")
  .split(",")
  .concat(["src/games/alley-boss-cats/testdata/humanGames.json", "docs/newbuild-games-32293a1.json"])
  .filter((path) => path && existsSync(path));
const unique = [...new Set(sources)];
if (unique.length === 0) throw new Error("no game files found");

/** Below this the seal can wait: blocking it costs the owner about nothing. */
const POSTPONABLE = Number(arg("postponable", "1"));
/** Ignore one-cell scraps; they are noise either way. */
const MIN_SIZE = Number(arg("min-size", "2"));

interface Tally {
  turnsWithSeal: number;
  tookSeal: number;
  /** Turns where the best seal available was one that could have waited. */
  postponableAvailable: number;
  tookPostponable: number;
  urgentAvailable: number;
  tookUrgent: number;
  /** Cells given up by playing elsewhere when a seal could not wait. */
  missedUrgentUrgency: number[];
  missedUrgentSize: number[];
  sizesTaken: number[];
  urgenciesTaken: number[];
}

const blank = (): Tally => ({
  turnsWithSeal: 0,
  tookSeal: 0,
  postponableAvailable: 0,
  tookPostponable: 0,
  urgentAvailable: 0,
  tookUrgent: 0,
  missedUrgentUrgency: [],
  missedUrgentSize: [],
  sizesTaken: [],
  urgenciesTaken: [],
});

const tallies: Record<"human" | "engine", Tally> = { human: blank(), engine: blank() };
let games = 0;

for (const path of unique) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    games += 1;
    const human = record.playerSide;
    let state: GameState = createInitialState();

    for (const move of record.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const who = mover === human ? "human" : "engine";
      const tally = tallies[who];

      const seals = findSealingMoves(state, mover).filter(
        (seal) => seal.gained.length >= MIN_SIZE,
      );
      if (seals.length > 0) {
        tally.turnsWithSeal += 1;
        const scored = seals.map((seal) => ({
          seal,
          urgency: sealingUrgency(state, mover, seal),
        }));
        const best = scored.reduce((a, b) =>
          b.seal.gained.length > a.seal.gained.length ? b : a,
        );
        const bestPostponable = best.urgency <= POSTPONABLE;
        if (bestPostponable) tally.postponableAvailable += 1;
        else tally.urgentAvailable += 1;

        const played = scored.find(
          (entry) =>
            move.type === "PLACE" &&
            entry.seal.move.row === move.row &&
            entry.seal.move.col === move.col,
        );
        if (played) {
          tally.tookSeal += 1;
          tally.sizesTaken.push(played.seal.gained.length);
          tally.urgenciesTaken.push(played.urgency);
          if (bestPostponable) tally.tookPostponable += 1;
          else tally.tookUrgent += 1;
        } else if (!bestPostponable) {
          // Declined a seal that the opponent could genuinely take away.
          tally.missedUrgentUrgency.push(best.urgency);
          tally.missedUrgentSize.push(best.seal.gained.length);
        }
      }

      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
  }
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

console.log(`${games} games from ${unique.length} file(s)`);
console.log(`seals of ${MIN_SIZE}+ cells; "postponable" means blocking it costs <= ${POSTPONABLE} cell\n`);

console.log(
  `${"".padEnd(10)}${"turns w/ seal".padStart(14)}${"took it".padStart(10)}` +
    `${"postponable avail".padStart(19)}${"took those".padStart(12)}` +
    `${"urgent avail".padStart(14)}${"took those".padStart(12)}`,
);
for (const who of ["human", "engine"] as const) {
  const t = tallies[who];
  console.log(
    `${who.padEnd(10)}${String(t.turnsWithSeal).padStart(14)}` +
      `${pct(t.tookSeal, t.turnsWithSeal).padStart(10)}` +
      `${String(t.postponableAvailable).padStart(19)}` +
      `${pct(t.tookPostponable, t.postponableAvailable).padStart(12)}` +
      `${String(t.urgentAvailable).padStart(14)}` +
      `${pct(t.tookUrgent, t.urgentAvailable).padStart(12)}`,
  );
}

console.log("\nurgent seals declined (the opponent could really take these away):");
for (const who of ["human", "engine"] as const) {
  const t = tallies[who];
  const urgency = summarize(t.missedUrgentUrgency);
  const size = summarize(t.missedUrgentSize);
  const total = t.missedUrgentUrgency.reduce((sum, value) => sum + value, 0);
  console.log(
    `  ${who.padEnd(8)} n=${String(t.missedUrgentUrgency.length).padStart(3)}  ` +
      `mean urgency ${String(urgency.mean ?? "—").padStart(7)} cells  ` +
      `mean size ${String(size.mean ?? "—").padStart(7)}  ` +
      `total cells given up ${total}`,
  );
}

console.log("\nwhen they did take a seal:");
for (const who of ["human", "engine"] as const) {
  const t = tallies[who];
  const size = summarize(t.sizesTaken);
  const urgency = summarize(t.urgenciesTaken);
  console.log(
    `  ${who.padEnd(8)} n=${String(t.sizesTaken.length).padStart(4)}  ` +
      `size ${String(size.mean ?? "—").padStart(8)}  urgency ${String(urgency.mean ?? "—").padStart(8)}`,
  );
}
