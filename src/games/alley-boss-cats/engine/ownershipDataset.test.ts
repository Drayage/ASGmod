import { describe, expect, it } from "vitest";
import { applyAction, getSafeActions, rankByStaticEval } from "../ai";
import type { AIAction } from "../ai";
import { createInitialState, getLegalMoves, passTurn } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState, Move, Player } from "../types";
import { findBestMoveVeryHard } from "./minimax";
import { planTerritory } from "./territoryPlanner";

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

interface DatasetSample {
  game: number;
  ply: number;
  currentPlayer: Player;
  board: string;
  territoryA: number[];
  territoryB: number[];
  legal: number[];
  remainingA: number;
  remainingB: number;
  consecutivePasses: number;
  lastMove: number;
  teacherAction: number;
  playedAction: number;
  teacherOverridden: boolean;
  finalOwnership: string;
  finalMargin: number;
  finalWinner: Player;
  source: "QUIET_CURRENT_CURRICULUM";
}

type PendingSample = Omit<DatasetSample, "finalOwnership" | "finalMargin" | "finalWinner">;

interface DatasetMetadata {
  games: number;
  samples: number;
  teacherMs: number;
  maxMoves: number;
  warmupMoves: number;
  sampleEvery: number;
  seed: number;
  teacherOverrides: number;
  finalTerritoryCells: number;
  meanAbsoluteFinalMargin: number;
  labelNote: string;
}

const env = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
const runDataset = env.RUN_OWNERSHIP_DATASET === "1";
const datasetDescribe = runDataset ? describe : describe.skip;

function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

const GAMES = envInt("ABC_DATASET_GAMES", 12, 1);
const TEACHER_MS = envInt("ABC_DATASET_TEACHER_MS", 300, 50);
const MAX_MOVES = envInt("ABC_DATASET_MAX_MOVES", 56, 12);
const WARMUP_MOVES = envInt("ABC_DATASET_WARMUP_MOVES", 8, 0);
const SAMPLE_EVERY = envInt("ABC_DATASET_SAMPLE_EVERY", 2, 1);
const BASE_SEED = envInt("ABC_DATASET_SEED", 20260729, 1);

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

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function encodeAction(action: AIAction): number {
  return action.type === "PASS" ? BOARD_SIZE * BOARD_SIZE : action.row * BOARD_SIZE + action.col;
}

function encodeMove(move: Move | undefined): number {
  if (!move || move.type === "PASS") return BOARD_SIZE * BOARD_SIZE;
  return move.row * BOARD_SIZE + move.col;
}

function encodeBoard(state: GameState): string {
  const code = { EMPTY: ".", PLAYER_A: "A", PLAYER_B: "B", NEUTRAL: "N" } as const;
  return state.board.flat().map((cell) => code[cell]).join("");
}

function encodeCoords(coords: Array<{ row: number; col: number }>): number[] {
  return coords.map(({ row, col }) => row * BOARD_SIZE + col);
}

function finalOwnership(state: GameState): string {
  const cells = Array<string>(BOARD_SIZE * BOARD_SIZE).fill(".");
  for (const index of encodeCoords(state.territories.A)) cells[index] = "A";
  for (const index of encodeCoords(state.territories.B)) cells[index] = "B";
  return cells.join("");
}

