// @ts-nocheck -- Opt-in offline curriculum generation uses Node child processes and filesystem APIs.
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
import { opponentCanForceCapture } from "./captureSearch";
import { verifyKataCatRootChoice } from "./katacatFinalGuard";
import { kataCatStateHash } from "./katacatM0";
import { findBestMoveVeryHard } from "./minimax";
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
const enabled = env.RUN_KATACAT_M34_HARD_NEGATIVE === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  return !move || move.type === "PASS"
    ? KATACAT_PASS_INDEX
    : move.row * BOARD_SIZE + move.col;
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
    this.child = spawn(python, ["ml/katacat_m33_infer.py", `--checkpoint=${checkpoint}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.on("error", (error) => {
      this.rejectReady(error);
      for (const pending of this.pending.splice(0)) pending.reject(error);
    });
    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const error = new Error(`KataCat M3.4 evaluator exited ${code}: ${this.stderr}`);
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

function deterministicOpening(pairIndex: number): GameState {
  let state = createInitialState();
  const prefixLength = [0, 2, 4, 6, 8, 10, 12, 14][pairIndex % 8];
  let cursor = (pairIndex * 29 + 7) >>> 0;
  for (let ply = 0; ply < prefixLength && !state.winner; ply += 1) {
    const placements = getSafeActions(state, state.currentPlayer).pool
      .filter((action) => action.type === "PLACE")
      .sort((left, right) => encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right));
    if (placements.length === 0) break;
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    state = applyAction(state, placements[cursor % placements.length]);
  }
  return state.winner ? createInitialState() : state;
}

function rankVisits(records: KataCatVisitRecord[]): KataCatVisitRecord[] {
  return [...records].sort((left, right) => {
    if (right.visits !== left.visits) return right.visits - left.visits;
    if (right.meanValue !== left.meanValue) return right.meanValue - left.meanValue;
    if (right.prior !== left.prior) return right.prior - left.prior;
    return left.actionIndex - right.actionIndex;
  });
}

function refutedAfter(
  state: GameState,
  player: Player,
  action: AIAction,
  depth: number,
  budgetMs: number,
): boolean {
  const next = applyAction(state, action);
  if (next.winner === player) return false;
  if (next.winner) return true;
  return opponentCanForceCapture(next, player, depth, budgetMs);
}

suite("KataCat M3.4 tactical hard-negative curriculum", () => {
  let candidate: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M34_SOURCE_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M34_SOURCE_CHECKPOINT is required");
    candidate = new PythonCheckpointEvaluator(checkpoint);
    await candidate.ready;
  }, 120_000);

  afterAll(async () => {
    await candidate?.close();
  });

  it("writes natural-terminal CURRENT-verified corrections and proven losing actions", async () => {
    const gamesRequested = positiveInt("KATACAT_M34_GAMES", 16);
    if (gamesRequested % 2 !== 0) throw new Error("KATACAT_M34_GAMES must be even");
    const simulations = positiveInt("KATACAT_M34_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M34_CURRENT_MS", 75);
    const maxMoves = positiveInt("KATACAT_M34_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M34_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M34_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M34_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M34_CAPTURE_DEFENSE_LIMIT", 12);
    const scanLimit = positiveInt("KATACAT_M34_NEGATIVE_SCAN_LIMIT", 8);
    const scanMs = positiveInt("KATACAT_M34_NEGATIVE_SCAN_MS", 50);
    const teacherVerifyMs = positiveInt("KATACAT_M34_TEACHER_VERIFY_MS", 100);
    const finalVerifyMs = positiveInt("KATACAT_M34_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M34_FINAL_VERIFY_LIMIT", 5);
    const rescueVerifyMs = positiveInt("KATACAT_M34_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M34_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M34_RESCUE_TOTAL_MS", 450);
    const outputDir = resolve(env.KATACAT_M34_OUTPUT_DIR ?? "katacat-m34-hard-negative");

    const games = [];
    const samples = [];
    const exclusions = {
      noProvenNegative: 0,
      teacherRefuted: 0,
      teacherInsideNegativeSet: 0,
      nonSearch: 0,
    };
    let candidateDecisions = 0;
    let scannedActions = 0;
    let provenNegativeActions = 0;
    let discardedNonTerminalGames = 0;

    const puctOptions = {
      simulations,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight: 0.05,
      tacticalShell: true,
      captureReadDepth: captureDepth,
      captureAttackMs,
      captureDefenseMs,
      captureDefenseLimit,
    };
    const guardOptions = {
      finalVerificationDepth: captureDepth,
      finalVerificationMs: finalVerifyMs,
      finalVerificationLimit: finalVerifyLimit,
      rescueVerificationLimit: rescueVerifyLimit,
      rescueVerificationMs: rescueVerifyMs,
      rescueTotalMs,
    };

    const play = async (pairIndex: number, candidatePlayer: Player) => {
      const gameId = `katacat-m34-hn-p${pairIndex}-${candidatePlayer}`;
      const split = pairIndex % 4 === 0 ? "validation" : "train";
      let state = deterministicOpening(pairIndex);
      const pending = [];
      const moves = [];

      while (!state.winner && state.moveHistory.length < maxMoves) {
        const player = state.currentPlayer;
        let action: AIAction;
        let guardOutcome: string | null = null;

        if (player === candidatePlayer) {
          candidateDecisions += 1;
          const result = await searchKataCatPuct(state, candidate, puctOptions);
          const ranked = rankVisits(result.visitDistribution);
          const negativeActions: number[] = [];

          if (result.reason === "SEARCH") {
            for (const record of ranked.slice(0, Math.min(scanLimit, ranked.length))) {
              scannedActions += 1;
              if (refutedAfter(state, player, record.action, captureDepth, scanMs)) {
                negativeActions.push(record.actionIndex);
                provenNegativeActions += 1;
              }
            }

            const teacher = findBestMoveVeryHard(state, player, currentMs);
            const teacherIndex = encodeKataCatPuctAction(teacher);
            const legal = legalActions(state);
            const teacherRefuted = refutedAfter(state, player, teacher, captureDepth, teacherVerifyMs);
            const negativeSet = new Set(negativeActions);

            if (negativeActions.length === 0) {
              exclusions.noProvenNegative += 1;
            } else if (teacherRefuted) {
              exclusions.teacherRefuted += 1;
            } else if (negativeSet.has(teacherIndex)) {
              exclusions.teacherInsideNegativeSet += 1;
            } else {
              const retainedVisits = result.visitDistribution
                .filter((record) => record.visits > 0 && !negativeSet.has(record.actionIndex))
                .map((record) => ({ action: record.actionIndex, visits: record.visits }));
              const maximumRetained = retainedVisits.reduce(
                (maximum, item) => Math.max(maximum, item.visits),
                1,
              );
              const existingTeacher = retainedVisits.find((item) => item.action === teacherIndex);
              if (existingTeacher) existingTeacher.visits = Math.max(existingTeacher.visits, maximumRetained);
              else retainedVisits.push({ action: teacherIndex, visits: maximumRetained });
              retainedVisits.sort((left, right) => left.action - right.action);

              pending.push({
                schemaVersion: 1,
                sampleId: `${gameId}:p${state.moveHistory.length}`,
                gameId,
                split,
                sourceMode: "CANDIDATE_VS_CURRENT_HARD_NEGATIVE",
                trainingStage: "M3.4",
                policySource: "TACTICAL_HARD_NEGATIVE_MASKED_PUCT",
                currentPlayer: player,
                ply: state.moveHistory.length,
                board: encodeBoard(state),
                legalActions: legal,
                territoryA: encodeCoords(state.territories.A),
                territoryB: encodeCoords(state.territories.B),
                remainingA: state.remainingCats.A,
                remainingB: state.remainingCats.B,
                consecutivePasses: state.consecutivePasses,
                lastAction: lastAction(state),
                policyTarget: retainedVisits,
                positiveAction: teacherIndex,
                negativeActions: [...negativeSet].sort((a, b) => a - b),
                originalPuctAction: encodeKataCatPuctAction(result.action),
                originalPuctActionRefuted: negativeSet.has(encodeKataCatPuctAction(result.action)),
                exactNegativeProof: true,
                targetUsesUnverifiedFallback: false,
              });
            }
          } else {
            exclusions.nonSearch += 1;
          }

          const verified = verifyKataCatRootChoice(
            state,
            result,
            guardOptions,
            refutedAfter,
            (rescueState, rescuePlayer) => findBestMoveVeryHard(rescueState, rescuePlayer, currentMs),
          );
          action = verified.action;
          guardOutcome = verified.report.outcome;
        } else {
          action = findBestMoveVeryHard(state, player, currentMs);
        }

        const actionIndex = encodeKataCatPuctAction(action);
        const legal = legalActions(state);
        if (!legal.includes(actionIndex)) throw new Error(`${gameId}: illegal action ${actionIndex}`);
        moves.push({
          ply: state.moveHistory.length,
          player,
          action,
          actionIndex,
          preStateHash: kataCatStateHash(state),
          guardOutcome,
        });
        state = applyAction(state, action);
      }

      if (!state.winner || !state.winReason) {
        discardedNonTerminalGames += 1;
        return;
      }

      const ownership = finalOwnership(state);
      const adjustedMarginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
      const game = {
        schemaVersion: 1,
        stage: "M3.4_HARD_NEGATIVE",
        gameId,
        pairIndex,
        candidatePlayer,
        split,
        naturalTerminal: true,
        moves,
        finalWinner: state.winner,
        finalWinReason: state.winReason,
        finalAdjustedMarginA: adjustedMarginA,
        finalOwnership: ownership,
        finalStateHash: kataCatStateHash(state),
      };
      games.push(game);
      samples.push(...pending.map((sample) => ({
        ...sample,
        finalWinner: state.winner,
        finalWinReason: state.winReason,
        finalAdjustedMarginA: adjustedMarginA,
        finalOwnership: ownership,
      })));
    };

    for (let pairIndex = 0; pairIndex < gamesRequested / 2; pairIndex += 1) {
      await play(pairIndex, "A");
      await play(pairIndex, "B");
    }

    const trainSamples = samples.filter((sample) => sample.split === "train");
    const validationSamples = samples.filter((sample) => sample.split === "validation");
    const seatCounts = {
      train: {
        A: trainSamples.filter((sample) => sample.currentPlayer === "A").length,
        B: trainSamples.filter((sample) => sample.currentPlayer === "B").length,
      },
      validation: {
        A: validationSamples.filter((sample) => sample.currentPlayer === "A").length,
        B: validationSamples.filter((sample) => sample.currentPlayer === "B").length,
      },
    };
    const invalidTargets = samples.filter((sample) => {
      const legal = new Set(sample.legalActions);
      const negatives = new Set(sample.negativeActions);
      return (
        !legal.has(sample.positiveAction) ||
        negatives.has(sample.positiveAction) ||
        sample.policyTarget.length === 0 ||
        sample.policyTarget.some((item) => !legal.has(item.action) || negatives.has(item.action))
      );
    });
    const acceptance = {
      requestedTerminalGames: games.length === gamesRequested,
      naturalTerminalsOnly: games.every((game) => game.naturalTerminal),
      hardNegativeSamplesPresent: samples.length > 0,
      provenNegativeActionsPresent: provenNegativeActions > 0,
      trainAndValidationPresent: trainSamples.length > 0 && validationSamples.length > 0,
      bothSeatsInTrain: seatCounts.train.A > 0 && seatCounts.train.B > 0,
      bothSeatsInValidation: seatCounts.validation.A > 0 && seatCounts.validation.B > 0,
      safeLegalTargetsOnly: invalidTargets.length === 0,
      unverifiedFallbackTargetsExcluded: samples.every((sample) => !sample.targetUsesUnverifiedFallback),
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.4_HARD_NEGATIVE",
      options: {
        gamesRequested,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        scanLimit,
        scanMs,
        teacherVerifyMs,
      },
      generatedGames: games.length,
      generatedSamples: samples.length,
      candidateDecisions,
      scannedActions,
      provenNegativeActions,
      meanNegativesPerSample: samples.length > 0
        ? samples.reduce((sum, sample) => sum + sample.negativeActions.length, 0) / samples.length
        : 0,
      sourceOriginalPuctRefuted: samples.filter((sample) => sample.originalPuctActionRefuted).length,
      splits: { train: trainSamples.length, validation: validationSamples.length },
      seatCounts,
      exclusions,
      discardedNonTerminalGames,
      acceptance,
      note: "Only naturally terminal candidate-vs-CURRENT games are retained. Proven losing root actions are removed from the PUCT target, a separately verified CURRENT move is inserted as the positive action, and unverified/all-refuted guard fallbacks are never used as policy teachers.",
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "katacat-m34-hard-negative-games.jsonl"),
      games.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m34-hard-negative-samples.jsonl"),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M34_HARD_NEGATIVE:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 3_600_000);
});
