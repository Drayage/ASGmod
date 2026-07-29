import {
  applyAction,
  getSafeActions,
  rankByStaticEval,
} from "../ai";
import type { AIAction } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { Coord, GameState, Player, WinReason } from "../types";
import { findBestMoveVeryHard } from "./minimax";
import { planTerritory } from "./territoryPlanner";

export type KataCatSourceMode =
  | "CURRENT_SELFPLAY"
  | "NOISY_CURRENT"
  | "RANDOM_MIDGAME"
  | "TERRITORY_CURRICULUM";

export type KataCatDecisionSource =
  | "CURRENT"
  | "NOISY_CURRENT"
  | "RANDOM_PREFIX"
  | "TERRITORY_PREFIX"
  | "COUNTING_PASS";

export type KataCatSplit = "train" | "validation";
export type KataCatPhase = "EARLY" | "MIDDLE" | "LATE";
export type KataCatTerritoryDensity = "LOW_0_4" | "MID_5_12" | "HIGH_13_PLUS";
export type KataCatLeadBucket = "A_LEAD" | "EVEN" | "B_LEAD";

export interface KataCatM0Options {
  games: number;
  teacherMs: number;
  maxMoves: number;
  seed: number;
  maxSamplesPerBucket: number;
  noisyRate: number;
  territoryPassPly: number;
}

export interface KataCatMoveRecord {
  ply: number;
  player: Player;
  action: AIAction;
  actionIndex: number;
  legalActions: number[];
  preStateHash: string;
  decisionSource: KataCatDecisionSource;
  teacherAction?: AIAction;
}

export interface KataCatFinalRecord {
  winner: Player;
  winReason: Exclude<WinReason, null>;
  board: string;
  stateHash: string;
  territoryA: number[];
  territoryB: number[];
  ownership: string;
  adjustedMarginA: number;
}

export interface KataCatGameRecord {
  schemaVersion: 1;
  gameId: string;
  gameIndex: number;
  seed: number;
  sourceMode: KataCatSourceMode;
  split: KataCatSplit;
  teacherMs: number;
  maxMoves: number;
  naturalTerminal: true;
  moves: KataCatMoveRecord[];
  final: KataCatFinalRecord;
}

export interface KataCatSampleRecord {
  schemaVersion: 1;
  sampleId: string;
  gameId: string;
  gameIndex: number;
  split: KataCatSplit;
  sourceMode: KataCatSourceMode;
  ply: number;
  phase: KataCatPhase;
  resultType: Exclude<WinReason, null>;
  territoryDensity: KataCatTerritoryDensity;
  leadBucket: KataCatLeadBucket;
  bucketKey: string;
  stateHash: string;
  board: string;
  currentPlayer: Player;
  legalActions: number[];
  territoryA: number[];
  territoryB: number[];
  remainingA: number;
  remainingB: number;
  consecutivePasses: number;
  lastAction: number;
  policyTarget: Array<{ action: number; visits: number }>;
  policySource: KataCatDecisionSource;
  finalWinner: Player;
  finalWinReason: Exclude<WinReason, null>;
  finalAdjustedMarginA: number;
  finalOwnership: string;
}

export interface KataCatCoverage {
  sourceModes: Record<KataCatSourceMode, number>;
  resultTypes: Record<Exclude<WinReason, null>, number>;
  phases: Record<KataCatPhase, number>;
  territoryDensity: Record<KataCatTerritoryDensity, number>;
  leadBuckets: Record<KataCatLeadBucket, number>;
  splits: Record<KataCatSplit, number>;
  compositeBuckets: Record<string, number>;
}

export interface KataCatAcceptance {
  replayVerified: boolean;
  exactFinalLabels: boolean;
  naturalTerminalsOnly: boolean;
  splitDisjoint: boolean;
  hasAllSourceModes: boolean;
  hasCaptureAndTerritory: boolean;
  hasAllPhases: boolean;
  hasAllTerritoryDensities: boolean;
  passed: boolean;
}

