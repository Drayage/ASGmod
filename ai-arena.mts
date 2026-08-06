/**
 * Plays Alley Boss Cats engines against each other and reports territory-first
 * arena metrics. Win/loss remains reference data; the primary signal is the
 * seat-normalized final confirmed-territory margin.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAIMove, getSafeActions, tuning, type AIAction, type Difficulty } from "./src/games/alley-boss-cats/ai";
import {
  findBestMoveMinimax,
  findBestMoveVeryHard,
  setSelfInflictedThinGuardEnabled,
  setDominatedPocketGuardEnabled,
  setExistingGroupDangerRankingEnabled,
  setPocketSealDangerGuardEnabled,
  setFrameworkGuardEnabled,
  setPocketSealDenialFilterEnabled,
  setOpponentFrameworkGuardEnabled,
  setTtScoresEnabled,
} from "./src/games/alley-boss-cats/engine/minimax";
import { influenceCount } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { wideAreaBotMove } from "./src/games/alley-boss-cats/engine/wideAreaBot";
import { sealingBotMove } from "./src/games/alley-boss-cats/engine/sealingBot";
import {
  applyMove,
  calculateFinalResult,
  createInitialState,
  getLegalMoves,
  isLegalMove,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import { firstTerritoryTurn } from "./src/games/alley-boss-cats/arenaMetrics";
import { setOwnershipNet } from "./src/games/alley-boss-cats/engine/ownershipTerm";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import {
  aggregateRecords,
  rounded,
  type ArenaGameRecord,
  type EngineSeat,
  type FinishReason,
  type MatchAggregate,
} from "./arena-aggregate";

type Engine =
  | Difficulty
  | "RANDOM"
  | "WIDE"
  | "SEAL"
  | "VH_FRAME"
  | "VH_THIN"
  | "VH_GUARD"
  | "VH_NOGUARD"
  | "VH_POCKET"
  | "VH_NOPOCKET"
  | "VH_RANK"
  | "VH_NORANK"
  | "VH_SEAL"
  | "VH_NOSEAL"
  | "VH_SEVERE"
  | "VH_NOSEVERE"
  | "VH_CORNER"
  | "VH_NOCORNER"
  | "VH_DENY"
  | "VH_NODENY"
  | "VH_OPPFRAME"
  | "VH_NOOPPFRAME"
  | "VH_TT"
  | "VH_NOTT"
  | "VH_OWN"
  | "VH_NOOWN";


const FRAME_W = Number(process.env.FRAME_W ?? 60);
const URGENT = process.env.URGENT ? Number(process.env.URGENT) : null;
const THIN_W = Number(process.env.THIN_W ?? 1);
const TESTING_THIN = process.env.ONLY === "THIN";
const SEVERE_W = Number(process.env.SEVERE_W ?? 1);
const TESTING_SEVERE = process.env.ONLY === "SEVERE";
const OWN_W = Number(process.env.OWN_W ?? 1);
const TESTING_OWN = process.env.ONLY === "OWN";
const OWNERSHIP_NET = process.env.OWNERSHIP_NET ?? "public/ownership-net.json";

const HARD_MS = Number(process.env.HARD_MS ?? 250);
const VERY_HARD_MS = Number(process.env.VERY_HARD_MS ?? 1200);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 160);
const RANDOM_OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 4);
const ARENA_SEED = Number(process.env.ARENA_SEED ?? 20260804);
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? null;

/**
 * Shard selection, so one match can be split across parallel jobs.
 *
 * The 128-game baseline took 3h27m in a single job at the shipped 3000ms
 * budget, which leaves no room to compare candidates and none at all to
 * generate a dataset. Sharding is by *pair*, never by game: a mirrored pair is
 * the same opening played from both seats, and splitting one across jobs would
 * leave each side of it in a different sample, reintroducing exactly the
 * first-player bias the pairing exists to cancel.
 *
 * Shards write partial records that `arena-merge.mts` recombines; every shard
 * keeps the global game numbering so the merged run is identical to an
 * unsharded one.
 */
const SHARD_COUNT = Number(process.env.SHARD_COUNT ?? 1);
const SHARD_INDEX = Number(process.env.SHARD_INDEX ?? 0);

/** Third-line and star points: plausible openings that do not seed a tactical
 * collapse before the measured engines take over. */
