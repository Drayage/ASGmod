import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { applyAction } from "../src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard } from "../src/games/alley-boss-cats/engine/minimax";
import {
  influenceOwnershipPrediction,
  nearestStoneOwnershipPrediction,
  neutralOwnershipPrediction,
  type OwnershipLabel,
} from "../src/games/alley-boss-cats/ownershipBaselines";
import { bestQuietAlternative } from "../src/games/alley-boss-cats/ownership";
import {
  applyMove,
  createInitialState,
  isLegalMove,
  passTurn,
} from "../src/games/alley-boss-cats/rules";
import { BOARD_SIZE } from "../src/games/alley-boss-cats/types";
import type { Board, GameState, Move, Player } from "../src/games/alley-boss-cats/types";

type Mode = "selfplay" | "human";
type FinishReason = "CAPTURE" | "TERRITORY" | "PLY_CAP";
type Split = "TRAIN" | "HUMAN_VALIDATION_ONLY";

interface RecordedGame {
  id?: string;
  moveHistory: Move[];
  winReason?: "CAPTURE" | "TERRITORY";
  winner?: Player;
}

interface PendingSample {
  gameId: string;
  gameIndex: number;
  split: Split;
  source: "SELF_PLAY_400MS" | "HUMAN_RECORDED";
  ply: number;
  currentPlayer: Player;
  board: number[];
  remainingCats: Record<Player, number>;
  consecutivePasses: number;
  lastMove: number;
}

interface DatasetSample extends PendingSample {
  symmetry: number;
  ownership: OwnershipLabel[];
  finalMargin: number;
  normalFinishReason: FinishReason;
  labelRolloutPlies: number;
  labelRolloutForcedPasses: boolean;
}

interface BaselineCounter {
  correct: number;
  openCorrect: number;
  openTotal: number;
  byPrediction: Record<OwnershipLabel, { correct: number; total: number }>;
  total: number;
  byLabel: Record<OwnershipLabel, { correct: number; total: number }>;
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name: string, fallback: number, minimum: number): number {
  const value = Number.parseInt(arg(name, String(fallback)), 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return value;
}

const MODE = arg("mode", "selfplay") as Mode;
const GAMES = intArg("games", MODE === "selfplay" ? 25 : 20, 1);
const BUDGET_MS = intArg("budget-ms", 400, 50);
const BASE_SEED = intArg("seed", 20260804, 1);
const SHARD_INDEX = intArg("shard-index", 0, 0);
const WARMUP_PLIES = intArg("warmup-plies", 4, 0);
const SAMPLE_EVERY = intArg("sample-every", 2, 1);
const MAX_NORMAL_PLIES = intArg("max-normal-plies", 160, 16);
const MAX_LABEL_PLIES = intArg("max-label-plies", 160, 16);
const OUTPUT_DIR = resolve(arg("output-dir", "ownership-output"));
const SOURCE_FILES = arg(
  "sources",
  "src/games/alley-boss-cats/testdata/humanGames.json,docs/newbuild-games-32293a1.json",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (MODE !== "selfplay" && MODE !== "human") throw new Error(`Unknown mode ${MODE}`);

const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6], [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5], [2, 3], [3, 2], [5, 6], [6, 5],
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

function openingForGame(globalGame: number): Array<[number, number]> {
  const random = seededRandom((BASE_SEED + Math.imul(globalGame + 1, 0x9e3779b1)) >>> 0);
  const points = [...OPENING_POINTS];
  for (let index = points.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [points[index], points[swap]] = [points[swap], points[index]];
  }
  return points.slice(0, 4);
}

function encodeBoard(board: Board): number[] {
  const code = { EMPTY: 0, PLAYER_A: 1, PLAYER_B: 2, NEUTRAL: 3 } as const;
  return board.flat().map((cell) => code[cell]);
}

function decodeBoard(encoded: number[]): Board {
  const cells = ["EMPTY", "PLAYER_A", "PLAYER_B", "NEUTRAL"] as const;
  const board: Board = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    board.push(encoded.slice(row * BOARD_SIZE, (row + 1) * BOARD_SIZE).map((value) => cells[value]));
  }
  return board;
}

function encodeMove(move: Move | undefined): number {
  if (!move || move.type === "PASS") return BOARD_SIZE * BOARD_SIZE;
  return move.row * BOARD_SIZE + move.col;
}

