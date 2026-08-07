/**
 * Can the engine count territory, or only fail to build it?
 *
 * Everything measured so far has been about what the engine *plays*. This asks
 * the prior question: from a midgame position, does its territory number tell
 * it who is going to win and by how much? A player who cannot count cannot
 * choose, and every territory knob tried so far has been a knob feeding a
 * number that may itself be wrong.
 *
 * Ground truth is the recorded final count, so only games that were actually
 * counted are used — resignations have no territory result to be right about.
 *
 * Three estimators over the same positions:
 *   confirmed  settled territory only, the part the rules compute exactly
 *   engine     what the evaluation actually uses (confirmed + influence)
 *   oracle     the true final margin, for reference
 *
 * If `engine` beats `confirmed`, influence is earning its place. If it loses to
 * it, the engine's territory sense is worse than counting nothing at all, and
 * every knob downstream of it was built on sand.
 *
 *   npx vite-node can-it-count.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction, projectedMargin } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { FIRST_PLAYER_MARGIN } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  id?: string;
  set?: string;
  territoryA?: number;
  territoryB?: number;
  territoryVerified?: boolean;
  endReason?: string;
  moveHistory: Move[];
}

/** One position: what each estimator said, and what actually happened. */
interface Sample {
  /** How far through the game, 0 to 1 — a guess at move 4 is not a guess at 40. */
  progress: number;
  confirmed: number;
  engine: number;
  truth: number;
}

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));
const samples: Sample[] = [];
let games = 0;
let skipped = 0;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    // Only games with a real count at the end. A resignation records whatever
    // was on the board when someone gave up, which is not the answer to
    // "who would have had more".
    if (record.endReason !== "COUNTED") {
      skipped += 1;
      continue;
    }
    if (record.territoryA === undefined || record.territoryB === undefined) {
      skipped += 1;
      continue;
    }
    // Stated from A's side throughout, margin included, so every number below
    // is the same quantity and they can be subtracted from each other.
    const truth = record.territoryA - record.territoryB - FIRST_PLAYER_MARGIN;
    games += 1;

    let state: GameState = createInitialState();
    const total = record.moveHistory.length;
    for (let ply = 0; ply < total; ply += 1) {
      const move = record.moveHistory[ply];
      if (state.winner) break;

      samples.push({
        progress: ply / total,
        confirmed:
          state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN,
        engine: projectedMargin(state, "A"),
        truth,
      });

      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
  }
}

/** Mean absolute error, and how often the sign is right — who is ahead at all. */
function score(pick: (s: Sample) => number, from: Sample[]) {
  let error = 0;
  let signRight = 0;
  let decided = 0;
  for (const sample of from) {
    error += Math.abs(pick(sample) - sample.truth);
    // A truth of exactly zero has no side to get right; leave it out rather
    // than let a coin flip count as skill.
    if (sample.truth !== 0) {
      decided += 1;
      if (Math.sign(pick(sample)) === Math.sign(sample.truth)) signRight += 1;
    }
  }
  return {
    mae: error / from.length,
    sign: decided === 0 ? 0 : signRight / decided,
  };
}

const band = (lo: number, hi: number) =>
  samples.filter((s) => s.progress >= lo && s.progress < hi);

console.log(`counted games: ${games}   (skipped ${skipped} without a real count)`);
console.log(`positions: ${samples.length}\n`);

/**
 * The baseline that decides whether any of this means anything.
 *
 * These games are close ones, and both estimators start every game at -3 and
 * stay near it. If a constant does as well as the engine, the numbers below
 * are measuring the narrowness of the results and not the engine's judgement,
 * and nothing should be concluded from them.
 */
const truths = [...new Set(samples.map((s) => `${s.truth}`))].sort(
  (a, b) => Number(a) - Number(b),
);
console.log(`final margins present (A's side, margin included): ${truths.join(", ")}`);
const constants = [-3, 0];
for (const value of constants) {
  const { mae, sign } = score(() => value, samples);
  console.log(
    `  constant ${String(value).padStart(2)}:  ${mae.toFixed(2)} cells,` +
      ` who's ahead ${(sign * 100).toFixed(0)}%`,
  );
}
console.log();