const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6],
  [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5],
  [2, 3], [3, 2], [5, 6], [6, 5],
];

/** Ply at which the legacy pressure reference metric is sampled. */
const PRESSURE_PLY = 20;

function decide(state: GameState, player: Player, engine: Engine): AIAction {
  // Preserve the shipped/legacy arena switching exactly. This Phase 0 change
  // only measures decisions; it does not modify search, guards, or weights.
  if (URGENT !== null) {
    tuning.frameworkWeight = 0;
    tuning.urgentConfirmSize = engine === "VH_FRAME" ? URGENT : 8;
  } else {
    tuning.frameworkWeight = engine === "VH_FRAME" ? FRAME_W : 0;
    tuning.urgentConfirmSize = 8;
  }
  if (TESTING_THIN) tuning.thinWeight = engine === "VH_THIN" ? THIN_W : 0;
  if (TESTING_SEVERE) tuning.severeInfluenceWeight = engine === "VH_SEVERE" ? SEVERE_W : 0;
  // Only the candidate consults the net. Its opponent is the shipped engine
  // with the term off, so the pair differs in exactly this one thing.
  if (TESTING_OWN) tuning.ownershipWeight = engine === "VH_OWN" ? OWN_W : 0;
  setSelfInflictedThinGuardEnabled(engine !== "VH_NOGUARD");
  setDominatedPocketGuardEnabled(engine !== "VH_NOPOCKET");
  setExistingGroupDangerRankingEnabled(engine !== "VH_NORANK");
  setPocketSealDangerGuardEnabled(engine !== "VH_NOSEAL");
  setFrameworkGuardEnabled(engine !== "VH_NOCORNER");
  setPocketSealDenialFilterEnabled(engine !== "VH_NODENY");
  setOpponentFrameworkGuardEnabled(engine !== "VH_NOOPPFRAME");
  setTtScoresEnabled(engine !== "VH_NOTT");

  if (engine === "RANDOM") {
    const moves = getLegalMoves(state, player);
    if (moves.length === 0) return { type: "PASS" };
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { type: "PLACE", row: pick.row, col: pick.col };
  }
  if (engine === "WIDE") return wideAreaBotMove(state, player);
  if (engine === "SEAL") return sealingBotMove(state, player);
  if (engine === "HARD") return findBestMoveMinimax(state, player, HARD_MS);
  if (
    engine === "VERY_HARD" ||
    engine === "VH_FRAME" ||
    engine === "VH_THIN" ||
    engine === "VH_GUARD" ||
    engine === "VH_NOGUARD" ||
    engine === "VH_POCKET" ||
    engine === "VH_NOPOCKET" ||
    engine === "VH_RANK" ||
    engine === "VH_NORANK" ||
    engine === "VH_SEAL" ||
    engine === "VH_NOSEAL" ||
    engine === "VH_SEVERE" ||
    engine === "VH_NOSEVERE" ||
    engine === "VH_CORNER" ||
    engine === "VH_NOCORNER" ||
    engine === "VH_DENY" ||
    engine === "VH_NODENY" ||
    engine === "VH_OPPFRAME" ||
    engine === "VH_NOOPPFRAME" ||
    engine === "VH_TT" ||
    engine === "VH_NOTT" ||
    engine === "VH_OWN" ||
    engine === "VH_NOOWN"
  ) {
    return findBestMoveVeryHard(state, player, VERY_HARD_MS);
  }
  return getAIMove(state, player, engine);
}