function snapshot(
  gameId: string,
  gameIndex: number,
  split: Split,
  source: PendingSample["source"],
  state: GameState,
): PendingSample {
  return {
    gameId,
    gameIndex,
    split,
    source,
    ply: state.moveHistory.length,
    currentPlayer: state.currentPlayer,
    board: encodeBoard(state.board),
    remainingCats: { ...state.remainingCats },
    consecutivePasses: state.consecutivePasses,
    lastMove: encodeMove(state.moveHistory[state.moveHistory.length - 1]),
  };
}

function shouldSample(state: GameState): boolean {
  return state.moveHistory.length >= WARMUP_PLIES &&
    (state.moveHistory.length - WARMUP_PLIES) % SAMPLE_EVERY === 0;
}

function isCaptureResult(state: GameState): boolean {
  return state.winner !== null && state.winReason === "CAPTURE";
}

function quietLabelRollout(start: GameState): {
  finalState: GameState;
  rolloutPlies: number;
  forcedPasses: boolean;
} {
  let state = start;
  let rolloutPlies = 0;
  let forcedPasses = false;

  while (!state.winner && rolloutPlies < MAX_LABEL_PLIES) {
    const player = state.currentPlayer;
    const teacher = findBestMoveVeryHard(state, player, BUDGET_MS);
    let action = teacher;
    if (teacher.type === "PLACE") {
      const next = applyMove(state, teacher.row, teacher.col);
      if (isCaptureResult(next)) {
        action = bestQuietAlternative(state, player) ?? { type: "PASS" };
      }
    }
    state = applyAction(state, action);
    rolloutPlies += 1;
  }

  if (!state.winner) {
    forcedPasses = true;
    state = passTurn(state);
    if (!state.winner) state = passTurn(state);
  }
  if (!state.winner || state.winReason !== "TERRITORY") {
    throw new Error("Label rollout did not finish by territory");
  }
  return { finalState: state, rolloutPlies, forcedPasses };
}

function ownershipFromFinal(state: GameState): OwnershipLabel[] {
  const labels = Array<OwnershipLabel>(BOARD_SIZE * BOARD_SIZE).fill(0);
  for (const { row, col } of state.territories.A) labels[row * BOARD_SIZE + col] = 1;
  for (const { row, col } of state.territories.B) labels[row * BOARD_SIZE + col] = 2;
  return labels;
}

function transformCoord(row: number, col: number, symmetry: number): [number, number] {
  let r = row;
  let c = col;
  if (symmetry >= 4) c = BOARD_SIZE - 1 - c;
  const rotations = symmetry % 4;
  for (let turn = 0; turn < rotations; turn += 1) {
    [r, c] = [c, BOARD_SIZE - 1 - r];
  }
  return [r, c];
}

function transformGrid<T>(values: T[], symmetry: number): T[] {
  const transformed = Array<T>(values.length);
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const [nextRow, nextCol] = transformCoord(row, col, symmetry);
      transformed[nextRow * BOARD_SIZE + nextCol] = values[row * BOARD_SIZE + col];
    }
  }
  return transformed;
}

function transformMoveIndex(index: number, symmetry: number): number {
  if (index >= BOARD_SIZE * BOARD_SIZE) return index;
  const [row, col] = transformCoord(Math.floor(index / BOARD_SIZE), index % BOARD_SIZE, symmetry);
  return row * BOARD_SIZE + col;
}

function augment(sample: Omit<DatasetSample, "symmetry">): DatasetSample[] {
  return Array.from({ length: 8 }, (_, symmetry) => ({
    ...sample,
    symmetry,
    board: transformGrid(sample.board, symmetry),
    ownership: transformGrid(sample.ownership, symmetry),
    lastMove: transformMoveIndex(sample.lastMove, symmetry),
  }));
}

function counter(): BaselineCounter {
  return {
    correct: 0,
    total: 0,
    openCorrect: 0,
    openTotal: 0,
    byLabel: {
      0: { correct: 0, total: 0 },
      1: { correct: 0, total: 0 },
      2: { correct: 0, total: 0 },
    },
    byPrediction: {
      0: { correct: 0, total: 0 },
      1: { correct: 0, total: 0 },
      2: { correct: 0, total: 0 },
    },
  };
}

