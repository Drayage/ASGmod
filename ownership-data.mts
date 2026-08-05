/**
 * Generates the final-ownership dataset, and measures the bar a learned model
 * has to clear before it is worth wiring into the evaluation.
 *
 * The engine's territory signal is `influenceCount`: open ground each side is
 * closer to. On real games it is a poor stand-in for what the ground becomes —
 * 46 cells of reach turned into 4 of territory while the opponent turned 9 into
 * 17. This produces labels for the real quantity, per point, so a model can be
 * trained to predict it and scored against the heuristic it would replace.
 *
 * No model is trained here and nothing touches play. Dataset and measurement
 * only.
 *
 *   GAMES=200 MOVE_MS=300 npx vite-node ownership-data.mts
 *
 * Sharding matches the arena's: `SHARD_COUNT`/`SHARD_INDEX` split whole games
 * across parallel jobs, and every shard keeps global game numbering so the
 * pieces concatenate without collision.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import {
  CELL_COUNT,
  SYMMETRY_COUNT,
  completeToScoring,
  encodeBoard,
  encodeOwnership,
  ownershipAccuracy,
  ownershipClassScores,
  ownershipFromState,
  predictByInfluence,
  predictByNearestCat,
  predictBySettledTerritory,
  predictNeutral,
  territoryMargin,
  transformBoard,
  transformOwnership,
  withoutCaptureWin,
  type Ownership,
} from "./src/games/alley-boss-cats/ownership";
import {
  applyMove,
  createInitialState,
  isLegalMove,
} from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { summarize, rounded } from "./arena-aggregate";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const GAMES = Number(process.env.GAMES ?? 200);
const MOVE_MS = Number(process.env.MOVE_MS ?? 300);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 160);
const COMPLETION_PLIES = Number(process.env.COMPLETION_PLIES ?? 200);
const OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 4);
const SEED = Number(process.env.DATA_SEED ?? 20260804);
const SHARD_COUNT = Number(process.env.SHARD_COUNT ?? 1);
const SHARD_INDEX = Number(process.env.SHARD_INDEX ?? 0);
const OUTPUT_JSONL = process.env.OUTPUT_JSONL ?? "artifacts/ownership/positions.jsonl";
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "artifacts/ownership/summary.json";
const AUGMENT_ON_DISK = process.env.AUGMENT_ON_DISK === "1";
/** Every tenth generated game is held out, split whole so no position leaks. */
const VAL_EVERY = Number(process.env.VAL_EVERY ?? 10);

/**
 * `suppressed` declines capture wins from the first ply, so every game reaches a
 * count and the whole game is in the same regime as its label.
 * `normal` plays captures out and completes the finished position afterwards,
 * which keeps the position distribution honest at the cost of splicing a
 * counterfactual onto the tail. Default is `suppressed`: 71% of baseline games
 * end on a capture, and the games this engine loses are the counted ones.
 */
const CAPTURE_MODE = (process.env.CAPTURE_MODE ?? "suppressed") as "suppressed" | "normal";

const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6],
  [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5],
  [2, 3], [3, 2], [5, 6], [6, 5],
];

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

function openingForGame(gameIndex: number): Array<[number, number]> {
  const random = seededRandom((SEED + Math.imul(gameIndex + 1, 0x9e3779b1)) >>> 0);
  const points = [...OPENING_POINTS];
  for (let index = points.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [points[index], points[swap]] = [points[swap], points[index]];
  }
  return points;
}

interface PositionRow {
  /** Global game number, so shards concatenate without collision. */
  g: number;
  ply: number;
  toMove: Player;
  board: string;
  own: string;
  /** Final territory margin from A's side, in cells. */
  margin: number;
  split: "train" | "val";
  sym?: number;
}

interface GeneratedGame {
  gameIndex: number;
  positions: Array<{ board: Board; ply: number; toMove: Player }>;
  finalOwnership: Ownership;
  finalMargin: number;
  playedPlies: number;
  addedPlies: number;
  finishReason: string;
  cappedOut: boolean;
  declinedCaptureWins: number;
}

