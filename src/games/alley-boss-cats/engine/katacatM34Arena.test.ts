// @ts-nocheck -- Opt-in integration arena uses Node child processes and filesystem APIs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction, getSafeActions } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState, Player } from "../types";
import { searchKataCatPuctWithFinalGuard } from "./katacatFinalGuard";
import { findBestMoveVeryHard } from "./minimax";
import { encodeKataCatPuctAction, KATACAT_PASS_INDEX } from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M34_ARENA === "1";
const suite = enabled ? describe : describe.skip;

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

function inferenceRequest(state: GameState) {
  const previous = state.moveHistory[state.moveHistory.length - 1];
  return {
    board: encodeBoard(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    legalActions: [
      ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
      KATACAT_PASS_INDEX,
    ],
    currentPlayer: state.currentPlayer,
    lastAction: !previous || previous.type === "PASS"
      ? KATACAT_PASS_INDEX
      : previous.row * BOARD_SIZE + previous.col,
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
  let cursor = (pairIndex * 41 + 13) >>> 0;
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

function emptyAgentStats() {
  return {
    decisions: 0,
    totalDecisionMs: 0,
    meanDecisionMs: 0,
    forcedCaptureMoves: 0,
    originalSelectionRefuted: 0,
    unverifiedFallbacks: 0,
    allRootActionsRefuted: 0,
    rescueSelections: 0,
    adaptiveSelections: 0,
    outcomes: {},
  };
}

function summarize(games, matchup) {
  const rows = games.filter((game) => game.matchup === matchup);
  const bySeat = Object.fromEntries(["A", "B"].map((seat) => {
    const seatRows = rows.filter((game) => game.candidatePlayer === seat);
    const wins = seatRows.filter((game) => game.candidateWon).length;
    return [seat, {
      games: seatRows.length,
      wins,
      losses: seatRows.length - wins,
      winRate: wins / Math.max(1, seatRows.length),
    }];
  }));
  const wins = rows.filter((game) => game.candidateWon).length;
  const losses = rows.length - wins;
  const territoryRows = rows.filter((game) => game.candidateTerritoryMargin !== null);
  const pairs = new Map();
  for (const game of rows) {
    const bucket = pairs.get(game.pairIndex) ?? [];
    bucket.push(game);
    pairs.set(game.pairIndex, bucket);
  }
  let sweeps = 0;
  let splits = 0;
  let swept = 0;
  for (const pair of pairs.values()) {
    const pairWins = pair.filter((game) => game.candidateWon).length;
    if (pairWins === 2) sweeps += 1;
    else if (pairWins === 1) splits += 1;
    else swept += 1;
  }
  return {
    games: rows.length,
    wins,
    losses,
    winRate: wins / Math.max(1, rows.length),
    captureLosses: rows.filter((game) => game.candidateCaptureLoss).length,
    captureLossRate: rows.filter((game) => game.candidateCaptureLoss).length / Math.max(1, rows.length),
    territoryGames: territoryRows.length,
    meanCandidateTerritoryMargin: territoryRows.length > 0
      ? territoryRows.reduce((sum, game) => sum + game.candidateTerritoryMargin, 0) / territoryRows.length
      : null,
    byCandidateSeat: bySeat,
    absoluteSeatWinRateGap: Math.abs(bySeat.A.winRate - bySeat.B.winRate),
    mirroredPairs: { pairs: pairs.size, sweeps, splits, swept },
    lossDiagnostics: {
      losses,
      originalSelectionRefutedLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.selectedActionWasRefuted,
      ).length,
      unverifiedFallbackLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.fallbackToUnverified,
      ).length,
      allRootActionsRefutedLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.allRootActionsRefuted,
      ).length,
    },
  };
}