function updateCounter(
  target: BaselineCounter,
  prediction: OwnershipLabel[],
  truth: OwnershipLabel[],
  board: Board,
): void {
  for (let index = 0; index < truth.length; index += 1) {
    const label = truth[index];
    const guess = prediction[index];
    const correct = guess === label;
    target.total += 1;
    target.byLabel[label].total += 1;
    // Tallied by what was predicted, not by what was true: that is the only
    // way to ask how much of a claim was ever going to be held.
    target.byPrediction[guess].total += 1;
    if (correct) {
      target.correct += 1;
      target.byLabel[label].correct += 1;
      target.byPrediction[guess].correct += 1;
    }

    // A point already carrying a cat can never become territory, so predicting
    // "nobody" there is free. Roughly five in six points are like that by the
    // time a game is counted, which is why whole-board accuracy ranks a
    // predictor that claims nothing above the one the engine actually uses.
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
    if (board[row][col] === "EMPTY") {
      target.openTotal += 1;
      if (correct) target.openCorrect += 1;
    }
  }
}

function finalizeCounter(value: BaselineCounter) {
  const recall = (label: OwnershipLabel) =>
    value.byLabel[label].total === 0
      ? null
      : value.byLabel[label].correct / value.byLabel[label].total;
  const precision = (label: OwnershipLabel) =>
    value.byPrediction[label].total === 0
      ? null
      : value.byPrediction[label].correct / value.byPrediction[label].total;

  // Pooled over both sides: the question is how much claimed territory is
  // held, not how each colour fared.
  const claimed = value.byPrediction[1].total + value.byPrediction[2].total;
  const claimedAndHeld = value.byPrediction[1].correct + value.byPrediction[2].correct;
  const held = value.byLabel[1].total + value.byLabel[2].total;
  const heldAndFound = value.byLabel[1].correct + value.byLabel[2].correct;

  return {
    correct: value.correct,
    total: value.total,
    accuracy: value.total === 0 ? null : value.correct / value.total,
    openCorrect: value.openCorrect,
    openTotal: value.openTotal,
    openAccuracy: value.openTotal === 0 ? null : value.openCorrect / value.openTotal,
    recallByClass: {
      neutral: recall(0),
      A: recall(1),
      B: recall(2),
    },
    precisionByClass: {
      neutral: precision(0),
      A: precision(1),
      B: precision(2),
    },
    // The pair that actually separates a useful territory signal from a silent
    // one. Measured on a 200-game pilot, influenceCount finds 76.7% of the
    // territory that forms and is wrong about 68.5% of what it claims.
    claimedOpenCells: claimed,
    heldOpenCells: held,
    claimedAndHeldOpenCells: claimedAndHeld,
    territoryRecall: held === 0 ? null : heldAndFound / held,
    territoryPrecision: claimed === 0 ? null : claimedAndHeld / claimed,
  };
}

function evaluateBaselines(samples: Array<Omit<DatasetSample, "symmetry">>) {
  const influence = counter();
  const nearest = counter();
  const neutral = counter();
  for (const sample of samples) {
    const board = decodeBoard(sample.board);
    updateCounter(influence, influenceOwnershipPrediction(board), sample.ownership, board);
    updateCounter(nearest, nearestStoneOwnershipPrediction(board), sample.ownership, board);
    updateCounter(neutral, neutralOwnershipPrediction(board), sample.ownership, board);
  }
  return {
    influenceCountSignal: finalizeCounter(influence),
    nearestStoneOwner: finalizeCounter(nearest),
    alwaysNeutral: finalizeCounter(neutral),
  };
}

function labelDistribution(samples: Array<Omit<DatasetSample, "symmetry">>) {
  const counts = { neutral: 0, A: 0, B: 0 };
  for (const sample of samples) {
    for (const label of sample.ownership) {
      if (label === 0) counts.neutral += 1;
      else if (label === 1) counts.A += 1;
      else counts.B += 1;
    }
  }
  const total = counts.neutral + counts.A + counts.B;
  return {
    counts,
    percent: {
      neutral: (counts.neutral / total) * 100,
      A: (counts.A / total) * 100,
      B: (counts.B / total) * 100,
    },
  };
}