function generateGame(gameIndex: number): GeneratedGame {
  let state = createInitialState();
  const positions: Array<{ board: Board; ply: number; toMove: Player }> = [];
  let plies = 0;
  let declinedCaptureWins = 0;

  for (const [row, col] of openingForGame(gameIndex)) {
    if (plies >= OPENING_PLIES || state.winner) break;
    if (!isLegalMove(state, row, col, state.currentPlayer)) continue;
    positions.push({ board: state.board, ply: plies, toMove: state.currentPlayer });
    state = applyMove(state, row, col);
    plies += 1;
  }

  while (!state.winner && plies < MAX_PLIES) {
    positions.push({ board: state.board, ply: plies, toMove: state.currentPlayer });
    const player = state.currentPlayer;
    let action = findBestMoveVeryHard(state, player, MOVE_MS);
    if (CAPTURE_MODE === "suppressed") {
      const declined = withoutCaptureWin(state, player, action);
      if (declined) {
        action = declined;
        declinedCaptureWins += 1;
      }
    }
    state = applyAction(state, action);
    plies += 1;
  }

  const playedPlies = plies;
  const finishReason = state.winner ? (state.winReason ?? "TERRITORY") : "PLY_CAP";
  const completion = completeToScoring(state, COMPLETION_PLIES);

  return {
    gameIndex,
    positions,
    finalOwnership: ownershipFromState(completion.state),
    finalMargin: territoryMargin(completion.state, "A"),
    playedPlies,
    addedPlies: completion.addedPlies,
    finishReason,
    cappedOut: completion.cappedOut,
    declinedCaptureWins,
  };
}

/* -------------------------------------------------------------------------- */

interface BaselineTally {
  positions: number;
  allCorrect: number;
  allTotal: number;
  openCorrect: number;
  openTotal: number;
  /** Open points really held, claimed, and both — pooled over every position. */
  actualHeld: number;
  claimed: number;
  claimedAndHeld: number;
}

const emptyTally = (): BaselineTally => ({
  positions: 0,
  allCorrect: 0,
  allTotal: 0,
  openCorrect: 0,
  openTotal: 0,
  actualHeld: 0,
  claimed: 0,
  claimedAndHeld: 0,
});

const BASELINES = ["influence", "nearestCat", "settledTerritory", "alwaysNeutral"] as const;
type BaselineName = (typeof BASELINES)[number];

function predictorFor(name: BaselineName, board: Board): Ownership {
  switch (name) {
    case "influence":
      return predictByInfluence(board);
    case "nearestCat":
      return predictByNearestCat(board);
    case "settledTerritory":
      // Territory already walled in at this position, which needs a state; the
      // board alone determines it, so rebuild the minimal one.
      return predictBySettledTerritory(stateFromBoard(board));
    default:
      return predictNeutral();
  }
}

function stateFromBoard(board: Board): GameState {
  const base = createInitialState();
  return { ...base, board, territories: calculateTerritories(board) };
}

function scoreBaselines(
  tallies: Record<BaselineName, BaselineTally>,
  board: Board,
  actual: Ownership,
): void {
  for (const name of BASELINES) {
    const predicted = predictorFor(name, board);
    const accuracy = ownershipAccuracy(board, predicted, actual);
    const classes = ownershipClassScores(board, predicted, actual);
    const tally = tallies[name];
    tally.positions += 1;
    tally.allCorrect += accuracy.allCells.correct;
    tally.allTotal += accuracy.allCells.total;
    tally.openCorrect += accuracy.openCells.correct;
    tally.openTotal += accuracy.openCells.total;
    for (const side of ["A", "B"] as const) {
      tally.actualHeld += classes[side].actual;
      tally.claimed += classes[side].predicted;
      tally.claimedAndHeld += classes[side].hit;
    }
  }
}