export interface KataCatM0Metadata {
  schemaVersion: 1;
  options: KataCatM0Options;
  generatedGames: number;
  generatedSamples: number;
  discardedNonTerminalGames: number;
  coverage: KataCatCoverage;
  acceptance: KataCatAcceptance;
  notes: string[];
}

export interface KataCatM0Bundle {
  metadata: KataCatM0Metadata;
  games: KataCatGameRecord[];
  samples: KataCatSampleRecord[];
}

interface PendingSample {
  gameId: string;
  gameIndex: number;
  split: KataCatSplit;
  sourceMode: KataCatSourceMode;
  ply: number;
  stateHash: string;
  board: string;
  currentPlayer: Player;
  legalActions: number[];
  territoryA: number[];
  territoryB: number[];
  remainingA: number;
  remainingB: number;
  consecutivePasses: number;
  lastAction: number;
  playedAction: number;
  policySource: KataCatDecisionSource;
}

const MODE_CYCLE: KataCatSourceMode[] = [
  "CURRENT_SELFPLAY",
  "NOISY_CURRENT",
  "RANDOM_MIDGAME",
  "TERRITORY_CURRICULUM",
  "CURRENT_SELFPLAY",
  "NOISY_CURRENT",
  "CURRENT_SELFPLAY",
  "RANDOM_MIDGAME",
  "TERRITORY_CURRICULUM",
  "CURRENT_SELFPLAY",
  "NOISY_CURRENT",
  "RANDOM_MIDGAME",
  "CURRENT_SELFPLAY",
  "NOISY_CURRENT",
  "TERRITORY_CURRICULUM",
  "CURRENT_SELFPLAY",
  "RANDOM_MIDGAME",
  "NOISY_CURRENT",
  "CURRENT_SELFPLAY",
  "CURRENT_SELFPLAY",
];

const PASS_INDEX = BOARD_SIZE * BOARD_SIZE;

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeCoord({ row, col }: Coord): number {
  return row * BOARD_SIZE + col;
}

export function encodeKataCatAction(action: AIAction): number {
  return action.type === "PASS" ? PASS_INDEX : action.row * BOARD_SIZE + action.col;
}

function encodeBoard(state: GameState): string {
  const code = { EMPTY: ".", PLAYER_A: "A", PLAYER_B: "B", NEUTRAL: "N" } as const;
  return state.board.flat().map((cell) => code[cell]).join("");
}

function encodeCoords(coords: Coord[]): number[] {
  return coords.map(encodeCoord).sort((a, b) => a - b);
}

