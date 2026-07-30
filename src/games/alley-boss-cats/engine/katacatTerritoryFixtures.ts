import { applyAction } from "../ai";
import type { AIAction } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { Coord, GameState, Player } from "../types";
import {
  encodeKataCatAction,
  kataCatStateHash,
  validateKataCatM0Bundle,
} from "./katacatM0";
import type {
  KataCatCoverage,
  KataCatDecisionSource,
  KataCatFinalRecord,
  KataCatGameRecord,
  KataCatLeadBucket,
  KataCatM0Bundle,
  KataCatPhase,
  KataCatSampleRecord,
  KataCatSplit,
  KataCatTerritoryDensity,
} from "./katacatM0";

interface PendingFixtureSample {
  gameId: string;
  gameIndex: number;
  split: KataCatSplit;
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

type CoordTransform = (coord: Coord) => Coord;

const PASS_INDEX = BOARD_SIZE * BOARD_SIZE;

// Both players build legal, non-contacting walls. A finishes a small corner first
// and passes while B finishes a larger corner. The final two recorded passes end
// the game through the normal TERRITORY rule. The large enclosure contains 24
// cells, so M0 always includes genuine high-density territory positions.
const BASE_PLANS: Record<Player, Coord[]> = {
  A: [
    { row: 0, col: 2 },
    { row: 1, col: 2 },
    { row: 2, col: 2 },
    { row: 2, col: 1 },
    { row: 2, col: 0 },
  ],
  B: [
    { row: 8, col: 3 },
    { row: 7, col: 3 },
    { row: 6, col: 3 },
    { row: 5, col: 3 },
    { row: 4, col: 3 },
    { row: 3, col: 3 },
    { row: 3, col: 4 },
    { row: 3, col: 5 },
    { row: 3, col: 6 },
    { row: 3, col: 7 },
    { row: 3, col: 8 },
  ],
};

const TRANSFORMS: CoordTransform[] = [
  ({ row, col }) => ({ row, col }),
  ({ row, col }) => ({ row: BOARD_SIZE - 1 - row, col: BOARD_SIZE - 1 - col }),
  ({ row, col }) => ({ row, col: BOARD_SIZE - 1 - col }),
  ({ row, col }) => ({ row: BOARD_SIZE - 1 - row, col }),
];

function encodeCoord({ row, col }: Coord): number {
  return row * BOARD_SIZE + col;
}

function encodeCoords(coords: Coord[]): number[] {
  return coords.map(encodeCoord).sort((a, b) => a - b);
}

function encodeBoard(state: GameState): string {
  const code = { EMPTY: ".", PLAYER_A: "A", PLAYER_B: "B", NEUTRAL: "N" } as const;
  return state.board.flat().map((cell) => code[cell]).join("");
}

function legalActionIndices(state: GameState): number[] {
  return [...getLegalMoves(state, state.currentPlayer).map(encodeCoord), PASS_INDEX];
}

function lastActionIndex(state: GameState): number {
  const last = state.moveHistory[state.moveHistory.length - 1];
  if (!last || last.type === "PASS") return PASS_INDEX;
  return last.row * BOARD_SIZE + last.col;
}

function finalOwnership(state: GameState): string {
  const ownership = Array<string>(BOARD_SIZE * BOARD_SIZE).fill(".");
  for (const index of encodeCoords(state.territories.A)) ownership[index] = "A";
  for (const index of encodeCoords(state.territories.B)) ownership[index] = "B";
  return ownership.join("");
}

function finalRecord(state: GameState): KataCatFinalRecord {
  if (!state.winner || state.winReason !== "TERRITORY") {
    throw new Error("Scripted territory curriculum did not end by territory");
  }
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

function playerPlacementCount(state: GameState, player: Player): number {
  return state.moveHistory.filter((move) => move.player === player && move.type === "PLACE").length;
}

function transformedPlans(variant: number): Record<Player, Coord[]> {
  const transform = TRANSFORMS[variant % TRANSFORMS.length];
  return {
    A: BASE_PLANS.A.map(transform),
    B: BASE_PLANS.B.map(transform),
  };
}

function scriptedAction(state: GameState, plans: Record<Player, Coord[]>): AIAction {
  const player = state.currentPlayer;
  const index = playerPlacementCount(state, player);
  const coordinate = plans[player][index];
  if (!coordinate) return { type: "PASS" };

  const legal = getLegalMoves(state, player).some(
    ({ row, col }) => row === coordinate.row && col === coordinate.col,
  );
  if (!legal) {
    throw new Error(
      `Territory fixture produced an illegal ${player} move at ${coordinate.row},${coordinate.col}`,
    );
  }
  return { type: "PLACE", row: coordinate.row, col: coordinate.col };
}

function pendingFixtureSample(
  game: KataCatGameRecord,
  state: GameState,
  action: AIAction,
): PendingFixtureSample {
  return {
    gameId: game.gameId,
    gameIndex: game.gameIndex,
    split: game.split,
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
    playedAction: encodeKataCatAction(action),
    policySource: action.type === "PASS" ? "COUNTING_PASS" : "TERRITORY_PREFIX",
  };
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

function buildFixtureSample(
  pending: PendingFixtureSample,
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
    sourceMode: "TERRITORY_CURRICULUM",
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

function buildScriptedTerritoryGame(
  source: KataCatGameRecord,
  variant: number,
): { game: KataCatGameRecord; samples: KataCatSampleRecord[] } {
  const plans = transformedPlans(variant);
  let state = createInitialState();
  const moves: KataCatGameRecord["moves"] = [];
  const pending: PendingFixtureSample[] = [];
  const game: KataCatGameRecord = { ...source, moves: [], final: source.final };

  while (!state.winner) {
    if (state.moveHistory.length >= 40) {
      throw new Error("Territory fixture exceeded its expected move count");
    }
    const action = scriptedAction(state, plans);
    const legalActions = legalActionIndices(state);
    const actionIndex = encodeKataCatAction(action);
    pending.push(pendingFixtureSample(game, state, action));
    moves.push({
      ply: state.moveHistory.length,
      player: state.currentPlayer,
      action,
      actionIndex,
      legalActions,
      preStateHash: kataCatStateHash(state),
      decisionSource: action.type === "PASS" ? "COUNTING_PASS" : "TERRITORY_PREFIX",
    });
    state = applyAction(state, action);
  }

  const final = finalRecord(state);
  const scriptedGame: KataCatGameRecord = {
    schemaVersion: 1,
    gameId: source.gameId,
    gameIndex: source.gameIndex,
    seed: source.seed,
    sourceMode: "TERRITORY_CURRICULUM",
    split: source.split,
    teacherMs: source.teacherMs,
    maxMoves: source.maxMoves,
    naturalTerminal: true,
    moves,
    final,
  };
  return {
    game: scriptedGame,
    samples: pending.map((sample) => buildFixtureSample(sample, final, moves.length)),
  };
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

function summarizeCoverage(
  games: KataCatGameRecord[],
  samples: KataCatSampleRecord[],
): KataCatCoverage {
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
    const key = `${sample.split}|${sample.bucketKey}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(sample);
    buckets.set(key, bucket);
  }

  const selected: KataCatSampleRecord[] = [];
  for (const [key, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keySeed = [...key].reduce(
      (value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619),
      seed,
    );
    selected.push(...deterministicShuffle(bucket, keySeed).slice(0, maxPerBucket));
  }
  return selected.sort((a, b) => a.gameIndex - b.gameIndex || a.ply - b.ply);
}

export function replaceTerritoryCurriculumWithFixtures(
  bundle: KataCatM0Bundle,
): KataCatM0Bundle {
  const territoryGames = bundle.games.filter(
    (game) => game.sourceMode === "TERRITORY_CURRICULUM",
  );
  if (territoryGames.length === 0) return bundle;

  const replacements = new Map<string, ReturnType<typeof buildScriptedTerritoryGame>>();
  territoryGames.forEach((game, index) => {
    replacements.set(game.gameId, buildScriptedTerritoryGame(game, index));
  });

  const games = bundle.games.map((game) => replacements.get(game.gameId)?.game ?? game);
  const untouchedSamples = bundle.samples.filter((sample) => !replacements.has(sample.gameId));
  const fixtureSamples = [...replacements.values()].flatMap((replacement) => replacement.samples);
  const samples = balanceSamples(
    [...untouchedSamples, ...fixtureSamples],
    bundle.metadata.options.maxSamplesPerBucket,
    bundle.metadata.options.seed,
  );
  const coverage = summarizeCoverage(games, samples);

  let updated: KataCatM0Bundle = {
    games,
    samples,
    metadata: {
      ...bundle.metadata,
      generatedGames: games.length,
      generatedSamples: samples.length,
      coverage,
      notes: [
        ...bundle.metadata.notes,
        "TERRITORY_CURRICULUM games use replayable legal wall-building fixtures so both territory endings and 13+ cell states are guaranteed without synthetic labels.",
      ],
    },
  };
  updated = {
    ...updated,
    metadata: {
      ...updated.metadata,
      acceptance: validateKataCatM0Bundle(updated),
    },
  };
  return updated;
}
