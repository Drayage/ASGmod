// @ts-nocheck -- Opt-in offline replay mining uses Node filesystem and Python inference.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState } from "../types";
import { kataCatStateHash } from "./katacatM0";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M342_PRECOLLAPSE === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  const previous = state.moveHistory[state.moveHistory.length - 1];
  return !previous || previous.type === "PASS"
    ? KATACAT_PASS_INDEX
    : previous.row * BOARD_SIZE + previous.col;
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

function positionHash(state: GameState): string {
  const canonical = JSON.stringify({
    board: encodeBoard(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    currentPlayer: state.currentPlayer,
    lastAction: lastAction(state),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    ply: state.moveHistory.length,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function splitForGame(gameId: string): "train" | "validation" {
  const value = Number.parseInt(createHash("sha256").update(gameId).digest("hex").slice(0, 8), 16);
  return value % 5 === 0 ? "validation" : "train";
}

function replayState(game: any, moveCount: number): GameState {
  let state = createInitialState();
  for (const action of game.openingActions ?? []) state = applyAction(state, action);
  for (let index = 0; index < moveCount; index += 1) {
    state = applyAction(state, game.moves[index].action);
  }
  return state;
}

function terminalState(game: any): GameState {
  return replayState(game, game.moves.length);
}

class PythonCheckpointEvaluator implements KataCatNeuralEvaluator {
  child;
  lines;
  pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  stderr = "";
  ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (error: Error) => void;

  constructor(checkpoint: string) {
    const python = env.PYTHON ?? "python";
    this.child = spawn(python, ["ml/katacat_m33_infer.py", `--checkpoint=${checkpoint}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.on("error", (error) => {
      this.rejectReady(error);
      for (const pending of this.pending.splice(0)) pending.reject(error);
    });
    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const error = new Error(`KataCat M3.4.2 evaluator exited ${code}: ${this.stderr}`);
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

suite("KataCat M3.4.2 pre-collapse curriculum", () => {
  let evaluator: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M342_SOURCE_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M342_SOURCE_CHECKPOINT is required");
    evaluator = new PythonCheckpointEvaluator(checkpoint);
    await evaluator.ready;
  }, 120_000);

  afterAll(async () => {
    await evaluator?.close();
  });

  it("mines 2/4/6-ply ancestors of the first all-root-refuted loss without inventing policy negatives", async () => {
    const replayPath = env.KATACAT_M342_REPLAY_PATH;
    if (!replayPath) throw new Error("KATACAT_M342_REPLAY_PATH is required");
    const outputDir = resolve(env.KATACAT_M342_OUTPUT_DIR ?? "katacat-m342-precollapse");
    const simulations = positiveInt("KATACAT_M342_SIMULATIONS", 32);
    const maxSamplesPerGame = positiveInt("KATACAT_M342_MAX_SAMPLES_PER_GAME", 3);
    const distances = (env.KATACAT_M342_DISTANCES ?? "2,4,6")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0 && value % 2 === 0)
      .sort((a, b) => a - b);
    if (distances.length === 0) throw new Error("At least one positive even pre-collapse distance is required");

    const sourceGames = readJsonl(replayPath).filter((game) =>
      !game.candidateWon
      && ["CANDIDATE_IMPROVED_VS_CURRENT", "CANDIDATE_IMPROVED_VS_PARENT_IMPROVED"]
        .includes(game.comparisonId)
    );
    const rawSamples: any[] = [];
    const sourceAudit: any[] = [];

    const puctOptions = {
      simulations,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight: 0.05,
      tacticalShell: true,
      captureReadDepth: 7,
      captureAttackMs: 25,
      captureDefenseMs: 50,
      captureDefenseLimit: 12,
    };

    for (const game of sourceGames) {
      const collapseIndex = game.moves.findIndex((move) =>
        move.player === game.candidatePlayer
        && move.agent === "CANDIDATE_IMPROVED"
        && move.guard?.allRootActionsRefuted === true
      );
      if (collapseIndex < 0) continue;
      const final = terminalState(game);
      if (!final.winner || !final.winReason) continue;
      const gameId = `m342:${game.comparisonId}:p${game.pairIndex}:${game.candidatePlayer}`;
      const split = splitForGame(gameId);
      const adjustedMarginA = final.territories.A.length - final.territories.B.length - FIRST_PLAYER_MARGIN;
      const ownership = finalOwnership(final);
      const created: any[] = [];

      for (const distance of distances) {
        const moveIndex = collapseIndex - distance;
        if (moveIndex < 0) continue;
        const replayMove = game.moves[moveIndex];
        if (replayMove.player !== game.candidatePlayer || replayMove.agent !== "CANDIDATE_IMPROVED") continue;
        const state = replayState(game, moveIndex);
        if (state.winner || state.currentPlayer !== game.candidatePlayer) continue;
        const result = await searchKataCatPuct(state, evaluator, puctOptions);
        const retained = result.visitDistribution
          .filter((record) => record.visits > 0)
          .map((record) => ({ action: record.actionIndex, visits: record.visits }))
          .sort((left, right) => left.action - right.action);
        if (retained.length === 0) {
          retained.push({ action: encodeKataCatPuctAction(result.action), visits: 1 });
        }
        const hash = positionHash(state);
        created.push({
          schemaVersion: 1,
          sampleId: `${gameId}:collapse${game.moves[collapseIndex].ply}:d${distance}`,
          gameId,
          split,
          positionHash: hash,
          sourceMode: "REAL_LOSS_PRE_COLLAPSE",
          trainingStage: "M3.4.2",
          trainingSource: "precollapse",
          policySource: "M341_PUCT_DISTILLATION",
          policyWeight: 0.25,
          auxiliaryWeight: distance === 2 ? 1.5 : distance === 4 ? 1.25 : 1.0,
          currentPlayer: state.currentPlayer,
          ply: state.moveHistory.length,
          board: encodeBoard(state),
          legalActions: legalActions(state),
          territoryA: encodeCoords(state.territories.A),
          territoryB: encodeCoords(state.territories.B),
          remainingA: state.remainingCats.A,
          remainingB: state.remainingCats.B,
          consecutivePasses: state.consecutivePasses,
          lastAction: lastAction(state),
          policyTarget: retained,
          positiveAction: encodeKataCatPuctAction(result.action),
          negativeActions: [],
          targetUsesUnverifiedFallback: false,
          exactNegativeProof: false,
          trajectoryNegativeAction: replayMove.actionIndex,
          precollapseDistance: distance,
          collapsePly: game.moves[collapseIndex].ply,
          collapseStateHash: game.moves[collapseIndex].preStateHash,
          finalWinner: final.winner,
          finalWinReason: final.winReason,
          finalAdjustedMarginA: adjustedMarginA,
          finalOwnership: ownership,
        });
      }
      created.sort((left, right) => left.precollapseDistance - right.precollapseDistance);
      rawSamples.push(...created.slice(0, maxSamplesPerGame));
      sourceAudit.push({
        gameId,
        comparisonId: game.comparisonId,
        pairIndex: game.pairIndex,
        candidatePlayer: game.candidatePlayer,
        collapsePly: game.moves[collapseIndex].ply,
        generatedDistances: created.map((sample) => sample.precollapseDistance),
        finalWinReason: final.winReason,
      });
    }

    const byHash = new Map<string, any[]>();
    for (const sample of rawSamples) {
      const rows = byHash.get(sample.positionHash) ?? [];
      rows.push(sample);
      byHash.set(sample.positionHash, rows);
    }
    const samples = [...byHash.values()]
      .map((rows) => [...rows].sort((a, b) => a.sampleId.localeCompare(b.sampleId))[0])
      .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
    const train = samples.filter((sample) => sample.split === "train");
    const validation = samples.filter((sample) => sample.split === "validation");
    const trainGames = new Set(train.map((sample) => sample.gameId));
    const validationGames = new Set(validation.map((sample) => sample.gameId));
    const countsByDistance = Object.fromEntries(
      distances.map((distance) => [String(distance), samples.filter((sample) => sample.precollapseDistance === distance).length]),
    );
    const countsBySeat = {
      train: {
        A: train.filter((sample) => sample.currentPlayer === "A").length,
        B: train.filter((sample) => sample.currentPlayer === "B").length,
      },
      validation: {
        A: validation.filter((sample) => sample.currentPlayer === "A").length,
        B: validation.filter((sample) => sample.currentPlayer === "B").length,
      },
    };
    const invalid = samples.filter((sample) => {
      const legal = new Set(sample.legalActions);
      return sample.policyTarget.length === 0
        || sample.policyTarget.some((item) => !legal.has(item.action) || item.visits <= 0)
        || sample.negativeActions.length !== 0
        || sample.precollapseDistance < 2
        || sample.precollapseDistance > 6;
    });
    const acceptance = {
      sourceLossesPresent: sourceGames.length > 0,
      precollapseSamplesPresent: samples.length > 0,
      trainAndValidationPresent: train.length > 0 && validation.length > 0,
      gameIdSplitDisjoint: [...trainGames].every((gameId) => !validationGames.has(gameId)),
      uniquePositionHashes: new Set(samples.map((sample) => sample.positionHash)).size === samples.length,
      distancesCovered: distances.every((distance) => Number(countsByDistance[String(distance)]) > 0),
      bothSeatsInTrain: countsBySeat.train.A > 0 && countsBySeat.train.B > 0,
      bothSeatsInValidation: countsBySeat.validation.A > 0 && countsBySeat.validation.B > 0,
      legalDistillationTargets: invalid.length === 0,
      noInventedPolicyNegatives: samples.every(
        (sample) => sample.negativeActions.length === 0 && sample.exactNegativeProof === false,
      ),
      naturallyTerminalLossLabels: samples.every(
        (sample) => sample.finalWinner && sample.finalWinReason && sample.finalWinner !== sample.currentPlayer,
      ),
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.4.2_PRE_COLLAPSE",
      sourceReplayPath: replayPath,
      sourceLossGames: sourceGames.length,
      gamesWithCollapse: sourceAudit.length,
      rawSamples: rawSamples.length,
      generatedSamples: samples.length,
      duplicateRowsRemoved: rawSamples.length - samples.length,
      distances,
      countsByDistance,
      splits: { train: train.length, validation: validation.length },
      countsBySeat,
      policySemantics: {
        source: "M3.4.1 PUCT distillation",
        weight: 0.25,
        actionNegativesAdded: 0,
        note: "The replay action is trajectory context, not a proved losing policy label. Final loss supervision is applied through value/score/ownership heads.",
      },
      sourceAudit,
      acceptance,
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "katacat-m342-precollapse-samples.jsonl"),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m342-precollapse-validation.jsonl"),
      validation.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M342_PRECOLLAPSE:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 7_200_000);
});