function legalActionIndices(state: GameState): number[] {
  return [...getLegalMoves(state, state.currentPlayer).map(encodeCoord), PASS_INDEX];
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function sameAction(a: AIAction, b: AIAction): boolean {
  return actionKey(a) === actionKey(b);
}

function lastActionIndex(state: GameState): number {
  const last = state.moveHistory.at(-1);
  if (!last || last.type === "PASS") return PASS_INDEX;
  return last.row * BOARD_SIZE + last.col;
}

export function kataCatStateHash(state: GameState): string {
  return [
    encodeBoard(state),
    state.currentPlayer,
    state.remainingCats.A,
    state.remainingCats.B,
    state.consecutivePasses,
    encodeCoords(state.territories.A).join(","),
    encodeCoords(state.territories.B).join(","),
    state.winner ?? "-",
    state.winReason ?? "-",
    state.moveHistory.length,
  ].join("|");
}

function finalOwnership(state: GameState): string {
  const ownership = Array<string>(BOARD_SIZE * BOARD_SIZE).fill(".");
  for (const index of encodeCoords(state.territories.A)) ownership[index] = "A";
  for (const index of encodeCoords(state.territories.B)) ownership[index] = "B";
  return ownership.join("");
}

function finalRecord(state: GameState): KataCatFinalRecord {
  if (!state.winner || !state.winReason) throw new Error("Cannot label a non-terminal game");
  return {
    winner: state.winner,
    winReason: state.winReason,
    board: encodeBoard(state),
    stateHash: kataCatStateHash(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    ownership: finalOwnership(state),
    adjustedMarginA:
      state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN,
  };
}

function splitForGame(gameIndex: number): KataCatSplit {
  return gameIndex % 5 === 0 ? "validation" : "train";
}

function phaseFor(ply: number, totalMoves: number): KataCatPhase {
  const progress = totalMoves <= 1 ? 1 : ply / totalMoves;
  if (progress < 1 / 3) return "EARLY";
  if (progress < 2 / 3) return "MIDDLE";
  return "LATE";
}

function densityFor(totalTerritory: number): KataCatTerritoryDensity {
  if (totalTerritory <= 4) return "LOW_0_4";
  if (totalTerritory <= 12) return "MID_5_12";
  return "HIGH_13_PLUS";
}

function leadFor(territoryA: number, territoryB: number): KataCatLeadBucket {
  const margin = territoryA - territoryB - FIRST_PLAYER_MARGIN;
  if (margin >= 2) return "A_LEAD";
  if (margin <= -2) return "B_LEAD";
  return "EVEN";
}

function nonTerminalPlacements(state: GameState, actions: AIAction[]): AIAction[] {
  return actions.filter((action) => {
    if (action.type !== "PLACE") return false;
    return applyAction(state, action).winner === null;
  });
}

function chooseRandom<T>(items: T[], random: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(random() * items.length)];
}

function choosePrefixAction(
  state: GameState,
  mode: KataCatSourceMode,
  random: () => number,
): { action: AIAction; source: KataCatDecisionSource } | null {
  const { winningMove, pool } = getSafeActions(state, state.currentPlayer);
  if (winningMove) return { action: winningMove, source: "CURRENT" };

  if (mode === "RANDOM_MIDGAME") {
    const ranked = nonTerminalPlacements(
      state,
      rankByStaticEval(state, state.currentPlayer, pool).slice(0, 14),
    );
    const action = chooseRandom(ranked, random);
    return action ? { action, source: "RANDOM_PREFIX" } : null;
  }

  if (mode === "TERRITORY_CURRICULUM") {
    const plan = planTerritory(state, state.currentPlayer);
    const wanted = nonTerminalPlacements(
      state,
      [...plan.blockingMoves, ...plan.expansionMoves],
    );
    const territorial = chooseRandom(wanted.slice(0, 6), random);
    if (territorial) return { action: territorial, source: "TERRITORY_PREFIX" };

    const ranked = nonTerminalPlacements(
      state,
      rankByStaticEval(state, state.currentPlayer, pool).slice(0, 8),
    );
    const fallback = chooseRandom(ranked, random);
    return fallback ? { action: fallback, source: "TERRITORY_PREFIX" } : null;
  }

  return null;
}

function countPlacements(state: GameState): number {
  return state.moveHistory.filter((move) => move.type === "PLACE").length;
}

function chooseMove(
  state: GameState,
  mode: KataCatSourceMode,
  teacherMs: number,
  noisyRate: number,
  territoryPassPly: number,
  prefixLength: number,
  random: () => number,
): { action: AIAction; source: KataCatDecisionSource; teacherAction?: AIAction } {
  if (state.moveHistory.length < prefixLength) {
    const prefix = choosePrefixAction(state, mode, random);
    if (prefix) return prefix;
  }

  const safe = getSafeActions(state, state.currentPlayer);
  if (safe.winningMove) {
    return { action: safe.winningMove, source: "CURRENT", teacherAction: safe.winningMove };
  }

  if (
    mode === "TERRITORY_CURRICULUM" &&
    countPlacements(state) >= territoryPassPly &&
    safe.pool.some((action) => action.type === "PASS")
  ) {
    return { action: { type: "PASS" }, source: "COUNTING_PASS" };
  }

  const teacherAction = findBestMoveVeryHard(state, state.currentPlayer, teacherMs);
  if (mode !== "NOISY_CURRENT" || random() >= noisyRate) {
    return { action: teacherAction, source: "CURRENT", teacherAction };
  }

  const alternatives = rankByStaticEval(state, state.currentPlayer, safe.pool)
    .slice(0, 5)
    .filter((action) => !sameAction(action, teacherAction));
  const noisyAction = chooseRandom(alternatives, random) ?? teacherAction;
  return { action: noisyAction, source: "NOISY_CURRENT", teacherAction };
}

function pendingSample(
  gameId: string,
  gameIndex: number,
  split: KataCatSplit,
  sourceMode: KataCatSourceMode,
  state: GameState,
  playedAction: AIAction,
  policySource: KataCatDecisionSource,
): PendingSample {
  return {
    gameId,
    gameIndex,
    split,
    sourceMode,
    ply: state.moveHistory.length,
    stateHash: kataCatStateHash(state),
    board: encodeBoard(state),
    currentPlayer: state.currentPlayer,
    legalActions: legalActionIndices(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    lastAction: lastActionIndex(state),
    playedAction: encodeKataCatAction(playedAction),
    policySource,
  };
}

function buildSample(
  pending: PendingSample,
  final: KataCatFinalRecord,
  totalMoves: number,
): KataCatSampleRecord {
  const phase = phaseFor(pending.ply, totalMoves);
  const territoryDensity = densityFor(pending.territoryA.length + pending.territoryB.length);
  const leadBucket = leadFor(pending.territoryA.length, pending.territoryB.length);
  const bucketKey = [phase, final.winReason, territoryDensity, leadBucket].join("|");
  return {
    schemaVersion: 1,
    sampleId: `${pending.gameId}:p${pending.ply}`,
    gameId: pending.gameId,
    gameIndex: pending.gameIndex,
    split: pending.split,
    sourceMode: pending.sourceMode,
    ply: pending.ply,
    phase,
    resultType: final.winReason,
    territoryDensity,
    leadBucket,
    bucketKey,
    stateHash: pending.stateHash,
    board: pending.board,
    currentPlayer: pending.currentPlayer,
    legalActions: pending.legalActions,
    territoryA: pending.territoryA,
    territoryB: pending.territoryB,
    remainingA: pending.remainingA,
    remainingB: pending.remainingB,
    consecutivePasses: pending.consecutivePasses,
    lastAction: pending.lastAction,
    policyTarget: [{ action: pending.playedAction, visits: 1 }],
    policySource: pending.policySource,
    finalWinner: final.winner,
    finalWinReason: final.winReason,
    finalAdjustedMarginA: final.adjustedMarginA,
    finalOwnership: final.ownership,
  };
}

function replayGame(game: KataCatGameRecord): Map<number, string> {
  let state = createInitialState();
  const hashes = new Map<number, string>();
  for (const move of game.moves) {
    hashes.set(move.ply, kataCatStateHash(state));
    if (state.currentPlayer !== move.player) {
      throw new Error(`${game.gameId} ply ${move.ply}: player mismatch`);
    }
    if (kataCatStateHash(state) !== move.preStateHash) {
      throw new Error(`${game.gameId} ply ${move.ply}: pre-state hash mismatch`);
    }
    if (!move.legalActions.includes(move.actionIndex)) {
      throw new Error(`${game.gameId} ply ${move.ply}: recorded action not in legal mask`);
    }
    state = applyAction(state, move.action);
  }

  const replayedFinal = finalRecord(state);
  if (JSON.stringify(replayedFinal) !== JSON.stringify(game.final)) {
    throw new Error(`${game.gameId}: final state differs after replay`);
  }
  return hashes;
}

function emptyCoverage(): KataCatCoverage {
  return {
    sourceModes: {
      CURRENT_SELFPLAY: 0,
      NOISY_CURRENT: 0,
      RANDOM_MIDGAME: 0,
      TERRITORY_CURRICULUM: 0,
    },
    resultTypes: { CAPTURE: 0, TERRITORY: 0 },
    phases: { EARLY: 0, MIDDLE: 0, LATE: 0 },
    territoryDensity: { LOW_0_4: 0, MID_5_12: 0, HIGH_13_PLUS: 0 },
    leadBuckets: { A_LEAD: 0, EVEN: 0, B_LEAD: 0 },
    splits: { train: 0, validation: 0 },
    compositeBuckets: {},
  };
}

function summarizeCoverage(games: KataCatGameRecord[], samples: KataCatSampleRecord[]): KataCatCoverage {
  const coverage = emptyCoverage();
  for (const game of games) {
    coverage.sourceModes[game.sourceMode] += 1;
    coverage.resultTypes[game.final.winReason] += 1;
  }
  for (const sample of samples) {
    coverage.phases[sample.phase] += 1;
    coverage.territoryDensity[sample.territoryDensity] += 1;
    coverage.leadBuckets[sample.leadBucket] += 1;
    coverage.splits[sample.split] += 1;
    coverage.compositeBuckets[sample.bucketKey] =
      (coverage.compositeBuckets[sample.bucketKey] ?? 0) + 1;
  }
  return coverage;
}

function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function balanceSamples(
  samples: KataCatSampleRecord[],
  maxPerBucket: number,
  seed: number,
): KataCatSampleRecord[] {
  const buckets = new Map<string, KataCatSampleRecord[]>();
  for (const sample of samples) {
    const splitBucket = `${sample.split}|${sample.bucketKey}`;
    const current = buckets.get(splitBucket) ?? [];
    current.push(sample);
    buckets.set(splitBucket, current);
  }

  const selected: KataCatSampleRecord[] = [];
  for (const [key, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keySeed = [...key].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619), seed);
    selected.push(...deterministicShuffle(bucket, keySeed).slice(0, maxPerBucket));
  }
  return selected.sort((a, b) => a.gameIndex - b.gameIndex || a.ply - b.ply);
}

function acceptanceFor(
  games: KataCatGameRecord[],
  samples: KataCatSampleRecord[],
  coverage: KataCatCoverage,
): KataCatAcceptance {
  let replayVerified = true;
  let exactFinalLabels = true;
  const replayHashes = new Map<string, Map<number, string>>();
  try {
    for (const game of games) replayHashes.set(game.gameId, replayGame(game));
  } catch {
    replayVerified = false;
  }

  for (const sample of samples) {
    const game = games.find((candidate) => candidate.gameId === sample.gameId);
    const hashes = replayHashes.get(sample.gameId);
    if (
      !game ||
      !hashes ||
      hashes.get(sample.ply) !== sample.stateHash ||
      sample.finalWinner !== game.final.winner ||
      sample.finalWinReason !== game.final.winReason ||
      sample.finalAdjustedMarginA !== game.final.adjustedMarginA ||
      sample.finalOwnership !== game.final.ownership
    ) {
      exactFinalLabels = false;
      break;
    }
  }

  const trainGames = new Set(samples.filter((sample) => sample.split === "train").map((sample) => sample.gameId));
  const validationGames = new Set(
    samples.filter((sample) => sample.split === "validation").map((sample) => sample.gameId),
  );
  const splitDisjoint = [...trainGames].every((gameId) => !validationGames.has(gameId));
  const naturalTerminalsOnly = games.every((game) => game.naturalTerminal && game.final.winReason !== null);
  const hasAllSourceModes = Object.values(coverage.sourceModes).every((count) => count > 0);
  const hasCaptureAndTerritory = Object.values(coverage.resultTypes).every((count) => count > 0);
  const hasAllPhases = Object.values(coverage.phases).every((count) => count > 0);
  const hasAllTerritoryDensities = Object.values(coverage.territoryDensity).every((count) => count > 0);

  const acceptance: KataCatAcceptance = {
    replayVerified,
    exactFinalLabels,
    naturalTerminalsOnly,
    splitDisjoint,
    hasAllSourceModes,
    hasCaptureAndTerritory,
    hasAllPhases,
    hasAllTerritoryDensities,
    passed: false,
  };
  acceptance.passed = Object.entries(acceptance)
    .filter(([key]) => key !== "passed")
    .every(([, value]) => value);
  return acceptance;
}

export function validateKataCatM0Bundle(bundle: KataCatM0Bundle): KataCatAcceptance {
  const coverage = summarizeCoverage(bundle.games, bundle.samples);
  return acceptanceFor(bundle.games, bundle.samples, coverage);
}

export function generateKataCatM0(options: KataCatM0Options): KataCatM0Bundle {
  const games: KataCatGameRecord[] = [];
  const rawSamples: KataCatSampleRecord[] = [];
  let discardedNonTerminalGames = 0;
  let attempt = 0;
  const maxAttempts = Math.max(options.games * 3, options.games + 4);

  while (games.length < options.games && attempt < maxAttempts) {
    const gameIndex = games.length + 1;
    const sourceMode = MODE_CYCLE[(gameIndex - 1) % MODE_CYCLE.length];
    const gameSeed = options.seed + attempt * 104729;
    const random = mulberry32(gameSeed);
    const gameId = `katacat-${options.seed}-g${gameIndex}-a${attempt}`;
    const split = splitForGame(gameIndex);
    const prefixLength =
      sourceMode === "RANDOM_MIDGAME"
        ? 6 + Math.floor(random() * 9)
        : sourceMode === "TERRITORY_CURRICULUM"
          ? 10 + Math.floor(random() * 11)
          : 0;

    let state = createInitialState();
    const moveRecords: KataCatMoveRecord[] = [];
    const pending: PendingSample[] = [];

    while (!state.winner && state.moveHistory.length < options.maxMoves) {
      const decision = chooseMove(
        state,
        sourceMode,
        options.teacherMs,
        options.noisyRate,
        options.territoryPassPly,
        prefixLength,
        random,
      );
      const legalActions = legalActionIndices(state);
      const actionIndex = encodeKataCatAction(decision.action);
      if (!legalActions.includes(actionIndex)) {
        throw new Error(`${gameId}: engine returned illegal action ${actionKey(decision.action)}`);
      }

      pending.push(
        pendingSample(
          gameId,
          gameIndex,
          split,
          sourceMode,
          state,
          decision.action,
          decision.source,
        ),
      );
      moveRecords.push({
        ply: state.moveHistory.length,
        player: state.currentPlayer,
        action: decision.action,
        actionIndex,
        legalActions,
        preStateHash: kataCatStateHash(state),
        decisionSource: decision.source,
        teacherAction: decision.teacherAction,
      });
      state = applyAction(state, decision.action);
    }

    attempt += 1;
    if (!state.winner || !state.winReason) {
      discardedNonTerminalGames += 1;
      continue;
    }

    const final = finalRecord(state);
    const game: KataCatGameRecord = {
      schemaVersion: 1,
      gameId,
      gameIndex,
      seed: gameSeed,
      sourceMode,
      split,
      teacherMs: options.teacherMs,
      maxMoves: options.maxMoves,
      naturalTerminal: true,
      moves: moveRecords,
      final,
    };
    replayGame(game);
    games.push(game);
    rawSamples.push(...pending.map((sample) => buildSample(sample, final, moveRecords.length)));
  }

  if (games.length < options.games) {
    throw new Error(`Generated only ${games.length}/${options.games} naturally terminal games`);
  }

  const samples = balanceSamples(rawSamples, options.maxSamplesPerBucket, options.seed);
  const coverage = summarizeCoverage(games, samples);
  const acceptance = acceptanceFor(games, samples, coverage);
  const metadata: KataCatM0Metadata = {
    schemaVersion: 1,
    options,
    generatedGames: games.length,
    generatedSamples: samples.length,
    discardedNonTerminalGames,
    coverage,
    acceptance,
    notes: [
      "Every label comes from a rules-engine terminal state reached by recorded legal actions.",
      "TERRITORY_CURRICULUM may choose PASS as an agent policy after the configured placement threshold; no post-hoc forced pass is applied.",
      "Policy targets are one-visit bootstrap labels until PUCT visit distributions exist in M2.",
      "Composite bucket caps reduce over-representation; sparse buckets are reported rather than synthetically relabelled.",
    ],
  };
  return { metadata, games, samples };
}
