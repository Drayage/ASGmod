// @ts-nocheck -- Opt-in integration arena uses Node child processes and filesystem APIs.
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
import { findBestMoveVeryHard } from "./minimax";
import { encodeKataCatPuctAction, KATACAT_PASS_INDEX } from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";
import {
  searchKataCatPuctWithFinalGuard,
  type KataCatFinalGuardReport,
} from "./katacatFinalGuard";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M321_ARENA === "1";
const suite = enabled ? describe : describe.skip;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function encodeBoard(state: GameState): string {
  const code = { EMPTY: ".", PLAYER_A: "A", PLAYER_B: "B", NEUTRAL: "N" } as const;
  return state.board.flat().map((cell) => code[cell]).join("");
}

function encodeCoords(coords: Array<{ row: number; col: number }>): number[] {
  return coords.map(({ row, col }) => row * BOARD_SIZE + col).sort((a, b) => a - b);
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
    legalActions: [
      ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
      KATACAT_PASS_INDEX,
    ],
    currentPlayer: state.currentPlayer,
    lastAction: lastAction(state),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    ply: state.moveHistory.length,
  };
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
    this.child = spawn(python, ["ml/katacat_m1_infer.py", `--checkpoint=${checkpoint}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        const error = new Error(`KataCat evaluator exited ${code}: ${this.stderr}`);
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
  let cursor = (pairIndex * 17 + 11) >>> 0;
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

type AgentKind = "CANDIDATE" | "CHAMPION" | "CURRENT";

function emptyOutcomeCounts() {
  return {
    SKIPPED_TACTICAL: 0,
    VERIFIED_SAFE: 0,
    UNVERIFIED_VISITED: 0,
    UNVERIFIED_ZERO_VISIT: 0,
    ALL_ROOT_ACTIONS_REFUTED: 0,
  };
}

function emptyAgentStats() {
  return {
    decisions: 0,
    totalDecisionMs: 0,
    meanDecisionMs: 0,
    forcedCaptureMoves: 0,
    screenedActions: 0,
    refutedRootActions: 0,
    finalVerificationChecks: 0,
    finalVerificationRefutations: 0,
    selectedActionRejections: 0,
    selectedActionWasRefuted: 0,
    unverifiedFallbacks: 0,
    zeroVisitFallbacks: 0,
    allCheckedRefuted: 0,
    allRootActionsRefuted: 0,
    provenLosingFallbacks: 0,
    invariantViolations: 0,
    outcomes: emptyOutcomeCounts(),
  };
}

function compactGuard(report: KataCatFinalGuardReport | null, decisionMs: number, action: AIAction) {
  if (!report) return null;
  return {
    actionIndex: encodeKataCatPuctAction(action),
    outcome: report.outcome,
    checks: report.checks,
    refutations: report.refutations,
    selectedActionRejected: report.selectedActionRejected,
    selectedActionWasRefuted: report.selectedActionWasRefuted,
    fallbackToUnverified: report.fallbackToUnverified,
    fallbackToZeroVisit: report.fallbackToZeroVisit,
    allCheckedRefuted: report.allCheckedRefuted,
    allRootActionsRefuted: report.allRootActionsRefuted,
    provenLosingFallback: report.provenLosingFallback,
    chosenRank: report.chosenRank,
    chosenVisits: report.chosenVisits,
    uncheckedActionsRemaining: report.uncheckedActionsRemaining,
    decisionMs,
  };
}

suite("KataCat M3.2.1 zero-visit fallback arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let champion: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M321_CANDIDATE_CHECKPOINT;
    const championCheckpoint = env.KATACAT_M321_CHAMPION_CHECKPOINT;
    if (!candidateCheckpoint || !championCheckpoint) {
      throw new Error(
        "KATACAT_M321_CANDIDATE_CHECKPOINT and KATACAT_M321_CHAMPION_CHECKPOINT are required",
      );
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint);
    champion = new PythonCheckpointEvaluator(championCheckpoint);
    await Promise.all([candidate.ready, champion.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), champion?.close()]);
  });

  it(
    "never reselects a proved losing root while an unverified root remains",
    async () => {
      const gamesPerOpponent = positiveInt(env.KATACAT_M321_GAMES_PER_OPPONENT, 16);
      if (gamesPerOpponent % 2 !== 0) throw new Error("games per opponent must be even");
      const simulations = positiveInt(env.KATACAT_M321_SIMULATIONS, 32);
      const currentMs = positiveInt(env.KATACAT_M321_CURRENT_MS, 50);
      const maxMoves = positiveInt(env.KATACAT_M321_MAX_MOVES, 90);
      const captureReadDepth = positiveInt(env.KATACAT_M321_CAPTURE_DEPTH, 7);
      const captureAttackMs = positiveInt(env.KATACAT_M321_CAPTURE_ATTACK_MS, 25);
      const captureDefenseMs = positiveInt(env.KATACAT_M321_CAPTURE_DEFENSE_MS, 50);
      const captureDefenseLimit = positiveInt(env.KATACAT_M321_CAPTURE_DEFENSE_LIMIT, 12);
      const finalVerificationMs = positiveInt(env.KATACAT_M321_FINAL_VERIFY_MS, 75);
      const finalVerificationLimit = positiveInt(env.KATACAT_M321_FINAL_VERIFY_LIMIT, 5);
      const previousThreshold = numberValue(env.KATACAT_M321_PREVIOUS_THRESHOLD, 0.525);
      const currentThreshold = numberValue(env.KATACAT_M321_CURRENT_THRESHOLD, 0.55);
      const pairCount = gamesPerOpponent / 2;
      const games = [];
      const agentStats = {
        CANDIDATE: emptyAgentStats(),
        CHAMPION: emptyAgentStats(),
        CURRENT: emptyAgentStats(),
      };

      const choose = async (kind: AgentKind, state: GameState) => {
        const started = Date.now();
        if (kind === "CURRENT") {
          const action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
          const elapsedMs = Date.now() - started;
          const stats = agentStats.CURRENT;
          stats.decisions += 1;
          stats.totalDecisionMs += elapsedMs;
          return { action, guard: null, elapsedMs };
        }

        const evaluator = kind === "CANDIDATE" ? candidate : champion;
        const result = await searchKataCatPuctWithFinalGuard(
          state,
          evaluator,
          {
            simulations,
            cpuct: 1.35,
            neuralPriorWeight: 0.75,
            scoreValueWeight: 0.05,
            tacticalShell: true,
            captureReadDepth,
            captureAttackMs,
            captureDefenseMs,
            captureDefenseLimit,
          },
          {
            finalVerificationDepth: captureReadDepth,
            finalVerificationMs,
            finalVerificationLimit,
          },
        );
        const elapsedMs = Date.now() - started;
        const stats = agentStats[kind];
        stats.decisions += 1;
        stats.totalDecisionMs += elapsedMs;
        if (result.reason === "FORCED_CAPTURE") stats.forcedCaptureMoves += 1;
        stats.screenedActions += result.tactical.screenedActions;
        stats.refutedRootActions += result.tactical.refutedActions;
        stats.finalVerificationChecks += result.finalGuard.checks;
        stats.finalVerificationRefutations += result.finalGuard.refutations;
        if (result.finalGuard.selectedActionRejected) stats.selectedActionRejections += 1;
        if (result.finalGuard.selectedActionWasRefuted) stats.selectedActionWasRefuted += 1;
        if (result.finalGuard.fallbackToUnverified) stats.unverifiedFallbacks += 1;
        if (result.finalGuard.fallbackToZeroVisit) stats.zeroVisitFallbacks += 1;
        if (result.finalGuard.allCheckedRefuted) stats.allCheckedRefuted += 1;
        if (result.finalGuard.allRootActionsRefuted) stats.allRootActionsRefuted += 1;
        if (result.finalGuard.provenLosingFallback) stats.provenLosingFallbacks += 1;
        stats.outcomes[result.finalGuard.outcome] += 1;

        const invalidProvenFallback =
          result.finalGuard.provenLosingFallback &&
          (!result.finalGuard.allRootActionsRefuted ||
            result.finalGuard.uncheckedActionsRemaining !== 0);
        const invalidZeroVisit =
          result.finalGuard.fallbackToZeroVisit && result.finalGuard.chosenVisits !== 0;
        if (invalidProvenFallback || invalidZeroVisit) stats.invariantViolations += 1;

        return { action: result.action, guard: result.finalGuard, elapsedMs };
      };

      const play = async (
        matchup: "PREVIOUS" | "CURRENT",
        pairIndex: number,
        candidatePlayer: Player,
      ) => {
        let state = deterministicOpening(pairIndex);
        let lastCandidateDecision = null;
        while (!state.winner && state.moveHistory.length < maxMoves) {
          const candidateTurn = state.currentPlayer === candidatePlayer;
          const kind: AgentKind = candidateTurn
            ? "CANDIDATE"
            : matchup === "PREVIOUS"
              ? "CHAMPION"
              : "CURRENT";
          const decision = await choose(kind, state);
          const legal = new Set([
            ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
            KATACAT_PASS_INDEX,
          ]);
          expect(legal.has(encodeKataCatPuctAction(decision.action))).toBe(true);
          if (candidateTurn) {
            lastCandidateDecision = {
              ply: state.moveHistory.length,
              ...compactGuard(decision.guard, decision.elapsedMs, decision.action),
            };
          }
          state = applyAction(state, decision.action);
        }
        if (!state.winner || !state.winReason) {
          throw new Error(`${matchup} pair ${pairIndex} did not finish in ${maxMoves} plies`);
        }
        const candidateWon = state.winner === candidatePlayer;
        const rawMarginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
        return {
          matchup,
          pairIndex,
          candidatePlayer,
          winner: state.winner,
          winReason: state.winReason,
          plies: state.moveHistory.length,
          candidateWon,
          candidateCaptureLoss: !candidateWon && state.winReason === "CAPTURE",
          candidateTerritoryMargin:
            state.winReason === "TERRITORY"
              ? candidatePlayer === "A"
                ? rawMarginA
                : -rawMarginA
              : null,
          lastCandidateDecision,
        };
      };

      for (const matchup of ["PREVIOUS", "CURRENT"] as const) {
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          games.push(await play(matchup, pairIndex, "A"));
          games.push(await play(matchup, pairIndex, "B"));
        }
      }

      for (const stats of Object.values(agentStats)) {
        stats.meanDecisionMs = stats.decisions > 0 ? stats.totalDecisionMs / stats.decisions : 0;
      }

      const summarizeSeat = (subset, seat: Player) => {
        const seated = subset.filter((game) => game.candidatePlayer === seat);
        const wins = seated.filter((game) => game.candidateWon).length;
        return { games: seated.length, wins, losses: seated.length - wins, winRate: wins / seated.length };
      };

      const summarize = (matchup: "PREVIOUS" | "CURRENT") => {
        const subset = games.filter((game) => game.matchup === matchup);
        const wins = subset.filter((game) => game.candidateWon).length;
        const captureLosses = subset.filter((game) => game.candidateCaptureLoss).length;
        const margins = subset
          .map((game) => game.candidateTerritoryMargin)
          .filter((value): value is number => value !== null);
        return {
          games: subset.length,
          wins,
          losses: subset.length - wins,
          winRate: wins / subset.length,
          captureLosses,
          captureLossRate: captureLosses / subset.length,
          territoryGames: margins.length,
          meanCandidateTerritoryMargin:
            margins.length > 0 ? margins.reduce((sum, value) => sum + value, 0) / margins.length : null,
          byCandidateSeat: {
            A: summarizeSeat(subset, "A"),
            B: summarizeSeat(subset, "B"),
          },
        };
      };

      const previous = summarize("PREVIOUS");
      const current = summarize("CURRENT");
      const candidateLossContexts = games
        .filter((game) => !game.candidateWon)
        .map((game) => ({
          matchup: game.matchup,
          pairIndex: game.pairIndex,
          candidatePlayer: game.candidatePlayer,
          plies: game.plies,
          winReason: game.winReason,
          lastCandidateDecision: game.lastCandidateDecision,
        }));
      const smokeAcceptance = {
        allGamesCompleted: games.length === gamesPerOpponent * 2,
        mirroredPairing: games.every((game) =>
          games.some(
            (other) =>
              other.matchup === game.matchup &&
              other.pairIndex === game.pairIndex &&
              other.candidatePlayer !== game.candidatePlayer,
          ),
        ),
        legalMovesOnly: true,
        candidateAndChampionInferenceCompleted:
          agentStats.CANDIDATE.decisions > 0 && agentStats.CHAMPION.decisions > 0,
        currentVeryHardCompleted: agentStats.CURRENT.decisions > 0,
        equalTacticalShellForPreviousMatchup: true,
        candidateFinalVerificationCompleted: agentStats.CANDIDATE.finalVerificationChecks > 0,
        championFinalVerificationCompleted: agentStats.CHAMPION.finalVerificationChecks > 0,
        zeroVisitFallbackInvariant:
          agentStats.CANDIDATE.invariantViolations === 0 &&
          agentStats.CHAMPION.invariantViolations === 0,
        lossContextReported: candidateLossContexts.every((game) => game.lastCandidateDecision !== null),
        decisionTimingReported:
          agentStats.CANDIDATE.meanDecisionMs >= 0 &&
          agentStats.CHAMPION.meanDecisionMs >= 0 &&
          agentStats.CURRENT.meanDecisionMs >= 0,
        noRandomRollouts: true,
        passed: false,
      };
      smokeAcceptance.passed = Object.entries(smokeAcceptance)
        .filter(([key]) => key !== "passed")
        .every(([, value]) => value === true);

      const promotion = {
        minimumMirroredGamesPerOpponent: gamesPerOpponent >= 400,
        previousChampionWinRate: previous.winRate,
        previousChampionThreshold: previousThreshold,
        beatsPreviousChampion: previous.winRate >= previousThreshold,
        currentVeryHardWinRate: current.winRate,
        currentVeryHardThreshold: currentThreshold,
        beatsCurrentVeryHard: current.winRate >= currentThreshold,
        passed: false,
      };
      promotion.passed =
        promotion.minimumMirroredGamesPerOpponent &&
        promotion.beatsPreviousChampion &&
        promotion.beatsCurrentVeryHard;

      const report = {
        schemaVersion: 1,
        stage: "M3.2.1_ARENA",
        options: {
          gamesPerOpponent,
          simulations,
          currentMs,
          maxMoves,
          captureReadDepth,
          captureAttackMs,
          captureDefenseMs,
          captureDefenseLimit,
          finalVerificationMs,
          finalVerificationLimit,
        },
        previousChampion: previous,
        currentVeryHard: current,
        agents: agentStats,
        candidateLossContexts,
        smokeAcceptance,
        promotion,
        games,
        note:
          "M3.2.1 keeps zero-visit legal root edges as unknown fallbacks. A proved losing action is reused only when every root action was explicitly refuted, which is reported as an unavoidable forced loss. The candidate checkpoint and training recipe are unchanged from M3.2.",
      };
      const outputDir = resolve(env.KATACAT_M321_OUTPUT_DIR ?? "katacat-m321-output");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(resolve(outputDir, "arena-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`KATACAT_M321_ARENA:${JSON.stringify(report)}`);
      expect(smokeAcceptance.passed).toBe(true);
    },
    7_200_000,
  );
});