function reportBaselines(tallies: Record<BaselineName, BaselineTally>) {
  const out: Record<string, unknown> = {};
  for (const name of BASELINES) {
    const tally = tallies[name];
    out[name] = {
      positions: tally.positions,
      allCellsPercent: tally.allTotal === 0 ? null : rounded((tally.allCorrect / tally.allTotal) * 100),
      openCellsPercent:
        tally.openTotal === 0 ? null : rounded((tally.openCorrect / tally.openTotal) * 100),
      // Raw counts as well as rates, so merging shards is exact addition rather
      // than an average of averages weighted by nothing.
      positionsScored: tally.positions,
      allCells: tally.allTotal,
      allCorrect: tally.allCorrect,
      openCells: tally.openTotal,
      openCorrect: tally.openCorrect,
      claimedAndHeldOpenCells: tally.claimedAndHeld,
      // Accuracy is dominated by how much of the board ends up nobody's, so the
      // claims are reported on their own: how much real territory the signal
      // found, and how much of what it claimed was ever held.
      territoryRecallPercent:
        tally.actualHeld === 0 ? null : rounded((tally.claimedAndHeld / tally.actualHeld) * 100),
      territoryPrecisionPercent:
        tally.claimed === 0 ? null : rounded((tally.claimedAndHeld / tally.claimed) * 100),
      claimedOpenCells: tally.claimed,
      heldOpenCells: tally.actualHeld,
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Human games: the validation set, never trained on.                          */
/* -------------------------------------------------------------------------- */

interface HumanRecord {
  moveHistory: Array<{ type: string; row?: number; col?: number }>;
}

function humanValidation(): {
  files: string[];
  games: number;
  positions: number;
  baselines: Record<string, unknown>;
} | null {
  const candidates = [
    "src/games/alley-boss-cats/testdata/humanGames.json",
    "docs/newbuild-games-32293a1.json",
  ].filter((path) => existsSync(path));
  if (candidates.length === 0) return null;

  const tallies = Object.fromEntries(
    BASELINES.map((name) => [name, emptyTally()]),
  ) as Record<BaselineName, BaselineTally>;
  let games = 0;
  let positions = 0;

  for (const path of candidates) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: HumanRecord[] };
    for (const record of parsed.records) {
      let state = createInitialState();
      const boards: Board[] = [];
      for (const move of record.moveHistory) {
        if (state.winner) break;
        boards.push(state.board);
        state =
          move.type === "PASS"
            ? applyAction(state, { type: "PASS" })
            : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      }
      const finished = completeToScoring(state, COMPLETION_PLIES);
      const actual = ownershipFromState(finished.state);
      for (const board of boards) {
        scoreBaselines(tallies, board, actual);
        positions += 1;
      }
      games += 1;
    }
  }

  return { files: candidates, games, positions, baselines: reportBaselines(tallies) };
}

/* -------------------------------------------------------------------------- */

if (!Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1) {
  throw new Error(`SHARD_COUNT must be a positive integer, got ${SHARD_COUNT}`);
}
if (!Number.isInteger(SHARD_INDEX) || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
  throw new Error(`SHARD_INDEX must be in [0, ${SHARD_COUNT}), got ${SHARD_INDEX}`);
}

console.log(
  `ownership dataset: ${GAMES} games, ${MOVE_MS}ms/move, capture mode ${CAPTURE_MODE}, ` +
    `shard ${SHARD_INDEX + 1}/${SHARD_COUNT}, seed ${SEED}`,
);

const rows: PositionRow[] = [];
const tallies = Object.fromEntries(
  BASELINES.map((name) => [name, emptyTally()]),
) as Record<BaselineName, BaselineTally>;

const finishReasons: Record<string, number> = {};
const marginValues: number[] = [];
const playedPlyValues: number[] = [];
const addedPlyValues: number[] = [];
let ownedA = 0;
let ownedB = 0;
let ownedNobody = 0;
let cappedOut = 0;
let declinedTotal = 0;
let generated = 0;

console.time("generate");
for (let gameIndex = 0; gameIndex < GAMES; gameIndex += 1) {
  if (gameIndex % SHARD_COUNT !== SHARD_INDEX) continue;

  const game = generateGame(gameIndex);
  generated += 1;
  finishReasons[game.finishReason] = (finishReasons[game.finishReason] ?? 0) + 1;
  marginValues.push(game.finalMargin);
  playedPlyValues.push(game.playedPlies);
  addedPlyValues.push(game.addedPlies);
  if (game.cappedOut) cappedOut += 1;
  declinedTotal += game.declinedCaptureWins;

  for (const owner of game.finalOwnership) {
    if (owner === "A") ownedA += 1;
    else if (owner === "B") ownedB += 1;
    else ownedNobody += 1;
  }

  // Whole games go to one side of the split: positions from the same game share
  // a label and are near-duplicates of each other, so splitting inside a game
  // would leak the answer into validation.
  const split: "train" | "val" = gameIndex % VAL_EVERY === VAL_EVERY - 1 ? "val" : "train";

  for (const position of game.positions) {
    scoreBaselines(tallies, position.board, game.finalOwnership);
    const symmetries = AUGMENT_ON_DISK ? SYMMETRY_COUNT : 1;
    for (let sym = 0; sym < symmetries; sym += 1) {
      rows.push({
        g: game.gameIndex + 1,
        ply: position.ply,
        toMove: position.toMove,
        board: encodeBoard(sym === 0 ? position.board : transformBoard(position.board, sym)),
        own: encodeOwnership(
          sym === 0 ? game.finalOwnership : transformOwnership(game.finalOwnership, sym),
        ),
        margin: game.finalMargin,
        split,
        ...(AUGMENT_ON_DISK ? { sym } : {}),
      });
    }
  }

  if (generated % 10 === 0) console.log(`  ${generated} games, ${rows.length} rows`);
}
console.timeEnd("generate");

const validation = humanValidation();

const summary = {
  schemaVersion: 1,
  stage: "PHASE_1_OWNERSHIP_DATASET",
  generatedAt: new Date().toISOString(),
  diagnosticOnly: true,
  modelTrained: false,
  searchOrGuardChanged: false,
  tuningChanged: false,
  config: {
    games: GAMES,
    moveMs: MOVE_MS,
    maxPlies: MAX_PLIES,
    completionPlies: COMPLETION_PLIES,
    openingPlies: OPENING_PLIES,
    captureMode: CAPTURE_MODE,
    seed: SEED,
    shardCount: SHARD_COUNT,
    shardIndex: SHARD_INDEX,
    augmentOnDisk: AUGMENT_ON_DISK,
    valEvery: VAL_EVERY,
  },
  dataset: {
    gamesGenerated: generated,
    positions: AUGMENT_ON_DISK ? rows.length / SYMMETRY_COUNT : rows.length,
    rowsWritten: rows.length,
    rowsAfterEightfoldSymmetry: AUGMENT_ON_DISK ? rows.length : rows.length * SYMMETRY_COUNT,
    trainPositions: rows.filter((row) => row.split === "train").length,
    valPositions: rows.filter((row) => row.split === "val").length,
    finishReasons,
    completionsCappedOut: cappedOut,
    declinedCaptureWins: declinedTotal,
    playedPlies: summarize(playedPlyValues),
    completionPliesAdded: summarize(addedPlyValues),
    finalMarginFromA: summarize(marginValues),
    labelDistribution: {
      A: ownedA,
      B: ownedB,
      nobody: ownedNobody,
      aPercent: rounded((ownedA / (generated * CELL_COUNT)) * 100),
      bPercent: rounded((ownedB / (generated * CELL_COUNT)) * 100),
      nobodyPercent: rounded((ownedNobody / (generated * CELL_COUNT)) * 100),
    },
  },
  /**
   * What the current heuristics score against the same labels. A learned model
   * has to beat `influence.openCellsPercent` to be worth wiring in — that is
   * the judgement the evaluation makes today. Read the open-cell number, not
   * the all-cell one: an occupied point can never become territory, so
   * predicting nobody there is free credit.
   */
  baselines: reportBaselines(tallies),
  humanValidation: validation,
};

mkdirSync(dirname(OUTPUT_JSONL), { recursive: true });
writeFileSync(OUTPUT_JSONL, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
writeFileSync(OUTPUT_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`\n${generated} games -> ${rows.length} rows`);
console.log(`finish reasons ${JSON.stringify(finishReasons)}`);
console.log(
  `labels A ${summary.dataset.labelDistribution.aPercent}% / ` +
    `B ${summary.dataset.labelDistribution.bPercent}% / ` +
    `nobody ${summary.dataset.labelDistribution.nobodyPercent}%`,
);
console.log("\nbaseline ownership accuracy (open cells — the number to beat):");
for (const [name, value] of Object.entries(summary.baselines)) {
  const full = value as {
    openCellsPercent: number | null;
    allCellsPercent: number | null;
    territoryRecallPercent: number | null;
    territoryPrecisionPercent: number | null;
  };
  console.log(
    `  ${name.padEnd(18)} open ${String(full.openCellsPercent).padStart(9)}%   ` +
      `recall ${String(full.territoryRecallPercent).padStart(9)}%   ` +
      `precision ${String(full.territoryPrecisionPercent).padStart(9)}%`,
  );
}
if (validation) {
  console.log(`\nhuman validation (${validation.games} games, ${validation.positions} positions):`);
  for (const [name, value] of Object.entries(validation.baselines)) {
    const entry = value as {
      openCellsPercent: number | null;
      territoryRecallPercent: number | null;
      territoryPrecisionPercent: number | null;
    };
    console.log(
      `  ${name.padEnd(18)} open ${String(entry.openCellsPercent).padStart(9)}%   ` +
        `recall ${String(entry.territoryRecallPercent).padStart(9)}%   ` +
        `precision ${String(entry.territoryPrecisionPercent).padStart(9)}%`,
    );
  }
}
console.log(`\nwrote ${OUTPUT_JSONL} and ${OUTPUT_JSON}`);