console.log(`${"".padEnd(14)}${"mean error".padStart(12)}${"who's ahead".padStart(14)}`);
for (const [label, pick] of [
  ["confirmed", (s: Sample) => s.confirmed],
  ["engine", (s: Sample) => s.engine],
] as const) {
  const { mae, sign } = score(pick, samples);
  console.log(
    `${label.padEnd(14)}${mae.toFixed(2).padStart(12)} cells${(sign * 100).toFixed(0).padStart(9)}%`,
  );
}

console.log(`\nby stage of the game (mean error in cells, then who's-ahead):`);
console.log(
  `${"".padEnd(14)}${"opening".padStart(18)}${"midgame".padStart(18)}${"endgame".padStart(18)}`,
);
for (const [label, pick] of [
  ["confirmed", (s: Sample) => s.confirmed],
  ["engine", (s: Sample) => s.engine],
] as const) {
  const cells = [
    [0, 1 / 3],
    [1 / 3, 2 / 3],
    [2 / 3, 1.01],
  ].map(([lo, hi]) => {
    const part = band(lo, hi);
    if (part.length === 0) return "—".padStart(18);
    const { mae, sign } = score(pick, part);
    return `${mae.toFixed(1)} / ${(sign * 100).toFixed(0)}%`.padStart(18);
  });
  console.log(`${label.padEnd(14)}${cells.join("")}`);
}

/**
 * The bias question, separately from the error question. A count that is wrong
 * in both directions is noisy; one that is wrong in the same direction every
 * time is the engine believing it is winning when it is not, which is the
 * failure that would explain playing on as though the board were already
 * settled.
 */
const late = band(1 / 3, 1.01);
const bias = (pick: (s: Sample) => number) =>
  late.reduce((sum, s) => sum + (pick(s) - s.truth), 0) / late.length;
console.log(`\nmean signed error after the opening (positive = thinks A is doing better than it is):`);
console.log(`  confirmed  ${bias((s) => s.confirmed).toFixed(2)} cells`);
console.log(`  engine     ${bias((s) => s.engine).toFixed(2)} cells`);

/**
 * The question the two rows above actually pose.
 *
 * Settled territory is computed by the rules and cannot be wrong, so any credit
 * the engine deserves for *judgement* lives entirely in the influence term —
 * the part that guesses at ground not yet settled. This isolates it: how much
 * territory is still to come at this position, and does influence know?
 *
 * Correlation between what influence adds to the count now, and what actually
 * gets settled between now and the end. If this is near zero the engine is
 * scoring the board it has, not the board it is heading for, and no amount of
 * reweighting a blind term will make it see.
 */
function correlate(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 2) return NaN;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

const pairs: Array<[number, number]> = samples.map((s) => [
  // What influence adds on top of the settled count.
  s.engine - s.confirmed,
  // What is still to be settled between here and the end.
  s.truth - s.confirmed,
]);
console.log(`\ndoes influence see territory coming?`);
console.log(`  correlation, influence's contribution vs territory still to be settled:`);
console.log(`    all positions   ${correlate(pairs).toFixed(3)}   (n=${pairs.length})`);
const latePairs = late.map(
  (s): [number, number] => [s.engine - s.confirmed, s.truth - s.confirmed],
);
console.log(`    after opening   ${correlate(latePairs).toFixed(3)}   (n=${latePairs.length})`);
console.log(`  for scale: settled-so-far vs final margin is ${correlate(
  samples.map((s): [number, number] => [s.confirmed, s.truth]),
).toFixed(3)}`);

/**
 * Influence carries signal, and folding it in at the shipped rate extracts
 * none of it. That is a statement about the rate, not the signal, so this
 * sweeps it: the same estimate with the influence difference priced at each of
 * these instead of the shipped 0.12.
 *
 * `s.engine - s.confirmed` is the shipped contribution, so dividing it back out
 * recovers the raw influence difference without recomputing the owner maps.
 */
console.log(`\nwhat rate should influence be counted at? (shipped: 0.12)`);
for (const rate of [0, 0.06, 0.12, 0.25, 0.4, 0.6, 0.8, 1.0]) {
  const scaled = (s: Sample) => s.confirmed + ((s.engine - s.confirmed) / 0.12) * rate;
  const all = score(scaled, samples);
  const post = score(scaled, late);
  console.log(
    `  ${rate.toFixed(2)}:  all ${all.mae.toFixed(2)} cells / ${(all.sign * 100).toFixed(0)}%` +
      `    after opening ${post.mae.toFixed(2)} cells / ${(post.sign * 100).toFixed(0)}%`,
  );
}
