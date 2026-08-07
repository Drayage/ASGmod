/**
 * Does the self-play arena play the game the engine is losing?
 *
 * Every territory candidate measured so far has come back neutral, and the
 * urgent-seal screen finally showed why it might not be the candidates' fault.
 * Probing the engine mid-arena, of 33 turns where a seal was on offer, 31 had
 * an urgency of exactly one cell and 2 had two or more: block it and the same
 * region comes in one smaller, so there is essentially nothing there with a
 * clock on it. In the recorded games against a human the same measurement
 * found 15 urgent seals in 20 games.
 *
 * That is the shape of the games differing, not the shape of the term. This
 * prints the two side by side — how they end, how long they run, and how much
 * ground is on the board when they do — so the difference is a number rather
 * than an impression.
 *
 *   npx vite-node game-shape.mts -- --arena artifacts/sealurg/merged.json
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { influenceCount } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";
import type { ArenaGameRecord } from "./arena-aggregate";

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
  /** Absent in the three held-out games, which record no side for the human. */
  playerSide?: Player;
  /** Set on the exhibition games: the side the stronger player took. */
  strongSide?: Player;
  /** What each seat was, on records that say. Both seats may be the same. */
  firstRole?: string;
  secondRole?: string;
  /** False where the source never scored the game, so its endpoint is unknown. */
  territoryVerified?: boolean;
  moveHistory: Move[];
}

const humanFiles = [
  "src/games/alley-boss-cats/testdata/humanGames.json",
  "docs/newbuild-games-32293a1.json",
  "docs/pro-games-20230822.json",
  "docs/community-games.json",
].filter((path) => existsSync(path));

/**
 * Final territory and peak influence per role, so a conversion rate can be
 * quoted for each. Roles come from the record and are never inferred.
 */
const byRole = new Map<string, { territory: number[]; peak: number[] }>();
const role = (label: string) => {
  const found = byRole.get(label);
  if (found) return found;
  const made = { territory: [] as number[], peak: [] as number[] };
  byRole.set(label, made);
  return made;
};

const humanPlies: number[] = [];
const humanTerritory: number[] = [];
const humanLosingTerritory: number[] = [];
const humanPeak: number[] = [];
const enginePeak: number[] = [];
const humanReasons: Record<string, number> = {};

for (const path of humanFiles) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    let state: GameState = createInitialState();
    let plies = 0;
    // Peak influence over the whole game, sampled exactly as the arena samples
    // it, so the conversion rates below are comparable across the two columns.
    const peak: Record<Player, number> = { A: 0, B: 0 };
    const notePeak = () => {
      const influence = influenceCount(state.board);
      peak.A = Math.max(peak.A, influence.A);
      peak.B = Math.max(peak.B, influence.B);
    };
    notePeak();
    for (const move of record.moveHistory) {
      if (state.winner) break;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      plies += 1;
      notePeak();
    }
    humanPlies.push(plies);

    // Territory standing at the position the record ends on, read off the
    // state's own territory lists — the same field the arena reports — so the
    // two columns are the same measurement and not two definitions of it.
    // Which side was the human is only recorded in some of the files, and a
    // guess would put the loser's ground in the winner's column, so the split
    // is taken only where the record actually says.
    // Roles come from the record. A game between two amateurs names no strong
    // side, and defaulting that to playerSide files a human opponent under
    // "engine".
    const labels: Record<Player, string> | null =
      record.firstRole && record.secondRole
        ? ({ A: record.firstRole, B: record.secondRole } as Record<Player, string>)
        : record.playerSide
          ? ({
              [record.playerSide]: "human",
              [record.playerSide === "A" ? "B" : "A"]: "engine",
            } as Record<Player, string>)
          : null;
    if (labels && record.territoryVerified !== false) {
      for (const side of ["A", "B"] as const) {
        const into = role(labels[side]);
        into.territory.push(state.territories[side].length);
        into.peak.push(peak[side]);
      }
    }

    if (record.playerSide && !record.firstRole) {
      const engineSide: Player = record.playerSide === "A" ? "B" : "A";
      humanTerritory.push(state.territories[record.playerSide].length);
      humanLosingTerritory.push(state.territories[engineSide].length);
      humanPeak.push(peak[record.playerSide]);
      enginePeak.push(peak[engineSide]);
    }
    const reason = state.winner ? (state.winReason ?? "UNKNOWN") : "UNFINISHED";
    humanReasons[reason] = (humanReasons[reason] ?? 0) + 1;
  }
}