function finalizeGame(
  pending: PendingSample[],
  labelStart: GameState,
  normalFinishReason: FinishReason,
): { samples: Array<Omit<DatasetSample, "symmetry">>; labelState: GameState; rolloutPlies: number; forcedPasses: boolean } {
  const label = quietLabelRollout(labelStart);
  const ownership = ownershipFromFinal(label.finalState);
  const finalMargin = label.finalState.territories.A.length - label.finalState.territories.B.length;
  return {
    labelState: label.finalState,
    rolloutPlies: label.rolloutPlies,
    forcedPasses: label.forcedPasses,
    samples: pending.map((sample) => ({
      ...sample,
      ownership,
      finalMargin,
      normalFinishReason,
      labelRolloutPlies: label.rolloutPlies,
      labelRolloutForcedPasses: label.forcedPasses,
    })),
  };
}

function playSelfGame(localIndex: number) {
  const globalGame = SHARD_INDEX * GAMES + localIndex;
  const gameId = `selfplay-s${SHARD_INDEX}-g${localIndex}`;
  let state = createInitialState();
  const pending: PendingSample[] = [];

  for (const [row, col] of openingForGame(globalGame)) {
    if (state.winner || state.moveHistory.length >= 4) break;
    if (isLegalMove(state, row, col, state.currentPlayer)) state = applyMove(state, row, col);
  }

  let normalFinishReason: FinishReason = "PLY_CAP";
  let labelStart = state;
  while (!state.winner && state.moveHistory.length < MAX_NORMAL_PLIES) {
    if (shouldSample(state)) pending.push(snapshot(gameId, globalGame, "TRAIN", "SELF_PLAY_400MS", state));
    const player = state.currentPlayer;
    const action = findBestMoveVeryHard(state, player, BUDGET_MS);
    if (action.type === "PLACE") {
      const next = applyMove(state, action.row, action.col);
      if (isCaptureResult(next)) {
        normalFinishReason = "CAPTURE";
        labelStart = state;
        state = next;
        break;
      }
      state = next;
    } else {
      state = passTurn(state);
    }
    labelStart = state;
    if (state.winner) normalFinishReason = state.winReason === "TERRITORY" ? "TERRITORY" : "CAPTURE";
  }
  if (state.winner?.length === 0) throw new Error("unreachable");
  if (!state.winner && state.moveHistory.length >= MAX_NORMAL_PLIES) normalFinishReason = "PLY_CAP";
  if (state.winner && state.winReason === "TERRITORY") labelStart = state;

  const result = state.winner && state.winReason === "TERRITORY"
    ? {
        labelState: state,
        rolloutPlies: 0,
        forcedPasses: false,
        samples: pending.map((sample) => ({
          ...sample,
          ownership: ownershipFromFinal(state),
          finalMargin: state.territories.A.length - state.territories.B.length,
          normalFinishReason,
          labelRolloutPlies: 0,
          labelRolloutForcedPasses: false,
        })),
      }
    : finalizeGame(pending, labelStart, normalFinishReason);

  return {
    ...result,
    game: {
      gameId,
      gameIndex: globalGame,
      normalFinishReason,
      normalPlies: state.moveHistory.length,
      samples: result.samples.length,
      labelTerritory: {
        A: result.labelState.territories.A.length,
        B: result.labelState.territories.B.length,
      },
      labelRolloutPlies: result.rolloutPlies,
      labelRolloutForcedPasses: result.forcedPasses,
    },
  };
}

function readRecordedGames(files: string[]): RecordedGame[] {
  const records: RecordedGame[] = [];
  for (const file of files) {
    const payload = JSON.parse(readFileSync(resolve(file), "utf8"));
    const sourceRecords = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(sourceRecords)) throw new Error(`No records array in ${file}`);
    for (const record of sourceRecords) records.push(record);
  }
  return records;
}