suite("KataCat M3.4 controlled arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let previous: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M34_CANDIDATE_CHECKPOINT;
    const previousCheckpoint = env.KATACAT_M34_PREVIOUS_CHECKPOINT;
    if (!candidateCheckpoint || !previousCheckpoint) {
      throw new Error("KATACAT_M34_CANDIDATE_CHECKPOINT and KATACAT_M34_PREVIOUS_CHECKPOINT are required");
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint);
    previous = new PythonCheckpointEvaluator(previousCheckpoint);
    await Promise.all([candidate.ready, previous.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), previous?.close()]);
  });

  it("compares hard-negative candidate against frozen M3.3 and CURRENT", async () => {
    const gamesPerOpponent = positiveInt("KATACAT_M34_GAMES_PER_OPPONENT", 32);
    if (gamesPerOpponent % 2 !== 0) throw new Error("games per opponent must be even");
    const simulations = positiveInt("KATACAT_M34_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M34_CURRENT_MS", 50);
    const maxMoves = positiveInt("KATACAT_M34_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M34_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M34_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M34_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M34_CAPTURE_DEFENSE_LIMIT", 12);
    const finalVerifyMs = positiveInt("KATACAT_M34_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M34_FINAL_VERIFY_LIMIT", 5);
    const rescueCurrentMs = positiveInt("KATACAT_M34_RESCUE_CURRENT_MS", 50);
    const rescueVerifyMs = positiveInt("KATACAT_M34_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M34_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M34_RESCUE_TOTAL_MS", 450);
    const outputDir = resolve(env.KATACAT_M34_ARENA_OUTPUT_DIR ?? "katacat-m34-output");
    const pairCount = gamesPerOpponent / 2;
    const games = [];
    const stats = {
      CANDIDATE: emptyAgentStats(),
      PREVIOUS: emptyAgentStats(),
      CURRENT: emptyAgentStats(),
    };
    let legalMovesOnly = true;

    const choose = async (kind: "CANDIDATE" | "PREVIOUS" | "CURRENT", state: GameState) => {
      const started = Date.now();
      if (kind === "CURRENT") {
        const action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
        const elapsedMs = Date.now() - started;
        stats.CURRENT.decisions += 1;
        stats.CURRENT.totalDecisionMs += elapsedMs;
        return { action, guard: null, elapsedMs };
      }
      const evaluator = kind === "CANDIDATE" ? candidate : previous;
      const result = await searchKataCatPuctWithFinalGuard(
        state,
        evaluator,
        {
          simulations,
          cpuct: 1.35,
          neuralPriorWeight: 0.75,
          scoreValueWeight: 0.05,
          tacticalShell: true,
          captureReadDepth: captureDepth,
          captureAttackMs,
          captureDefenseMs,
          captureDefenseLimit,
        },
        {
          finalVerificationDepth: captureDepth,
          finalVerificationMs: finalVerifyMs,
          finalVerificationLimit: finalVerifyLimit,
          rescueVerificationLimit: rescueVerifyLimit,
          rescueVerificationMs: rescueVerifyMs,
          rescueTotalMs,
        },
        (rescueState, rescuePlayer) => findBestMoveVeryHard(rescueState, rescuePlayer, rescueCurrentMs),
      );
      const elapsedMs = Date.now() - started;
      const target = stats[kind];
      target.decisions += 1;
      target.totalDecisionMs += elapsedMs;
      if (result.reason === "FORCED_CAPTURE") target.forcedCaptureMoves += 1;
      if (result.finalGuard.selectedActionWasRefuted) target.originalSelectionRefuted += 1;
      if (result.finalGuard.fallbackToUnverified) target.unverifiedFallbacks += 1;
      if (result.finalGuard.allRootActionsRefuted) target.allRootActionsRefuted += 1;
      if (result.finalGuard.outcome === "VERIFIED_RESCUE") target.rescueSelections += 1;
      if (result.finalGuard.outcome === "VERIFIED_ADAPTIVE") target.adaptiveSelections += 1;
      target.outcomes[result.finalGuard.outcome] = (target.outcomes[result.finalGuard.outcome] ?? 0) + 1;
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
        const kind = candidateTurn ? "CANDIDATE" : matchup;
        const decision = await choose(kind, state);
        const legal = new Set([
          ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
          KATACAT_PASS_INDEX,
        ]);
        if (!legal.has(encodeKataCatPuctAction(decision.action))) legalMovesOnly = false;
        if (candidateTurn && decision.guard) {
          lastCandidateDecision = {
            ply: state.moveHistory.length,
            actionIndex: encodeKataCatPuctAction(decision.action),
            outcome: decision.guard.outcome,
            selectedActionWasRefuted: decision.guard.selectedActionWasRefuted,
            fallbackToUnverified: decision.guard.fallbackToUnverified,
            allRootActionsRefuted: decision.guard.allRootActionsRefuted,
            chosenRank: decision.guard.chosenRank,
            uncheckedActionsRemaining: decision.guard.uncheckedActionsRemaining,
            decisionMs: decision.elapsedMs,
          };
        }
        state = applyAction(state, decision.action);
      }
      if (!state.winner || !state.winReason) {
        throw new Error(`${matchup} pair ${pairIndex}/${candidatePlayer} did not finish`);
      }
      const candidateWon = state.winner === candidatePlayer;
      const marginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
      return {
        matchup,
        pairIndex,
        candidatePlayer,
        winner: state.winner,
        winReason: state.winReason,
        plies: state.moveHistory.length,
        candidateWon,
        candidateCaptureLoss: !candidateWon && state.winReason === "CAPTURE",
        candidateTerritoryMargin: state.winReason === "TERRITORY"
          ? candidatePlayer === "A" ? marginA : -marginA
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

    for (const target of Object.values(stats)) {
      target.meanDecisionMs = target.totalDecisionMs / Math.max(1, target.decisions);
    }
    const previousSummary = summarize(games, "PREVIOUS");
    const currentSummary = summarize(games, "CURRENT");
    const acceptance = {
      allGamesCompleted: games.length === gamesPerOpponent * 2,
      mirroredPairing: previousSummary.mirroredPairs.pairs === pairCount
        && currentSummary.mirroredPairs.pairs === pairCount,
      legalMovesOnly,
      bothRelativeCheckpointsCompleted: stats.CANDIDATE.decisions > 0 && stats.PREVIOUS.decisions > 0,
      currentVeryHardCompleted: stats.CURRENT.decisions > 0,
      identicalTacticalSettingsForPreviousMatchup: true,
      hardNegativeDiagnosticsReported: Number.isFinite(stats.CANDIDATE.originalSelectionRefuted),
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);
    const promotion = {
      minimum400GamesPerOpponent: gamesPerOpponent >= 400,
      previousThreshold: 0.525,
      currentThreshold: 0.55,
      beatsPrevious: previousSummary.winRate >= 0.525,
      beatsCurrent: currentSummary.winRate >= 0.55,
      passed: false,
    };
    promotion.passed = promotion.minimum400GamesPerOpponent
      && promotion.beatsPrevious
      && promotion.beatsCurrent;
    const summary = {
      schemaVersion: 1,
      stage: "M3.4_ARENA",
      options: {
        gamesPerOpponent,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        finalVerifyMs,
        finalVerifyLimit,
        rescueVerifyMs,
        rescueVerifyLimit,
        rescueTotalMs,
      },
      previousM33: previousSummary,
      currentVeryHard: currentSummary,
      agents: stats,
      acceptance,
      promotion,
      games,
      note: "M3.4 changes only the player-relative checkpoint. Candidate and frozen M3.3 use identical PUCT, tactical shell, final verification, CURRENT rescue, and adaptive scan settings. Smoke results do not promote a model.",
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "arena-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M34_ARENA:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 3_600_000);
});
