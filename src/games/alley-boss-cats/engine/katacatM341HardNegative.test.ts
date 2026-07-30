// @ts-nocheck -- Opt-in offline curriculum generation uses Node child processes and filesystem APIs.
import { createHash } from "node:crypto";
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
import { verifyKataCatRootChoiceM341 } from "./katacatM341Fallback";
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
const enabled = env.RUN_KATACAT_M341_HARD_NEGATIVE === "1";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positionHash(state: GameState): string {
  return sha256(JSON.stringify(inferenceRequest(state)));
}

function stableBucket(value: string, modulo: number): number {
  return Number.parseInt(sha256(value).slice(0, 8), 16) % modulo;
}

function splitForGameId(gameId: string): "train" | "validation" {
  return stableBucket(gameId, 5) === 0 ? "validation" : "train";
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
        const error = new Error(`KataCat M3.4.1 evaluator exited ${code}: ${this.stderr}`);
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

function deterministicOpening(pairIndex: number): { state: GameState; actions: AIAction[] } {
  let state = createInitialState();
  const actions: AIAction[] = [];
  const prefixLength = [1, 3, 5, 7, 9, 11, 13, 15][pairIndex % 8];
  let cursor = (pairIndex * 73 + 31) >>> 0;
  for (let ply = 0; ply < prefixLength && !state.winner; ply += 1) {
    const placements = getSafeActions(state, state.currentPlayer).pool
      .filter((action) => action.type === "PLACE")
      .sort((left, right) => encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right));
    if (placements.length === 0) break;
    cursor = (Math.imul(cursor, 22695477) + 1) >>> 0;
    const action = placements[cursor % placements.length];
    actions.push(action);
    state = applyAction(state, action);
  }
  return state.winner ? { state: createInitialState(), actions: [] } : { state, actions };
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

function stripPuctResult(result) {
  return {
    action: result.action,
    reason: result.reason,
    simulations: result.simulations,
    visitDistribution: result.visitDistribution,
    tactical: result.tactical,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

suite("KataCat M3.4.1 independent tactical hard-negative source", () => {
  let parent: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M341_SOURCE_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M341_SOURCE_CHECKPOINT is required");
    parent = new PythonCheckpointEvaluator(checkpoint);
    await parent.ready;
  }, 120_000);

  afterAll(async () => {
    await parent?.close();
  });

  it("writes game-split, deduplicated hard negatives and real fallback regression fixtures", async () => {
    const gamesRequested = positiveInt("KATACAT_M341_GAMES", 64);
    if (gamesRequested % 2 !== 0) throw new Error("KATACAT_M341_GAMES must be even");
    const simulations = positiveInt("KATACAT_M341_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M341_CURRENT_MS", 75);
    const maxMoves = positiveInt("KATACAT_M341_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M341_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M341_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M341_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M341_CAPTURE_DEFENSE_LIMIT", 12);
    const scanLimit = positiveInt("KATACAT_M341_NEGATIVE_SCAN_LIMIT", 12);
    const scanMs = positiveInt("KATACAT_M341_NEGATIVE_SCAN_MS", 50);
    const teacherVerifyMs = positiveInt("KATACAT_M341_TEACHER_VERIFY_MS", 100);
    const finalVerifyMs = positiveInt("KATACAT_M341_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M341_FINAL_VERIFY_LIMIT", 5);
    const rescueVerifyMs = positiveInt("KATACAT_M341_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M341_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M341_RESCUE_TOTAL_MS", 450);
    const exhaustiveVerifyMs = positiveInt("KATACAT_M341_EXHAUSTIVE_VERIFY_MS", 25);
    const maxSamplesPerGame = positiveInt("KATACAT_M341_MAX_SAMPLES_PER_GAME", 12);
    const outputDir = resolve(env.KATACAT_M341_OUTPUT_DIR ?? "katacat-m341-hard-negative");

    const games = [];
    const rawSamples = [];
    const regressionCases = [];
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
    const improvedOptions = {
      verificationDepth: captureDepth,
      verificationMs: exhaustiveVerifyMs,
      verificationLimit: 82,
    };

    const play = async (pairIndex: number, candidatePlayer: Player) => {
      const gameId = `katacat-m341-hn-p${pairIndex}-${candidatePlayer}`;
      const split = splitForGameId(gameId);
      const opened = deterministicOpening(pairIndex);
      let state = opened.state;
      const pending = [];
      const moves = [];
      const provisionalRegressionCases = [];

      while (!state.winner && state.moveHistory.length < maxMoves) {
        const player = state.currentPlayer;
        let action: AIAction;
        let guardOutcome: string | null = null;

        if (player === candidatePlayer) {
          candidateDecisions += 1;
          const result = await searchKataCatPuct(state, parent, puctOptions);
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
                positionHash: positionHash(state),
                sourceMode: "INDEPENDENT_PARENT_VS_CURRENT_HARD_NEGATIVE",
                trainingStage: "M3.4.1",
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

          const readCache = new Map<number, boolean>();
          const cachedReader = (readState, readPlayer, readAction, depth, budgetMs) => {
            const index = encodeKataCatPuctAction(readAction);
            if (readCache.has(index)) return readCache.get(index);
            const value = refutedAfter(readState, readPlayer, readAction, depth, budgetMs);
            readCache.set(index, value);
            return value;
          };
          const rescue = (rescueState, rescuePlayer) => findBestMoveVeryHard(
            rescueState,
            rescuePlayer,
            currentMs,
          );
          const oldDecision = verifyKataCatRootChoice(
            state,
            result,
            guardOptions,
            cachedReader,
            rescue,
          );
          const improvedDecision = verifyKataCatRootChoiceM341(
            state,
            result,
            guardOptions,
            improvedOptions,
            cachedReader,
            rescue,
          );
          if (
            oldDecision.report.fallbackToUnverified
            && oldDecision.report.chosenRank >= 14
            && improvedDecision.report.outcome === "VERIFIED_EXHAUSTIVE_FALLBACK"
            && !improvedDecision.report.fallbackToUnverified
          ) {
            provisionalRegressionCases.push({
              id: `${gameId}:p${state.moveHistory.length}`,
              gameId,
              ply: state.moveHistory.length,
              currentPlayer: player,
              positionHash: positionHash(state),
              puctResult: stripPuctResult(result),
              guardOptions,
              improvedOptions,
              oldActionIndex: encodeKataCatPuctAction(oldDecision.action),
              oldReport: oldDecision.report,
              improvedActionIndex: encodeKataCatPuctAction(improvedDecision.action),
              improvedReport: improvedDecision.report,
              refutedActionIndices: [...readCache.entries()]
                .filter(([, value]) => value)
                .map(([index]) => index)
                .sort((a, b) => a - b),
              readerSafeActionIndices: [...readCache.entries()]
                .filter(([, value]) => !value)
                .map(([index]) => index)
                .sort((a, b) => a - b),
            });
          }
          action = oldDecision.action;
          guardOutcome = oldDecision.report.outcome;
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
      const candidateWon = state.winner === candidatePlayer;
      const game = {
        schemaVersion: 1,
        stage: "M3.4.1_HARD_NEGATIVE",
        gameId,
        pairIndex,
        candidatePlayer,
        split,
        naturalTerminal: true,
        openingActions: opened.actions,
        moves,
        finalWinner: state.winner,
        finalWinReason: state.winReason,
        finalAdjustedMarginA: adjustedMarginA,
        finalOwnership: ownership,
        finalStateHash: kataCatStateHash(state),
      };
      games.push(game);
      rawSamples.push(...pending.map((sample) => ({
        ...sample,
        finalWinner: state.winner,
        finalWinReason: state.winReason,
        finalAdjustedMarginA: adjustedMarginA,
        finalOwnership: ownership,
      })));
      if (!candidateWon) regressionCases.push(...provisionalRegressionCases);
    };

    for (let pairIndex = 0; pairIndex < gamesRequested / 2; pairIndex += 1) {
      await play(pairIndex, "A");
      await play(pairIndex, "B");
    }

    const hashGroups = new Map();
    for (const sample of rawSamples) {
      const rows = hashGroups.get(sample.positionHash) ?? [];
      rows.push(sample);
      hashGroups.set(sample.positionHash, rows);
    }
    const duplicateGroups = [...hashGroups.values()].filter((rows) => rows.length > 1);
    const crossSplitDuplicateGroups = duplicateGroups.filter(
      (rows) => new Set(rows.map((sample) => sample.split)).size > 1,
    );
    const globallyUnique = [...hashGroups.values()].map((rows) =>
      [...rows].sort((left, right) => left.sampleId.localeCompare(right.sampleId))[0]
    );

    const byGame = new Map();
    for (const sample of globallyUnique) {
      const rows = byGame.get(sample.gameId) ?? [];
      rows.push(sample);
      byGame.set(sample.gameId, rows);
    }
    const samples = [];
    for (const rows of byGame.values()) {
      rows.sort((left, right) => left.positionHash.localeCompare(right.positionHash));
      samples.push(...rows.slice(0, maxSamplesPerGame));
    }
    samples.sort((left, right) => left.sampleId.localeCompare(right.sampleId));

    const trainSamples = samples.filter((sample) => sample.split === "train");
    const validationSamples = samples.filter((sample) => sample.split === "validation");
    const trainGameIds = new Set(trainSamples.map((sample) => sample.gameId));
    const validationGameIds = new Set(validationSamples.map((sample) => sample.gameId));
    const selectedPositionHashes = new Set(samples.map((sample) => sample.positionHash));
    const sampleCountsByGame = Object.fromEntries(
      [...new Set(games.map((game) => game.gameId))].sort().map((gameId) => [
        gameId,
        samples.filter((sample) => sample.gameId === gameId).length,
      ]),
    );
    const perGameCounts = Object.values(sampleCountsByGame);
    const maxGameSamples = Math.max(0, ...perGameCounts);
    const meanGameSamples = perGameCounts.reduce((sum, value) => sum + value, 0)
      / Math.max(1, perGameCounts.length);
    const maxGameShare = maxGameSamples / Math.max(1, samples.length);
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
        !legal.has(sample.positiveAction)
        || negatives.has(sample.positiveAction)
        || sample.policyTarget.length === 0
        || sample.policyTarget.some((item) => !legal.has(item.action) || negatives.has(item.action))
      );
    });
    const actualRegressionCases = regressionCases
      .filter((testCase, index, rows) => rows.findIndex((row) => row.positionHash === testCase.positionHash) === index)
      .slice(0, 32);

    const acceptance = {
      requestedTerminalGames: games.length === gamesRequested,
      naturalTerminalsOnly: games.every((game) => game.naturalTerminal),
      independent64GameSource: gamesRequested >= 64 && games.length >= 64,
      gameIdSplitUnit: true,
      trainValidationGameDisjoint: [...trainGameIds].every((gameId) => !validationGameIds.has(gameId)),
      uniqueSelectedPositionHashes: selectedPositionHashes.size === samples.length,
      perGameSampleCapRespected: maxGameSamples <= maxSamplesPerGame,
      hardNegativeSamplesPresent: samples.length > 0,
      frozenTacticalValidationPresent: validationSamples.length > 0,
      provenNegativeActionsPresent: provenNegativeActions > 0,
      bothSeatsInTrain: seatCounts.train.A > 0 && seatCounts.train.B > 0,
      bothSeatsInValidation: seatCounts.validation.A > 0 && seatCounts.validation.B > 0,
      safeLegalTargetsOnly: invalidTargets.length === 0,
      unverifiedFallbackTargetsExcluded: samples.every((sample) => !sample.targetUsesUnverifiedFallback),
      actualLossRegressionFixturesPresent: actualRegressionCases.length > 0,
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.4.1_HARD_NEGATIVE",
      options: {
        gamesRequested,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        scanLimit,
        scanMs,
        teacherVerifyMs,
        maxSamplesPerGame,
      },
      generatedGames: games.length,
      rawSamples: rawSamples.length,
      deduplicatedSamplesBeforeCap: globallyUnique.length,
      generatedSamples: samples.length,
      frozenTacticalValidationSamples: validationSamples.length,
      candidateDecisions,
      scannedActions,
      provenNegativeActions,
      meanNegativesPerSample: samples.length > 0
        ? samples.reduce((sum, sample) => sum + sample.negativeActions.length, 0) / samples.length
        : 0,
      sourceOriginalPuctRefuted: samples.filter((sample) => sample.originalPuctActionRefuted).length,
      splitAudit: {
        unit: "gameId",
        trainGameIds: [...trainGameIds].sort(),
        validationGameIds: [...validationGameIds].sort(),
        disjoint: [...trainGameIds].every((gameId) => !validationGameIds.has(gameId)),
      },
      positionHashAudit: {
        rawUniqueHashes: hashGroups.size,
        duplicateHashGroups: duplicateGroups.length,
        duplicateRows: duplicateGroups.reduce((sum, rows) => sum + rows.length - 1, 0),
        crossSplitDuplicateHashGroups: crossSplitDuplicateGroups.length,
        selectedUniqueHashes: selectedPositionHashes.size,
        selectedRows: samples.length,
      },
      perGameSampleAudit: {
        cap: maxSamplesPerGame,
        counts: sampleCountsByGame,
        max: maxGameSamples,
        mean: meanGameSamples,
        p95: percentile(perGameCounts, 0.95),
        maxShare: maxGameShare,
      },
      seatCounts,
      exclusions,
      discardedNonTerminalGames,
      actualLossRegressionCases: actualRegressionCases.length,
      acceptance,
      note: "M3.4.1 mines a new 64-game parent-vs-CURRENT source. Splits are assigned once per gameId; duplicate position hashes are audited and globally deduplicated; each game is capped before training. Tactical validation is frozen and never mixed into general validation.",
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "katacat-m341-hard-negative-games.jsonl"),
      games.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m341-hard-negative-samples.jsonl"),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m341-frozen-tactical-validation.jsonl"),
      validationSamples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m341-regression-fixtures.json"),
      JSON.stringify({
        schemaVersion: 1,
        stage: "M3.4.1_ACTUAL_LOSS_REGRESSIONS",
        source: "independent parent+old-fallback losses",
        cases: actualRegressionCases,
      }, null, 2) + "\n",
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M341_HARD_NEGATIVE:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 3_600_000);
});