function playRecordedGame(record: RecordedGame, localIndex: number) {
  const gameId = `human-${record.id ?? localIndex + 1}`;
  const pending: PendingSample[] = [];
  let state = createInitialState();
  let normalFinishReason: FinishReason = "PLY_CAP";
  let labelStart = state;

  for (const recordedMove of record.moveHistory) {
    if (state.winner) break;
    if (recordedMove.player !== state.currentPlayer) {
      throw new Error(`${gameId}: expected ${state.currentPlayer}, recorded ${recordedMove.player}`);
    }
    if (shouldSample(state)) pending.push(snapshot(gameId, localIndex, "HUMAN_VALIDATION_ONLY", "HUMAN_RECORDED", state));
    if (recordedMove.type === "PASS") {
      state = passTurn(state);
      labelStart = state;
      continue;
    }
    if (!isLegalMove(state, recordedMove.row, recordedMove.col, recordedMove.player)) {
      throw new Error(`${gameId}: illegal recorded move ${recordedMove.row},${recordedMove.col}`);
    }
    const next = applyMove(state, recordedMove.row, recordedMove.col);
    if (isCaptureResult(next)) {
      normalFinishReason = "CAPTURE";
      labelStart = state;
      state = next;
      break;
    }
    state = next;
    labelStart = state;
  }

  if (state.winner) normalFinishReason = state.winReason === "TERRITORY" ? "TERRITORY" : "CAPTURE";
  const result = state.winner && state.winReason === "TERRITORY"
    ? {
        labelState: state,
        rolloutPlies: 0,
        forcedPasses: false,
        samples: pending.map((sample) => ({
          ...sample,
          ownership: ownershipFromFinal(state),
          finalMargin: state.territories.A.length - state.territories.B.length,
          normalFinishReason,
          labelRolloutPlies: 0,
          labelRolloutForcedPasses: false,
        })),
      }
    : finalizeGame(pending, labelStart, normalFinishReason);

  return {
    ...result,
    game: {
      gameId,
      gameIndex: localIndex,
      normalFinishReason,
      normalPlies: state.moveHistory.length,
      samples: result.samples.length,
      labelTerritory: {
        A: result.labelState.territories.A.length,
        B: result.labelState.territories.B.length,
      },
      labelRolloutPlies: result.rolloutPlies,
      labelRolloutForcedPasses: result.forcedPasses,
    },
  };
}

const started = performance.now();
const gameResults = MODE === "selfplay"
  ? Array.from({ length: GAMES }, (_, index) => playSelfGame(index + 1))
  : readRecordedGames(SOURCE_FILES).map((record, index) => playRecordedGame(record, index));

if (MODE === "human" && gameResults.length !== GAMES) {
  throw new Error(`Expected ${GAMES} human games, found ${gameResults.length}`);
}

const baseSamples = gameResults.flatMap((result) => result.samples);
const augmentedSamples = baseSamples.flatMap(augment);
const baseline = evaluateBaselines(baseSamples);
const distribution = labelDistribution(baseSamples);
const elapsedSeconds = (performance.now() - started) / 1000;
const prefix = MODE === "selfplay" ? `selfplay-shard-${SHARD_INDEX}` : "human-validation";

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUTPUT_DIR, `${prefix}-base.jsonl`),
  baseSamples.map((sample) => JSON.stringify({ ...sample, symmetry: 0 })).join("\n") + "\n",
);
writeFileSync(
  resolve(OUTPUT_DIR, `${prefix}-augmented.jsonl`),
  augmentedSamples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
);

const metadata = {
  schemaVersion: 1,
  stage: "PHASE_1_OWNERSHIP_DATASET",
  mode: MODE,
  split: MODE === "selfplay" ? "TRAIN" : "HUMAN_VALIDATION_ONLY",
  sourceFiles: MODE === "human" ? SOURCE_FILES : [],
  games: gameResults.length,
  shardIndex: SHARD_INDEX,
  budgetMsPerSide: BUDGET_MS,
  equalBudgets: true,
  samplesBeforeAugmentation: baseSamples.length,
  samplesAfterAugmentation: augmentedSamples.length,
  augmentationFactor: 8,
  labelDistribution: distribution,
  baselines: baseline,
  generationSeconds: elapsedSeconds,
  labelContract: {
    ownership: "81 confirmed-territory cells: 0 neutral/unowned, 1 A, 2 B",
    finalMargin: "final confirmed territory A minus B",
    oneLabelRolloutPerGame: true,
    captureSuppressionOnlyInLabelRollout: true,
    captureMoveNotAppliedToLabelState: true,
    gameplayPathChanged: false,
  },
  gamesDetail: gameResults.map((result) => result.game),
};
writeFileSync(resolve(OUTPUT_DIR, `${prefix}-meta.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