function uniqueActions(actions: AIAction[]): AIAction[] {
  const seen = new Set<string>();
  const result: AIAction[] = [];
  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function isQuietPlacement(state: GameState, action: AIAction): boolean {
  if (action.type !== "PLACE") return false;
  return applyAction(state, action).winner === null;
}

function chooseCurriculumAction(
  state: GameState,
  player: Player,
  random: () => number,
): { teacherAction: AIAction; playedAction: AIAction } {
  const teacherAction = findBestMoveVeryHard(state, player, TEACHER_MS);
  const { pool } = getSafeActions(state, player);
  const plan = planTerritory(state, player);
  const ranked = rankByStaticEval(state, player, pool);

  const territorial = uniqueActions([...plan.blockingMoves, ...plan.expansionMoves]).filter((action) =>
    isQuietPlacement(state, action),
  );
  const quietRanked = uniqueActions([teacherAction, ...ranked]).filter((action) =>
    isQuietPlacement(state, action),
  );

  if (quietRanked.length === 0) {
    return { teacherAction, playedAction: { type: "PASS" } };
  }

  const teacherQuiet = quietRanked.find((action) => actionKey(action) === actionKey(teacherAction));
  const roll = random();

  // Keep the shipped engine as the main teacher, but deliberately oversample
  // territory answers so the first model does not see capture races only.
  if (teacherQuiet && roll < 0.55) return { teacherAction, playedAction: teacherQuiet };
  if (territorial.length > 0 && roll < 0.85) {
    return {
      teacherAction,
      playedAction: territorial[Math.floor(random() * Math.min(4, territorial.length))],
    };
  }

  const top = Math.min(5, quietRanked.length);
  return {
    teacherAction,
    playedAction: quietRanked[Math.floor(random() * top)],
  };
}

function snapshot(
  game: number,
  state: GameState,
  teacherAction: AIAction,
  playedAction: AIAction,
): PendingSample {
  const lastMove = state.moveHistory[state.moveHistory.length - 1];
  return {
    game,
    ply: state.moveHistory.length,
    currentPlayer: state.currentPlayer,
    board: encodeBoard(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    legal: getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    lastMove: encodeMove(lastMove),
    teacherAction: encodeAction(teacherAction),
    playedAction: encodeAction(playedAction),
    teacherOverridden: actionKey(teacherAction) !== actionKey(playedAction),
    source: "QUIET_CURRENT_CURRICULUM",
  };
}

function forceTerritoryFinish(state: GameState): GameState {
  let current = state;
  for (let i = 0; i < 2 && !current.winner; i += 1) current = passTurn(current);
  if (!current.winner || current.winReason !== "TERRITORY") {
    throw new Error("Quiet curriculum game did not finish by territory");
  }
  return current;
}

function playGame(game: number): { samples: DatasetSample[]; finalState: GameState } {
  const random = mulberry32(BASE_SEED + game * 9973);
  const pending: PendingSample[] = [];
  let state = createInitialState();

  while (!state.winner && state.moveHistory.length < MAX_MOVES) {
    const { teacherAction, playedAction } = chooseCurriculumAction(state, state.currentPlayer, random);
    if (playedAction.type === "PASS") break;

    if (
      state.moveHistory.length >= WARMUP_MOVES &&
      (state.moveHistory.length - WARMUP_MOVES) % SAMPLE_EVERY === 0
    ) {
      pending.push(snapshot(game, state, teacherAction, playedAction));
    }

    state = applyAction(state, playedAction);
  }

  const finalState = forceTerritoryFinish(state);
  const ownership = finalOwnership(finalState);
  const margin =
    finalState.territories.A.length - finalState.territories.B.length - FIRST_PLAYER_MARGIN;
  const winner = finalState.winner as Player;

  return {
    finalState,
    samples: pending.map((sample) => ({
      ...sample,
      finalOwnership: ownership,
      finalMargin: margin,
      finalWinner: winner,
    })),
  };
}

datasetDescribe("ownership learning dataset", () => {
  it(
    "generates quiet CURRENT-guided games with final territory labels",
    () => {
      const samples: DatasetSample[] = [];
      let teacherOverrides = 0;
      let finalTerritoryCells = 0;
      let absoluteMarginTotal = 0;

      for (let game = 1; game <= GAMES; game += 1) {
        const result = playGame(game);
        samples.push(...result.samples);
        teacherOverrides += result.samples.filter((sample) => sample.teacherOverridden).length;
        finalTerritoryCells +=
          result.finalState.territories.A.length + result.finalState.territories.B.length;
        absoluteMarginTotal += Math.abs(
          result.finalState.territories.A.length -
            result.finalState.territories.B.length -
            FIRST_PLAYER_MARGIN,
        );
        console.log(
          `${game}/${GAMES} samples=${result.samples.length} territory=${result.finalState.territories.A.length}:${result.finalState.territories.B.length} winner=${result.finalState.winner}`,
        );
      }

      const metadata: DatasetMetadata = {
        games: GAMES,
        samples: samples.length,
        teacherMs: TEACHER_MS,
        maxMoves: MAX_MOVES,
        warmupMoves: WARMUP_MOVES,
        sampleEvery: SAMPLE_EVERY,
        seed: BASE_SEED,
        teacherOverrides,
        finalTerritoryCells,
        meanAbsoluteFinalMargin: absoluteMarginTotal / GAMES,
        labelNote:
          "Quiet curriculum labels: capture-ending moves are skipped and each game is ended by two forced passes. These labels test whether territory signal is learnable; they are not optimal-play ground truth.",
      };

      console.log(`OWNERSHIP_DATASET_JSON:${JSON.stringify({ metadata, samples })}`);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sample) => sample.finalOwnership.length === BOARD_SIZE * BOARD_SIZE)).toBe(true);
    },
    3_600_000,
  );
});
