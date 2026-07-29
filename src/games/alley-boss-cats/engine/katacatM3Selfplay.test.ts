// @ts-nocheck -- Opt-in self-play integration test uses Node process and filesystem APIs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction, getSafeActions } from "../ai";
import type { AIAction } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState, Player } from "../types";
import { kataCatStateHash } from "./katacatM0";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type {
  KataCatNeuralEvaluation,
  KataCatNeuralEvaluator,
  KataCatVisitRecord,
} from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M3_SELFPLAY === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function envFloat(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseFloat(env[name] ?? "");
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
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

function normalSample(random: () => number): number {
  const u1 = Math.max(1e-12, random());
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gammaSample(alpha: number, random: () => number): number {
  if (alpha <= 0) throw new Error("Dirichlet alpha must be positive");
  if (alpha < 1) {
    return gammaSample(alpha + 1, random) * Math.pow(Math.max(1e-12, random()), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normalSample(random);
    const base = 1 + c * x;
    if (base <= 0) continue;
    const v = base * base * base;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(1e-12, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

function dirichlet(size: number, alpha: number, random: () => number): number[] {
  const values = Array.from({ length: size }, () => gammaSample(alpha, random));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

function encodeBoard(state: GameState): string {
  const code = { EMPTY: ".", PLAYER_A: "A", PLAYER_B: "B", NEUTRAL: "N" } as const;
  return state.board.flat().map((cell) => code[cell]).join("");
}

function encodeCoords(coords: Array<{ row: number; col: number }>): number[] {
  return coords.map(({ row, col }) => row * BOARD_SIZE + col).sort((a, b) => a - b);
}

function legalActions(state: GameState): number[] {
  return [
    ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
    KATACAT_PASS_INDEX,
  ];
}

function lastAction(state: GameState): number {
  const move = state.moveHistory[state.moveHistory.length - 1];
  if (!move || move.type === "PASS") return KATACAT_PASS_INDEX;
  return move.row * BOARD_SIZE + move.col;
}

function inferenceRequest(state: GameState) {
  return {
    board: encodeBoard(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    legalActions: legalActions(state),
    currentPlayer: state.currentPlayer,
    lastAction: lastAction(state),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    ply: state.moveHistory.length,
  };
}

function finalOwnership(state: GameState): string {
  const ownership = Array<string>(BOARD_CELLS).fill(".");
  for (const index of encodeCoords(state.territories.A)) ownership[index] = "A";
  for (const index of encodeCoords(state.territories.B)) ownership[index] = "B";
  return ownership.join("");
}

class PythonCheckpointEvaluator implements KataCatNeuralEvaluator {
  child;
  lines;
  pending = [];
  stderr = "";
  ready;
  resolveReady;
  rejectReady;

  constructor(checkpoint: string) {
    const python = env.PYTHON ?? "python";
    this.child = spawn(
      python,
      ["ml/katacat_m1_infer.py", `--checkpoint=${checkpoint}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on("error", (error) => {
      this.rejectReady(error);
      for (const pending of this.pending.splice(0)) pending.reject(error);
    });
    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const error = new Error(`KataCat Python evaluator exited ${code}: ${this.stderr}`);
        this.rejectReady(error);
        for (const pending of this.pending.splice(0)) pending.reject(error);
      }
    });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.ready) {
        this.resolveReady();
        return;
      }
      const pending = this.pending.shift();
      if (!pending) return;
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message);
    });
  }

  async evaluate(state: GameState): Promise<KataCatNeuralEvaluation> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(inferenceRequest(state))}\n`);
    });
  }

  async close(): Promise<void> {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}

class RootNoiseEvaluator implements KataCatNeuralEvaluator {
  private first = true;

  constructor(
    private readonly base: KataCatNeuralEvaluator,
    private readonly random: () => number,
    private readonly alpha: number,
    private readonly fraction: number,
  ) {}

  async evaluate(state: GameState): Promise<KataCatNeuralEvaluation> {
    const evaluation = await this.base.evaluate(state);
    if (!this.first || this.fraction <= 0) return evaluation;
    this.first = false;

    const indices = legalActions(state);
    const logits = [...evaluation.policyLogits];
    const maximum = Math.max(...indices.map((index) => logits[index]));
    const exponentials = indices.map((index) => Math.exp(logits[index] - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const priors = exponentials.map((value) => value / total);
    const noise = dirichlet(indices.length, this.alpha, this.random);
    indices.forEach((actionIndex, index) => {
      const mixed = (1 - this.fraction) * priors[index] + this.fraction * noise[index];
      logits[actionIndex] = Math.log(Math.max(1e-12, mixed));
    });
    return { ...evaluation, policyLogits: logits };
  }
}

function chooseByVisits(records: KataCatVisitRecord[], random: () => number): AIAction {
  const positive = records.filter((record) => record.visits > 0);
  if (positive.length === 0) throw new Error("Cannot sample an empty PUCT visit distribution");
  const total = positive.reduce((sum, record) => sum + record.visits, 0);
  let cursor = random() * total;
  for (const record of positive) {
    cursor -= record.visits;
    if (cursor <= 0) return record.action;
  }
  return positive[positive.length - 1].action;
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function replayGame(game): void {
  let state = createInitialState();
  for (const move of game.moves) {
    if (state.currentPlayer !== move.player) {
      throw new Error(`${game.gameId} ply ${move.ply}: player mismatch`);
    }
    if (kataCatStateHash(state) !== move.preStateHash) {
      throw new Error(`${game.gameId} ply ${move.ply}: pre-state hash mismatch`);
    }
    if (!move.legalActions.includes(move.actionIndex)) {
      throw new Error(`${game.gameId} ply ${move.ply}: action missing from legal mask`);
    }
    state = applyAction(state, move.action);
  }
  if (
    !state.winner ||
    state.winner !== game.finalWinner ||
    state.winReason !== game.finalWinReason ||
    kataCatStateHash(state) !== game.finalStateHash ||
    finalOwnership(state) !== game.finalOwnership
  ) {
    throw new Error(`${game.gameId}: replayed final state differs`);
  }
}

suite("KataCat M3 PUCT self-play generation", () => {
  let evaluator: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M3_BOOTSTRAP_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M3_BOOTSTRAP_CHECKPOINT is required");
    evaluator = new PythonCheckpointEvaluator(checkpoint);
    await evaluator.ready;
  }, 120_000);

  afterAll(async () => {
    await evaluator?.close();
  });

  it(
    "writes naturally terminal replayable games with PUCT visit targets",
    async () => {
      const requestedGames = envInt("KATACAT_M3_GAMES", 4, 2);
      const simulations = envInt("KATACAT_M3_SIMULATIONS", 64, 8);
      const maxMoves = envInt("KATACAT_M3_MAX_MOVES", 90, 20);
      const temperatureMoves = envInt("KATACAT_M3_TEMPERATURE_MOVES", 12, 0);
      const seed = envInt("KATACAT_M3_SEED", 20260730, 1);
      const cpuct = envFloat("KATACAT_M3_CPUCT", 1.35, 0, 10);
      const neuralPriorWeight = envFloat("KATACAT_M3_NEURAL_PRIOR_WEIGHT", 0.75, 0, 1);
      const scoreValueWeight = envFloat("KATACAT_M3_SCORE_VALUE_WEIGHT", 0.05, 0, 1);
      const noiseAlpha = envFloat("KATACAT_M3_NOISE_ALPHA", 0.3, 0.01, 10);
      const noiseFraction = envFloat("KATACAT_M3_NOISE_FRACTION", 0.25, 0, 1);
      const outputDir = resolve(env.KATACAT_M3_OUTPUT_DIR ?? "katacat-m3-output");

      const games = [];
      const samples = [];
      let discardedNonTerminalGames = 0;
      let searchPositions = 0;
      let temperatureSelections = 0;
      let rootNoiseApplications = 0;
      let exactVisitAccounting = true;
      let illegalVisitsZero = true;
      let attempt = 0;
      const maxAttempts = requestedGames * 5;

      while (games.length < requestedGames && attempt < maxAttempts) {
        const gameIndex = games.length + 1;
        const gameSeed = seed + attempt * 104729;
        const gameRandom = mulberry32(gameSeed);
        const gameId = `katacat-m3-${seed}-g${gameIndex}-a${attempt}`;
        const split = gameIndex % 4 === 0 ? "validation" : "train";
        let state = createInitialState();
        const pending = [];
        const moves = [];

        while (!state.winner && state.moveHistory.length < maxMoves) {
          const ply = state.moveHistory.length;
          const searchRandom = mulberry32(gameSeed ^ Math.imul(ply + 1, 0x9e3779b1));
          const noisyEvaluator = new RootNoiseEvaluator(
            evaluator,
            searchRandom,
            noiseAlpha,
            noiseFraction,
          );
          const result = await searchKataCatPuct(state, noisyEvaluator, {
            simulations,
            cpuct,
            neuralPriorWeight,
            scoreValueWeight,
          });

          const safeIndices = new Set(
            getSafeActions(state, state.currentPlayer).pool.map(encodeKataCatPuctAction),
          );
          if (result.visitDistribution.some((record) => !safeIndices.has(record.actionIndex))) {
            illegalVisitsZero = false;
          }
          const visitTotal = result.visitDistribution.reduce(
            (sum, record) => sum + record.visits,
            0,
          );
          if (
            (result.reason === "SEARCH" && visitTotal !== simulations) ||
            (result.reason === "IMMEDIATE_WIN" && visitTotal !== 1)
          ) {
            exactVisitAccounting = false;
          }

          if (result.reason === "SEARCH") {
            searchPositions += 1;
            if (noiseFraction > 0) rootNoiseApplications += 1;
          }
          const action =
            result.reason === "SEARCH" && ply < temperatureMoves
              ? chooseByVisits(result.visitDistribution, gameRandom)
              : result.action;
          if (result.reason === "SEARCH" && ply < temperatureMoves) temperatureSelections += 1;

          const actionIndex = encodeKataCatPuctAction(action);
          const rootVisits = result.visitDistribution.filter((record) => record.visits > 0);
          if (!rootVisits.some((record) => record.actionIndex === actionIndex)) {
            throw new Error(`${gameId} ply ${ply}: selected action has zero visits`);
          }
          const legal = legalActions(state);
          if (!legal.includes(actionIndex)) {
            throw new Error(`${gameId} ply ${ply}: selected illegal action ${actionKey(action)}`);
          }

          pending.push({
            schemaVersion: 1,
            sampleId: `${gameId}:p${ply}`,
            gameId,
            gameIndex,
            split,
            sourceMode: "PUCT_SELFPLAY",
            ply,
            board: encodeBoard(state),
            currentPlayer: state.currentPlayer,
            legalActions: legal,
            territoryA: encodeCoords(state.territories.A),
            territoryB: encodeCoords(state.territories.B),
            remainingA: state.remainingCats.A,
            remainingB: state.remainingCats.B,
            consecutivePasses: state.consecutivePasses,
            lastAction: lastAction(state),
            policyTarget: rootVisits.map((record) => ({
              action: record.actionIndex,
              visits: record.visits,
            })),
            policySource: "PUCT_VISITS",
          });
          moves.push({
            ply,
            player: state.currentPlayer,
            action,
            actionIndex,
            legalActions: legal,
            preStateHash: kataCatStateHash(state),
            searchReason: result.reason,
            policyTarget: rootVisits.map((record) => ({
              action: record.actionIndex,
              visits: record.visits,
            })),
          });
          state = applyAction(state, action);
        }

        attempt += 1;
        if (!state.winner || !state.winReason) {
          discardedNonTerminalGames += 1;
          continue;
        }

        const ownership = finalOwnership(state);
        const adjustedMarginA =
          state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
        const game = {
          schemaVersion: 1,
          stage: "M3",
          gameId,
          gameIndex,
          seed: gameSeed,
          split,
          simulations,
          naturalTerminal: true,
          moves,
          finalWinner: state.winner,
          finalWinReason: state.winReason,
          finalAdjustedMarginA: adjustedMarginA,
          finalOwnership: ownership,
          finalStateHash: kataCatStateHash(state),
        };
        replayGame(game);
        games.push(game);
        samples.push(
          ...pending.map((sample) => ({
            ...sample,
            finalWinner: state.winner as Player,
            finalWinReason: state.winReason,
            finalAdjustedMarginA: adjustedMarginA,
            finalOwnership: ownership,
          })),
        );
      }

      if (games.length < requestedGames) {
        throw new Error(`Generated only ${games.length}/${requestedGames} terminal self-play games`);
      }

      const trainGames = new Set(
        samples.filter((sample) => sample.split === "train").map((sample) => sample.gameId),
      );
      const validationGames = new Set(
        samples.filter((sample) => sample.split === "validation").map((sample) => sample.gameId),
      );
      const splitDisjoint = [...trainGames].every((gameId) => !validationGames.has(gameId));
      const multiVisitTargetsObserved = samples.some((sample) =>
        sample.policyTarget.some((item) => item.visits > 1),
      );
      const replayVerified = (() => {
        try {
          for (const game of games) replayGame(game);
          return true;
        } catch {
          return false;
        }
      })();
      const naturalTerminalsOnly = games.every(
        (game) => game.naturalTerminal && game.finalWinner && game.finalWinReason,
      );
      const rootNoiseApplied = noiseFraction === 0 || rootNoiseApplications === searchPositions;
      const temperatureSamplingApplied =
        temperatureMoves === 0 || temperatureSelections > 0;
      const acceptance = {
        generatedRequestedGames: games.length === requestedGames,
        replayVerified,
        naturalTerminalsOnly,
        exactVisitAccounting,
        illegalVisitsZero,
        multiVisitTargetsObserved,
        splitDisjoint,
        rootNoiseApplied,
        temperatureSamplingApplied,
        passed: false,
      };
      acceptance.passed = Object.entries(acceptance)
        .filter(([key]) => key !== "passed")
        .every(([, value]) => value === true);

      const summary = {
        schemaVersion: 1,
        stage: "M3_SELFPLAY",
        bootstrapCheckpoint: env.KATACAT_M3_BOOTSTRAP_CHECKPOINT,
        options: {
          games: requestedGames,
          simulations,
          maxMoves,
          temperatureMoves,
          seed,
          cpuct,
          neuralPriorWeight,
          scoreValueWeight,
          noiseAlpha,
          noiseFraction,
        },
        generatedGames: games.length,
        generatedSamples: samples.length,
        discardedNonTerminalGames,
        searchPositions,
        temperatureSelections,
        rootNoiseApplications,
        resultTypes: games.reduce(
          (counts, game) => {
            counts[game.finalWinReason] = (counts[game.finalWinReason] ?? 0) + 1;
            return counts;
          },
          { CAPTURE: 0, TERRITORY: 0 },
        ),
        splits: { trainGames: trainGames.size, validationGames: validationGames.size },
        acceptance,
        note: "M3 policy targets are PUCT root visit counts. Early moves sample by visit count; later moves choose the visit leader. Root Dirichlet noise is self-play only.",
      };

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        resolve(outputDir, "katacat-selfplay-games.jsonl"),
        `${games.map((game) => JSON.stringify(game)).join("\n")}\n`,
      );
      writeFileSync(
        resolve(outputDir, "katacat-selfplay-samples.jsonl"),
        `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
      );
      writeFileSync(
        resolve(outputDir, "selfplay-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      console.log(`KATACAT_M3_SELFPLAY:${JSON.stringify(summary)}`);

      expect(acceptance.passed).toBe(true);
    },
    10_800_000,
  );
});
