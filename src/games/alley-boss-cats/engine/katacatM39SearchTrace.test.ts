// @ts-nocheck -- Opt-in offline trace generation uses Node child processes and filesystem APIs.
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
import {
  applyKataCatM39DeterministicCorrection,
  buildKataCatM39PairwiseExamples,
} from "./katacatM39Correction";
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
const enabled = env.RUN_KATACAT_M39_TRACE === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positionHash(state: GameState): string {
  return sha256(JSON.stringify(inferenceRequest(state)));
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function rankVisits(records: KataCatVisitRecord[]): KataCatVisitRecord[] {
  return [...records].sort((left, right) => {
    if (right.visits !== left.visits) return right.visits - left.visits;
    if (right.meanValue !== left.meanValue) return right.meanValue - left.meanValue;
    if (right.prior !== left.prior) return right.prior - left.prior;
    return left.actionIndex - right.actionIndex;
  });
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
        const error = new Error(`KataCat M3.9 evaluator exited ${code}: ${this.stderr}`);
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

function deterministicOpening(
  pairIndex: number,
  openingSeed: number,
): { state: GameState; actions: AIAction[] } {
  let state = createInitialState();
  const actions: AIAction[] = [];
  const lengths = [0, 2, 4, 6, 8, 10, 12, 14];
  const prefixLength = lengths[pairIndex % lengths.length];
  let cursor = (openingSeed ^ Math.imul(pairIndex + 1, 0x9e3779b1)) >>> 0;
  for (let ply = 0; ply < prefixLength && !state.winner; ply += 1) {
    const placements = getSafeActions(state, state.currentPlayer).pool
      .filter((action) => action.type === "PLACE")
      .sort((left, right) => encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right));
    if (placements.length === 0) break;
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    const action = placements[cursor % placements.length];
    actions.push(action);
    state = applyAction(state, action);
  }
  return state.winner ? { state: createInitialState(), actions: [] } : { state, actions };
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

async function childEvaluation(
  evaluator: KataCatNeuralEvaluator,
  state: GameState,
  player: Player,
  action: AIAction,
  scoreValueWeight: number,
) {
  const next = applyAction(state, action);
  if (next.winner) {
    const value = next.winner === player ? 1 : -1;
    return {
      terminal: true,
      rawValue: value,
      scoreEstimate: null,
      combinedLeafValue: value,
    };
  }
  const evaluation = await evaluator.evaluate(next);
  const sign = next.currentPlayer === player ? 1 : -1;
  const rawValue = clamp(evaluation.value, -1, 1) * sign;
  const scoreEstimate = clamp(evaluation.score, -1, 1) * sign;
  return {
    terminal: false,
    rawValue,
    scoreEstimate,
    combinedLeafValue: clamp(rawValue + scoreValueWeight * scoreEstimate, -1, 1),
  };
}

function countsBy(rows, field: string) {
  return rows.reduce((counts, row) => {
    const value = String(row[field] ?? "UNKNOWN");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

suite("KataCat M3.9 search-aligned decision trace", () => {
  let parent: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M39_PARENT_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M39_PARENT_CHECKPOINT is required");
    parent = new PythonCheckpointEvaluator(checkpoint);
    await parent.ready;
  }, 120_000);

  afterAll(async () => {
    await parent?.close();
  });

  it("records root evidence, safe-over-refuted pairs, and a no-promotion correction audit", async () => {
    const gamesRequested = positiveInt("KATACAT_M39_GAMES", 32);
    if (gamesRequested % 2 !== 0) throw new Error("KATACAT_M39_GAMES must be even");
    const simulations = positiveInt("KATACAT_M39_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M39_CURRENT_MS", 50);
    const maxMoves = positiveInt("KATACAT_M39_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M39_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M39_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M39_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M39_CAPTURE_DEFENSE_LIMIT", 12);
    const finalVerifyMs = positiveInt("KATACAT_M39_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M39_FINAL_VERIFY_LIMIT", 5);
    const rescueVerifyMs = positiveInt("KATACAT_M39_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M39_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M39_RESCUE_TOTAL_MS", 450);
    const exhaustiveVerifyMs = positiveInt("KATACAT_M39_EXHAUSTIVE_VERIFY_MS", 25);
    const childEvalLimit = positiveInt("KATACAT_M39_CHILD_EVAL_LIMIT", 12);
    const pairNegativeLimit = positiveInt("KATACAT_M39_PAIR_NEGATIVE_LIMIT", 8);
    const openingSeed = positiveInt("KATACAT_M39_OPENING_SEED", 20260803);
    const outputDir = resolve(env.KATACAT_M39_OUTPUT_DIR ?? "katacat-m39-search-trace");
    const scoreValueWeight = 0.05;

    const puctOptions = {
      simulations,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight,
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

    const games = [];
    const decisions = [];
    const pairs = [];
    let legalMovesOnly = true;

    const traceParentDecision = async (state: GameState, gameId: string) => {
      const tactical = getSafeActions(state, state.currentPlayer);
      const result = await searchKataCatPuct(state, parent, puctOptions);
      const readCache = new Map<number, boolean>();
      const readerEvents = [];
      const cachedReader = (readState, readPlayer, readAction, depth, budgetMs) => {
        const actionIndex = encodeKataCatPuctAction(readAction);
        if (readCache.has(actionIndex)) return readCache.get(actionIndex);
        const refuted = refutedAfter(readState, readPlayer, readAction, depth, budgetMs);
        readCache.set(actionIndex, refuted);
        readerEvents.push({ actionIndex, depth, budgetMs, refuted });
        return refuted;
      };
      const rescue = (rescueState, rescuePlayer) => findBestMoveVeryHard(
        rescueState,
        rescuePlayer,
        currentMs,
      );
      const decision = verifyKataCatRootChoiceM341(
        state,
        result,
        guardOptions,
        improvedOptions,
        cachedReader,
        rescue,
      );
      const selectedIndex = encodeKataCatPuctAction(decision.action);
      const rankedSearch = rankVisits(result.visitDistribution);
      const searchRank = new Map(rankedSearch.map((record, index) => [record.actionIndex, index + 1]));
      const searchRecords = new Map(result.visitDistribution.map((record) => [record.actionIndex, record]));
      const searchPool = new Set(result.visitDistribution.map((record) => record.actionIndex));
      const rootActions = result.reason === "SEARCH"
        ? tactical.pool
        : [result.action];
      const policyRanked = [...rootActions].sort((left, right) => {
        if (!result.rootEvaluation) {
          return encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right);
        }
        const leftIndex = encodeKataCatPuctAction(left);
        const rightIndex = encodeKataCatPuctAction(right);
        const difference = result.rootEvaluation.policyLogits[rightIndex]
          - result.rootEvaluation.policyLogits[leftIndex];
        return difference !== 0 ? difference : leftIndex - rightIndex;
      });
      const policyRank = new Map(
        policyRanked.map((action, index) => [encodeKataCatPuctAction(action), index + 1]),
      );
      const omitted = rootActions
        .filter((action) => !searchPool.has(encodeKataCatPuctAction(action)))
        .sort((left, right) => (policyRank.get(encodeKataCatPuctAction(left)) ?? 999)
          - (policyRank.get(encodeKataCatPuctAction(right)) ?? 999));
      const omittedRank = new Map(
        omitted.map((action, index) => [
          encodeKataCatPuctAction(action),
          rankedSearch.length + index + 1,
        ]),
      );
      const rootShellIdentityComplete = !result.tactical.allRefutedFallback;
      const preliminaryRows = rootActions.map((action) => {
        const actionIndex = encodeKataCatPuctAction(action);
        const record = searchRecords.get(actionIndex);
        const omittedByRootShell = result.reason === "SEARCH"
          && !searchPool.has(actionIndex)
          && rootShellIdentityComplete;
        const finalReaderResult = readCache.get(actionIndex);
        let verificationStatus = "UNVERIFIED";
        let verificationSource = null;
        if (omittedByRootShell || finalReaderResult === true) {
          verificationStatus = "REFUTED";
          verificationSource = omittedByRootShell ? "ROOT_TACTICAL_SHELL" : "FINAL_GUARD_READER";
        } else if (finalReaderResult === false) {
          verificationStatus = "VERIFIED_SAFE";
          verificationSource = "FINAL_GUARD_READER";
        }
        return {
          action,
          actionIndex,
          parentRank: searchRank.get(actionIndex) ?? omittedRank.get(actionIndex) ?? 1,
          policyRank: policyRank.get(actionIndex) ?? null,
          policyLogit: result.rootEvaluation?.policyLogits[actionIndex] ?? null,
          visits: record?.visits ?? null,
          prior: record?.prior ?? null,
          meanValue: record?.meanValue ?? null,
          includedInPuctRoot: searchPool.has(actionIndex),
          omittedByRootTacticalShell: omittedByRootShell,
          rootShellRefutationIdentityComplete: rootShellIdentityComplete,
          verificationStatus,
          verificationSource,
          provenCaptureLoss: verificationStatus === "REFUTED",
          selectedByPuct: actionKey(result.action) === actionKey(action),
          selectedByParent: selectedIndex === actionIndex,
          selectionOutcome: selectedIndex === actionIndex ? decision.report.outcome : null,
          childEvaluationCaptured: false,
          childTerminal: null,
          childRawValue: null,
          childScoreEstimate: null,
          childCombinedLeafValue: null,
          eliminationReasons: [],
        };
      });

      const childCandidates = [...preliminaryRows]
        .sort((left, right) => {
          const leftPriority = left.selectedByParent ? -2 : left.verificationStatus === "REFUTED" ? -1 : 0;
          const rightPriority = right.selectedByParent ? -2 : right.verificationStatus === "REFUTED" ? -1 : 0;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return left.parentRank - right.parentRank;
        })
        .slice(0, childEvalLimit);
      const captured = new Map();
      for (const row of childCandidates) {
        captured.set(
          row.actionIndex,
          await childEvaluation(parent, state, state.currentPlayer, row.action, scoreValueWeight),
        );
      }

      const rows = preliminaryRows.map((row) => {
        const child = captured.get(row.actionIndex);
        const eliminationReasons = [];
        if (!row.selectedByParent) {
          if (row.verificationStatus === "REFUTED") {
            eliminationReasons.push(row.verificationSource === "ROOT_TACTICAL_SHELL"
              ? "PROVED_CAPTURE_LOSS_AT_ROOT_SHELL"
              : "PROVED_CAPTURE_LOSS_AT_FINAL_GUARD");
          } else if (decision.report.outcome.startsWith("VERIFIED_")) {
            eliminationReasons.push("PARENT_VERIFIED_SAFE_ACTION_LOCKED");
          } else if (row.parentRank > decision.report.chosenRank) {
            eliminationReasons.push("LOWER_PARENT_SEARCH_RANK");
          } else {
            eliminationReasons.push("UNVERIFIED_NOT_SELECTED");
          }
        }
        return {
          ...row,
          childEvaluationCaptured: child !== undefined,
          childTerminal: child?.terminal ?? null,
          childRawValue: child?.rawValue ?? null,
          childScoreEstimate: child?.scoreEstimate ?? null,
          childCombinedLeafValue: child?.combinedLeafValue ?? null,
          eliminationReasons,
        };
      });

      const correction = applyKataCatM39DeterministicCorrection(rows);
      const decisionPairs = buildKataCatM39PairwiseExamples(rows, pairNegativeLimit).map(
        (pair, index) => ({
          schemaVersion: 1,
          pairId: `${gameId}:p${state.moveHistory.length}:pair${index}`,
          gameId,
          ply: state.moveHistory.length,
          positionHash: positionHash(state),
          currentPlayer: state.currentPlayer,
          ...pair,
        }),
      );
      pairs.push(...decisionPairs);

      const trace = {
        schemaVersion: 1,
        stage: "M3.9_SEARCH_ALIGNED_TRACE",
        diagnosticOnly: true,
        changesPromotionState: false,
        gameId,
        decisionId: `${gameId}:p${state.moveHistory.length}`,
        ply: state.moveHistory.length,
        currentPlayer: state.currentPlayer,
        positionHash: positionHash(state),
        state: inferenceRequest(state),
        search: {
          reason: result.reason,
          simulations: result.simulations,
          selectedPuctAction: encodeKataCatPuctAction(result.action),
          rootValue: result.rootEvaluation?.value ?? null,
          rootScore: result.rootEvaluation?.score ?? null,
          ownershipReturned: Array.isArray(result.rootEvaluation?.ownership),
          ownershipUsedByPuct: false,
          tactical: result.tactical,
          rootShellRefutationIdentityComplete,
        },
        finalDecision: {
          executedAction: selectedIndex,
          outcome: decision.report.outcome,
          selectedActionWasRefuted: decision.report.selectedActionWasRefuted,
          fallbackToUnverified: decision.report.fallbackToUnverified,
          allRootActionsRefuted: decision.report.allRootActionsRefuted,
          chosenRank: decision.report.chosenRank,
          rescueCandidateSelected: decision.report.rescueCandidateSelected,
          adaptiveChecks: decision.report.adaptiveChecks,
          improvedFallbackSelected: decision.report.improvedFallbackSelected,
          preventedUnverifiedFallback: decision.report.preventedUnverifiedFallback,
        },
        readerEvents,
        rootActions: rows,
        pairCount: decisionPairs.length,
        correctionAudit: correction,
      };
      decisions.push(trace);
      return { action: decision.action, trace };
    };

    const play = async (pairIndex: number, parentPlayer: Player) => {
      const gameId = `katacat-m39-${openingSeed}-p${pairIndex}-${parentPlayer}`;
      const opened = deterministicOpening(pairIndex, openingSeed);
      let state = opened.state;
      const decisionStart = decisions.length;
      const moves = [];
      while (!state.winner && state.moveHistory.length < maxMoves) {
        const player = state.currentPlayer;
        const parentTurn = player === parentPlayer;
        const result = parentTurn
          ? await traceParentDecision(state, gameId)
          : { action: findBestMoveVeryHard(state, player, currentMs), trace: null };
        const actionIndex = encodeKataCatPuctAction(result.action);
        if (!legalActions(state).includes(actionIndex)) legalMovesOnly = false;
        moves.push({
          ply: state.moveHistory.length,
          player,
          agent: parentTurn ? "M3.4.1" : "CURRENT",
          action: result.action,
          actionIndex,
          preStateHash: kataCatStateHash(state),
          decisionId: result.trace?.decisionId ?? null,
        });
        state = applyAction(state, result.action);
      }
      if (!state.winner || !state.winReason) {
        throw new Error(`${gameId} did not finish in ${maxMoves} plies`);
      }
      const parentWon = state.winner === parentPlayer;
      const marginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
      const gameResult = {
        winner: state.winner,
        winReason: state.winReason,
        parentWon,
        parentCaptureLoss: !parentWon && state.winReason === "CAPTURE",
        parentTerritoryMargin: state.winReason === "TERRITORY"
          ? parentPlayer === "A" ? marginA : -marginA
          : null,
      };
      for (const trace of decisions.slice(decisionStart)) {
        trace.gameResult = gameResult;
        for (const row of trace.rootActions) {
          row.executedActionWonGame = row.selectedByParent ? parentWon : null;
          row.executedActionEndedInCaptureLoss = row.selectedByParent
            ? gameResult.parentCaptureLoss
            : null;
        }
      }
      return {
        schemaVersion: 1,
        stage: "M3.9_TRACE_GAME",
        gameId,
        pairIndex,
        parentPlayer,
        openingSeed,
        openingActions: opened.actions,
        moves,
        finalStateHash: kataCatStateHash(state),
        ...gameResult,
      };
    };

    for (let pairIndex = 0; pairIndex < gamesRequested / 2; pairIndex += 1) {
      games.push(await play(pairIndex, "A"));
      games.push(await play(pairIndex, "B"));
    }

    const rootRows = decisions.flatMap((decision) => decision.rootActions);
    const corrections = decisions.map((decision) => decision.correctionAudit);
    const verifiedParentSelections = rootRows.filter(
      (row) => row.selectedByParent && row.verificationStatus === "VERIFIED_SAFE",
    );
    const safeLockViolations = decisions.filter((decision) => {
      const selected = decision.rootActions.find((row) => row.selectedByParent);
      return selected?.verificationStatus === "VERIFIED_SAFE"
        && decision.correctionAudit.actionIndex !== selected.actionIndex;
    });
    const childEvaluatedRows = rootRows.filter((row) => row.childEvaluationCaptured);
    const pairTypes = countsBy(pairs, "pairType");
    const recommendation = pairs.length > 0
      ? "READY_FOR_OFFLINE_CORRECTION_REPLAY_ONLY"
      : "INSUFFICIENT_PAIR_DENSITY_COLLECT_MORE_TRACE";
    const acceptance = {
      exactM341CheckpointDeclared:
        env.KATACAT_M39_PARENT_CHECKPOINT_SHA256
          === "9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b",
      allGamesCompleted: games.length === gamesRequested,
      legalMovesOnly,
      parentDecisionsRecorded: decisions.length > 0,
      rootActionRowsRecorded: rootRows.length > 0,
      searchSignalsRecorded: rootRows.some(
        (row) => row.visits !== null && row.prior !== null && row.meanValue !== null,
      ),
      rawChildEvaluationSampled: childEvaluatedRows.length > 0,
      readerEvidenceRecorded: decisions.some((decision) => decision.readerEvents.length > 0),
      safeLockViolationsZero: safeLockViolations.length === 0,
      correctionDoesNotChangePromotionState: true,
      shippedModelUnchanged: true,
      noTrainingPerformed: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.9_SEARCH_ALIGNED_TRACE_SUMMARY",
      diagnosticOnly: true,
      changesPromotionState: false,
      recommendation,
      parentCheckpoint: {
        path: env.KATACAT_M39_PARENT_CHECKPOINT,
        sha256: env.KATACAT_M39_PARENT_CHECKPOINT_SHA256 ?? "unknown",
        expectedSha256: "9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b",
      },
      options: {
        gamesRequested,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        childEvalLimit,
        pairNegativeLimit,
        openingSeed,
      },
      games: {
        completed: games.length,
        parentWins: games.filter((game) => game.parentWon).length,
        parentCaptureLosses: games.filter((game) => game.parentCaptureLoss).length,
      },
      decisions: {
        total: decisions.length,
        search: decisions.filter((decision) => decision.search.reason === "SEARCH").length,
        outcomes: countsBy(decisions.map((decision) => ({ outcome: decision.finalDecision.outcome })), "outcome"),
        rootShellIdentityComplete: decisions.filter(
          (decision) => decision.search.rootShellRefutationIdentityComplete,
        ).length,
        rootShellIdentityIncomplete: decisions.filter(
          (decision) => !decision.search.rootShellRefutationIdentityComplete,
        ).length,
      },
      rootActions: {
        total: rootRows.length,
        verificationStatus: countsBy(rootRows, "verificationStatus"),
        verifiedParentSelections: verifiedParentSelections.length,
        childEvaluated: childEvaluatedRows.length,
        childEvaluationCoverage: childEvaluatedRows.length / Math.max(1, rootRows.length),
        provenCaptureLosses: rootRows.filter((row) => row.provenCaptureLoss).length,
      },
      pairs: {
        total: pairs.length,
        byType: pairTypes,
        winningGamePairs: pairs.filter((pair) => {
          const decision = decisions.find((row) => row.decisionId.startsWith(`${pair.gameId}:p${pair.ply}`));
          return decision?.gameResult?.parentWon;
        }).length,
      },
      correctionAudit: {
        decisions: corrections.length,
        changed: corrections.filter((correction) => correction.changed).length,
        safetyLocked: corrections.filter((correction) => correction.safetyLocked).length,
        allActionsRefuted: corrections.filter((correction) => correction.allActionsRefuted).length,
        safeLockViolations: safeLockViolations.length,
        reasons: countsBy(corrections, "reason"),
      },
      codePathFindings: {
        policyUses: [
          "root tactical-shell screening order",
          "PUCT expansion prior",
          "selection exploration term",
          "root tie-break after visits and Q",
        ],
        valueUses: [
          "every non-terminal leaf evaluation",
          "signed backup into edge Q",
          "subsequent PUCT selection",
          "root visit and Q ranking before final verification",
        ],
        scoreUses: [
          "leaf value as value + 0.05 * score before clamp",
          "same backup and root-ranking path as value",
        ],
        ownershipUses: [],
        ownershipReturnedButNotUsedByPuct: true,
      },
      existingLogAssessment: {
        m341Arena: "Game replay and compact final-guard outcome only; no full root distribution or refutation identities.",
        m37League: "Executed one-hot target and fallback outcome only; no root Q/prior/action elimination trace.",
        m341HardNegative: "Partial root visits and reader maps for selected hard-negative/regression cases, not every decision.",
        sufficientForPairwiseDatasetWithoutNewRun: false,
      },
      limitations: [
        "Root tactical-shell refutation identities are exact when the shell removes at least one action; when all screened actions are refuted and the full pool is retained, only aggregate counts are available.",
        "Raw child value and score are sampled for the selected action and bounded high-priority alternatives, not every root action.",
        "Final game outcome labels the executed action only; unchosen actions do not receive counterfactual win or territory labels.",
        "The deterministic correction audit uses only proved refutations and a verified-safe lock. It is not wired into gameplay and cannot promote a model.",
      ],
      acceptance,
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "games.jsonl"),
      games.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "decision-traces.jsonl"),
      decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "pairwise-examples.jsonl"),
      pairs.map((pair) => JSON.stringify(pair)).join("\n") + (pairs.length > 0 ? "\n" : ""),
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M39_TRACE:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 14_400_000);
});