function act(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function openingForPair(pairIndex: number): Array<[number, number]> {
  const pairSeed = (ARENA_SEED + Math.imul(pairIndex + 1, 0x9e3779b1)) >>> 0;
  const random = seededRandom(pairSeed);
  const points = [...OPENING_POINTS];
  for (let index = points.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [points[index], points[swap]] = [points[swap], points[index]];
  }
  return points;
}

interface GameResult {
  winner: Player;
  reason: FinishReason;
  plies: number;
  firstTerritoryTurn: Record<Player, number | null>;
  peakInfluence: Record<Player, number>;
  finalTerritory: Record<Player, number>;
  safeMovesAt: Record<Player, number | null>;
}

function playGame(engineA: Engine, engineB: Engine, opening: Array<[number, number]>): GameResult {
  let state = createInitialState();
  let totalPlies = 0;
  const states: GameState[] = [state];
  const peakInfluence: Record<Player, number> = { A: 0, B: 0 };
  const safeMovesAt: Record<Player, number | null> = { A: null, B: null };

  const notePosition = () => {
    const influence = influenceCount(state.board);
    for (const side of ["A", "B"] as const) {
      peakInfluence[side] = Math.max(peakInfluence[side], influence[side]);
    }
  };

  const finish = (reason: FinishReason): GameResult => ({
    winner: state.winner ?? calculateFinalResult(state).winner,
    reason,
    plies: totalPlies,
    firstTerritoryTurn: {
      A: firstTerritoryTurn(states, "A"),
      B: firstTerritoryTurn(states, "B"),
    },
    peakInfluence,
    finalTerritory: { A: state.territories.A.length, B: state.territories.B.length },
    safeMovesAt,
  });

  notePosition();

  // A mirrored pair receives the exact same deterministic opening. The engine
  // identities swap colours in the second game, cancelling first-player bias.
  for (const [row, col] of opening) {
    if (totalPlies >= RANDOM_OPENING_PLIES || totalPlies >= MAX_PLIES || state.winner) break;
    if (!isLegalMove(state, row, col, state.currentPlayer)) continue;
    state = applyMove(state, row, col);
    states.push(state);
    totalPlies += 1;
    notePosition();
  }

  while (totalPlies < MAX_PLIES) {
    if (state.winner) {
      return finish(state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY");
    }

    if (totalPlies === PRESSURE_PLY) {
      safeMovesAt.A = getSafeActions({ ...state, currentPlayer: "A" }, "A").pool.length;
      safeMovesAt.B = getSafeActions({ ...state, currentPlayer: "B" }, "B").pool.length;
    }

    const player = state.currentPlayer;
    const engine = player === "A" ? engineA : engineB;
    state = act(state, decide(state, player, engine));
    states.push(state);
    totalPlies += 1;
    notePosition();
  }

  if (state.winner) {
    return finish(state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY");
  }
  return finish("PLY_CAP");
}

function conversionRate(finalTerritory: number, peakInfluence: number): number | null {
  if (peakInfluence === 0) return null;
  return rounded((finalTerritory / peakInfluence) * 100);
}

interface MatchOutput {
  label: string;
  engines: { X: Engine; Y: Engine };
  timeBudgetMs: { X: number | null; Y: number | null };
  games: ArenaGameRecord[];
  aggregate: MatchAggregate;
}

function timeBudgetFor(engine: Engine): number | null {
  if (engine === "HARD") return HARD_MS;
  if (engine === "VERY_HARD" || engine.startsWith("VH_")) return VERY_HARD_MS;
  return null;
}

function runMatch(label: string, engineX: Engine, engineY: Engine, games: number): MatchOutput {
  if (games <= 0 || !Number.isInteger(games)) throw new Error(`GAMES must be a positive integer, got ${games}`);
  if (games % 2 !== 0) throw new Error(`Mirrored arena requires an even GAMES count, got ${games}`);
  if (!Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1) {
    throw new Error(`SHARD_COUNT must be a positive integer, got ${SHARD_COUNT}`);
  }
  if (!Number.isInteger(SHARD_INDEX) || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
    throw new Error(`SHARD_INDEX must be in [0, ${SHARD_COUNT}), got ${SHARD_INDEX}`);
  }
  if (games / 2 < SHARD_COUNT) {
    throw new Error(`${games} games is only ${games / 2} pairs, too few for ${SHARD_COUNT} shards`);
  }

  const records: ArenaGameRecord[] = [];

  for (let index = 0; index < games; index += 1) {
    const pair = Math.floor(index / 2);
    // Whole pairs only: the two games of a pair are the same opening from
    // either seat, and they have to be counted in the same sample.
    if (pair % SHARD_COUNT !== SHARD_INDEX) continue;

    const xIsA = index % 2 === 0;
    const result = playGame(
      xIsA ? engineX : engineY,
      xIsA ? engineY : engineX,
      openingForPair(pair),
    );
    const xSide: Player = xIsA ? "A" : "B";
    const ySide: Player = xIsA ? "B" : "A";
    const xFinal = result.finalTerritory[xSide];
    const yFinal = result.finalTerritory[ySide];
    const xPeak = result.peakInfluence[xSide];
    const yPeak = result.peakInfluence[ySide];

    records.push({
      // Global numbering, so a merged shard set is indistinguishable from an
      // unsharded run of the same seed.
      game: index + 1,
      pair: pair + 1,
      engineXSide: xSide,
      engineYSide: ySide,
      winnerSide: result.winner,
      winnerEngine: result.winner === xSide ? "X" : "Y",
      winReason: result.reason,
      plies: result.plies,
      finalTerritoryMargin: xFinal - yFinal,
      firstTerritoryTurn: {
        X: result.firstTerritoryTurn[xSide],
        Y: result.firstTerritoryTurn[ySide],
        A: result.firstTerritoryTurn.A,
        B: result.firstTerritoryTurn.B,
      },
      peakInfluence: {
        X: xPeak,
        Y: yPeak,
        A: result.peakInfluence.A,
        B: result.peakInfluence.B,
      },
      finalTerritory: {
        X: xFinal,
        Y: yFinal,
        A: result.finalTerritory.A,
        B: result.finalTerritory.B,
      },
      influenceToTerritoryConversionPercent: {
        X: conversionRate(xFinal, xPeak),
        Y: conversionRate(yFinal, yPeak),
      },
      safeMovesAtPly20: {
        X: result.safeMovesAt[xSide],
        Y: result.safeMovesAt[ySide],
      },
    });
  }

  const output: MatchOutput = {
    label,
    engines: { X: engineX, Y: engineY },
    timeBudgetMs: { X: timeBudgetFor(engineX), Y: timeBudgetFor(engineY) },
    games: records,
    aggregate: aggregateRecords(records),
  };

  const margin = output.aggregate.primaryMetric.summary;
  const counted = output.aggregate.primaryMetric.byFinishReason.TERRITORY;
  const shard = SHARD_COUNT > 1 ? ` [shard ${SHARD_INDEX + 1}/${SHARD_COUNT}]` : "";
  console.log(
    `${label}${shard}: territory margin ${margin.mean} cells over ${margin.count} games ` +
      `(SD ${margin.standardDeviation}, 95% CI [${margin.confidence95.low}, ` +
      `${margin.confidence95.high}])\n` +
      `  counted games only: ${counted.mean} cells over ${counted.count} ` +
      `(95% CI [${counted.confidence95.low}, ${counted.confidence95.high}])\n` +
      `  finish reasons ${JSON.stringify(output.aggregate.outcomes.reasons)}; ` +
      `territory decisions ` +
      `${output.aggregate.outcomes.territoryDecisionRatePercent}%\n` +
      `  first territory X ${output.aggregate.firstTerritoryTurn.X.mean} / ` +
      `Y ${output.aggregate.firstTerritoryTurn.Y.mean}; final territory X ` +
      `${output.aggregate.finalTerritory.X.mean} / Y ${output.aggregate.finalTerritory.Y.mean}\n` +
      `  conversion X ${output.aggregate.influenceToTerritoryConversionPercent.X.ratioOfMeans}% / ` +
      `Y ${output.aggregate.influenceToTerritoryConversionPercent.Y.ratioOfMeans}%`,
  );
  return output;
}

const only = process.env.ONLY;
const games = Number(process.env.GAMES ?? (only === "BASELINE" ? 128 : 12));

if (only === "BASELINE") {
  if (VERY_HARD_MS !== 3000) {
    throw new Error(`Phase 0 baseline requires equal 3000ms VERY_HARD budgets, got ${VERY_HARD_MS}ms`);
  }
  if (MAX_PLIES !== 160) {
    throw new Error(`Phase 0 baseline requires MAX_PLIES=160, got ${MAX_PLIES}`);
  }
}

console.log(
  `HARD ${HARD_MS}ms, VERY_HARD ${VERY_HARD_MS}ms, max ${MAX_PLIES} plies, ` +
    `${games} games, seed ${ARENA_SEED}\n`,
);

const matches: MatchOutput[] = [];
const addMatch = (label: string, engineX: Engine, engineY: Engine) => {
  matches.push(runMatch(label, engineX, engineY, games));
};

if (only === "OWN") {
  // Loaded up front so a missing or malformed net fails the run rather than
  // quietly turning the candidate back into the baseline.
  const file = JSON.parse(readFileSync(OWNERSHIP_NET, "utf8"));
  setOwnershipNet(file);
  console.log(`ownership net: ${OWNERSHIP_NET}, weight ${OWN_W}\n`);
}

console.time("total");
if (only === "BASELINE") addMatch("VERY_HARD self-play baseline", "VERY_HARD", "VERY_HARD");
if (!only || only === "RANDOM") addMatch("HARD vs RANDOM", "HARD", "RANDOM");
if (!only || only === "EASY") addMatch("HARD vs EASY", "HARD", "EASY");
if (!only || only === "NORMAL") addMatch("HARD vs NORMAL", "HARD", "NORMAL");
if (only === "VS_HARD") addMatch("VERY_HARD vs HARD", "VERY_HARD", "HARD");
if (only === "WIDE") {
  addMatch("VERY_HARD vs WIDE", "VERY_HARD", "WIDE");
  addMatch("HARD vs WIDE", "HARD", "WIDE");
  addMatch("NORMAL vs WIDE", "NORMAL", "WIDE");
}
if (only === "AB") addMatch(`VH+framework(${FRAME_W}) vs VERY_HARD`, "VH_FRAME", "VERY_HARD");
if (only === "THIN") addMatch(`VH+thin(${THIN_W}) vs VERY_HARD(pre-thin)`, "VH_THIN", "VERY_HARD");
if (only === "GUARD") addMatch("VH+guard vs VH-noguard", "VH_GUARD", "VH_NOGUARD");
if (only === "POCKET") addMatch("VH+pocket vs VH-nopocket", "VH_POCKET", "VH_NOPOCKET");
if (only === "RANK") addMatch("VH+rank vs VH-norank", "VH_RANK", "VH_NORANK");
if (only === "SEVERE") addMatch(`VH+severe(${SEVERE_W}) vs VERY_HARD(pre-severe)`, "VH_SEVERE", "VH_NOSEVERE");
if (only === "CORNER") addMatch("VH+corner vs VH-nocorner", "VH_CORNER", "VH_NOCORNER");
if (only === "DENY") addMatch("VH+denyfilter vs VH-nodenyfilter", "VH_DENY", "VH_NODENY");
if (only === "OPPFRAME") addMatch("VH+oppframe vs VH-nooppframe", "VH_OPPFRAME", "VH_NOOPPFRAME");
if (only === "TT") addMatch("VH+ttscores vs VH-nottscores", "VH_TT", "VH_NOTT");
if (only === "OWN") addMatch(`VH+ownership(${OWN_W}) vs VERY_HARD`, "VH_OWN", "VH_NOOWN");
if (only === "POCKETSEAL") addMatch("VH+pocketseal vs VH-nopocketseal", "VH_SEAL", "VH_NOSEAL");
if (only === "VS_SEAL") addMatch("VERY_HARD vs SEAL", "VERY_HARD", "SEAL");
if (only === "SEAL") {
  addMatch("VERY_HARD vs SEAL", "VERY_HARD", "SEAL");
  addMatch("HARD vs SEAL", "HARD", "SEAL");
  addMatch("NORMAL vs SEAL", "NORMAL", "SEAL");
}
if (only === "VS_NORMAL") addMatch("VERY_HARD vs NORMAL", "VERY_HARD", "NORMAL");
if (!only) addMatch("NORMAL vs EASY", "NORMAL", "EASY");
console.timeEnd("total");

if (matches.length === 0) throw new Error(`Unknown ONLY mode: ${String(only)}`);

const runOutput = {
  schemaVersion: 1,
  stage: "PHASE_0_TERRITORY_ARENA_BASELINE",
  generatedAt: new Date().toISOString(),
  primaryMetric: "finalTerritoryMargin",
  diagnosticOnly: true,
  mlCodeAdded: false,
  searchOrGuardChanged: false,
  tuningChanged: false,
  config: {
    gamesPerMatch: games,
    maxPlies: MAX_PLIES,
    openingPlies: RANDOM_OPENING_PLIES,
    arenaSeed: ARENA_SEED,
    hardMs: HARD_MS,
    veryHardMs: VERY_HARD_MS,
    mirrored: true,
  },
  matches,
};

if (OUTPUT_JSON) {
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(runOutput, null, 2)}\n`, "utf8");
  console.log(`wrote ${OUTPUT_JSON}`);
}