const arenaPath = arg("arena", "artifacts/sealurg/merged.json")!;
const arena = existsSync(arenaPath)
  ? (JSON.parse(readFileSync(arenaPath, "utf8")).matches[0].games as ArenaGameRecord[])
  : [];

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);
const show = (label: string, values: number[]) => {
  const s = summarize(values);
  return `${label.padEnd(22)}${String(s.mean ?? "—").padStart(9)}  (n=${s.count})`;
};

console.log(`human-vs-engine games: ${humanPlies.length} from ${humanFiles.length} file(s)`);
console.log(`self-play arena games: ${arena.length} from ${arenaPath}\n`);

console.log("how the games end:");
console.log(`  human-vs-engine  ${JSON.stringify(humanReasons)}`);
if (arena.length > 0) {
  const reasons: Record<string, number> = {};
  for (const game of arena) reasons[game.winReason] = (reasons[game.winReason] ?? 0) + 1;
  console.log(`  self-play        ${JSON.stringify(reasons)}`);
  console.log(
    `  reached a count: human ${pct(
      (humanReasons.TERRITORY ?? 0) + (humanReasons.UNFINISHED ?? 0),
      humanPlies.length,
    )} / self-play ${pct(reasons.TERRITORY ?? 0, arena.length)}`,
  );
}

console.log("\nhow long they run (plies):");
console.log(`  ${show("human-vs-engine", humanPlies)}`);
if (arena.length > 0) console.log(`  ${show("self-play", arena.map((game) => game.plies))}`);

console.log("\nground on the board at the end (cells):");
console.log(`  ${show("human", humanTerritory)}`);
console.log(`  ${show("engine (vs human)", humanLosingTerritory)}`);
if (arena.length > 0) {
  console.log(`  ${show("self-play X", arena.map((game) => game.finalTerritory.X))}`);
  console.log(`  ${show("self-play Y", arena.map((game) => game.finalTerritory.Y))}`);
}

// Small areas can come from not reaching far enough, or from reaching just as
// far and closing less of it. Those want opposite fixes, so they are separated
// here rather than left to inference from the final count.
console.log("\npeak influence, and what became territory:");
const rate = (territory: number[], peak: number[]) => {
  const p = summarize(peak).mean;
  const t = summarize(territory).mean;
  return p && t !== null ? `${((t / p) * 100).toFixed(1)}%` : "—";
};
console.log(`  ${show("human peak", humanPeak)}   -> ${rate(humanTerritory, humanPeak)}`);
console.log(`  ${show("engine peak (vs human)", enginePeak)}   -> ${rate(humanLosingTerritory, enginePeak)}`);
if (arena.length > 0) {
  const xPeak = arena.map((game) => game.peakInfluence.X);
  const yPeak = arena.map((game) => game.peakInfluence.Y);
  console.log(
    `  ${show("self-play X peak", xPeak)}   -> ${rate(arena.map((game) => game.finalTerritory.X), xPeak)}`,
  );
  console.log(
    `  ${show("self-play Y peak", yPeak)}   -> ${rate(arena.map((game) => game.finalTerritory.Y), yPeak)}`,
  );
}

console.log("\nby role — final territory and what share of peak influence it was:");
for (const [label, data] of byRole) {
  const territory = summarize(data.territory);
  const peak = summarize(data.peak);
  const rate =
    peak.mean && territory.mean !== null ? `${((territory.mean / peak.mean) * 100).toFixed(1)}%` : "—";
  console.log(
    `  ${label.padEnd(9)} n=${String(territory.count).padStart(3)}  ` +
      `peak ${String(peak.mean ?? "—").padStart(9)}  ` +
      `territory ${String(territory.mean ?? "—").padStart(9)}  ` +
      `conversion ${rate.padStart(7)}`,
  );
}
