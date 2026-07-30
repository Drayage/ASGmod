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
import { searchKataCatPuctWithFinalGuard } from "./katacatFinalGuard";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M33_ARENA === "1";
const suite = enabled ? describe : describe.skip;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
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
  const lastAction = !previous || previous.type === "PASS"
    ? KATACAT_PASS_INDEX
    : previous.row * BOARD_SIZE + previous.col;
  return {
    board: encodeBoard(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    legalActions: [
      ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
      KATACAT_PASS_INDEX,
    ],
    currentPlayer: state.currentPlayer,
    lastAction,
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

  constructor(checkpoint: string, script: string) {
    const python = env.PYTHON ?? "python";
    this.child = spawn(python, [script, `--checkpoint=${checkpoint}`], {
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

function emptyStats() {
  return {
    decisions: 0,
    totalDecisionMs: 0,
    meanDecisionMs: 0,
    forcedCaptureMoves: 0,
    rescueSelections: 0,
    adaptiveSelections: 0,
    unverifiedFallbacks: 0,
    allRootActionsRefuted: 0,
    invariantViolations: 0,
    outcomes: {},
  };
}

suite("KataCat M3.3 player-relative fair arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let champion: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M33_CANDIDATE_CHECKPOINT;
    const championCheckpoint = env.KATACAT_M33_CHAMPION_CHECKPOINT;
    if (!candidateCheckpoint || !championCheckpoint) {
      throw new Error("KATACAT_M33 candidate and champion checkpoints are required");
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint, "ml/katacat_m33_infer.py");
    champion = new PythonCheckpointEvaluator(championCheckpoint, "ml/katacat_m1_infer.py");
    await Promise.all([candidate.ready, champion.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), champion?.close()]);
  });

  it("compares relative candidate with the frozen absolute champion under identical guards", async () => {
    const gamesPerOpponent = positiveInt(env.KATACAT_M33_GAMES_PER_OPPONENT, 16);
    if (gamesPerOpponent % 2 !== 0) throw new Error("games per opponent must be even");
    const simulations = positiveInt(env.KATACAT_M33_SIMULATIONS, 32);
    const currentMs = positiveInt(env.KATACAT_M33_CURRENT_MS, 50);
    const maxMoves = positiveInt(env.KATACAT_M33_MAX_MOVES, 90);
    const captureDepth = positiveInt(env.KATACAT_M33_CAPTURE_DEPTH, 7);
    const captureAttackMs = positiveInt(env.KATACAT_M33_CAPTURE_ATTACK_MS, 25);
    const captureDefenseMs = positiveInt(env.KATACAT_M33_CAPTURE_DEFENSE_MS, 50);
    const captureDefenseLimit = positiveInt(env.KATACAT_M33_CAPTURE_DEFENSE_LIMIT, 12);
    const finalVerifyMs = positiveInt(env.KATACAT_M33_FINAL_VERIFY_MS, 75);
    const finalVerifyLimit = positiveInt(env.KATACAT_M33_FINAL_VERIFY_LIMIT, 5);
    const rescueCurrentMs = positiveInt(env.KATACAT_M33_RESCUE_CURRENT_MS, 50);
    const rescueVerifyMs = positiveInt(env.KATACAT_M33_RESCUE_VERIFY_MS, 50);
    const rescueVerifyLimit = positiveInt(env.KATACAT_M33_RESCUE_VERIFY_LIMIT, 8);
    const rescueTotalMs = positiveInt(env.KATACAT_M33_RESCUE_TOTAL_MS, 450);
    const pairCount = gamesPerOpponent / 2;
    const games = [];
    const stats = { CANDIDATE: emptyStats(), CHAMPION: emptyStats(), CURRENT: emptyStats() };

    const choose = async (kind: "CANDIDATE" | "CHAMPION" | "CURRENT", state: GameState) => {
      const started = Date.now();
      if (kind === "CURRENT") {
        const action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
        const elapsedMs = Date.now() - started;
        stats.CURRENT.decisions += 1;
        stats.CURRENT.totalDecisionMs += elapsedMs;
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
      if (result.finalGuard.outcome === "VERIFIED_RESCUE") target.rescueSelections += 1;
      if (result.finalGuard.outcome === "VERIFIED_ADAPTIVE") target.adaptiveSelections += 1;
      if (result.finalGuard.fallbackToUnverified) target.unverifiedFallbacks += 1;
      if (result.finalGuard.allRootActionsRefuted) target.allRootActionsRefuted += 1;
      target.outcomes[result.finalGuard.outcome] = (target.outcomes[result.finalGuard.outcome] ?? 0) + 1;
      const invalid =
        (result.finalGuard.provenLosingFallback &&
          (!result.finalGuard.allRootActionsRefuted || result.finalGuard.uncheckedActionsRemaining !== 0)) ||
        (result.finalGuard.fallbackToZeroVisit && result.finalGuard.chosenVisits !== 0);
      if (invalid) target.invariantViolations += 1;
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
        const kind = candidateTurn ? "CANDIDATE" : matchup === "PREVIOUS" ? "CHAMPION" : "CURRENT";
        const decision = await choose(kind, state);
        const legal = new Set([
          ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
          KATACAT_PASS_INDEX,
        ]);
        expect(legal.has(encodeKataCatPuctAction(decision.action))).toBe(true);
        if (candidateTurn) {
          lastCandidateDecision = decision.guard
            ? {
                ply: state.moveHistory.length,
                actionIndex: encodeKataCatPuctAction(decision.action),
                outcome: decision.guard.outcome,
                selectedActionWasRefuted: decision.guard.selectedActionWasRefuted,
                fallbackToUnverified: decision.guard.fallbackToUnverified,
                allRootActionsRefuted: decision.guard.allRootActionsRefuted,
                chosenRank: decision.guard.chosenRank,
                uncheckedActionsRemaining: decision.guard.uncheckedActionsRemaining,
                decisionMs: decision.elapsedMs,
              }
            : null;
        }
        state = applyAction(state, decision.action);
      }
      if (!state.winner || !state.winReason) {
        throw new Error(`${matchup} pair ${pairIndex} did not finish in ${maxMoves} plies`);
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
    for (const value of Object.values(stats)) {
      value.meanDecisionMs = value.decisions ? value.totalDecisionMs / value.decisions : 0;
    }

    const summarizeSeat = (subset, seat: Player) => {
      const seated = subset.filter((game) => game.candidatePlayer === seat);
      const wins = seated.filter((game) => game.candidateWon).length;
      return { games: seated.length, wins, losses: seated.length - wins, winRate: wins / seated.length };
    };
    const pairSummary = (subset) => {
      const counts = { sweeps: 0, splits: 0, swept: 0 };
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const pair = subset.filter((game) => game.pairIndex === pairIndex);
        const wins = pair.filter((game) => game.candidateWon).length;
        if (wins === 2) counts.sweeps += 1;
        else if (wins === 1) counts.splits += 1;
        else counts.swept += 1;
      }
      return counts;
    };
    const summarize = (matchup: "PREVIOUS" | "CURRENT") => {
      const subset = games.filter((game) => game.matchup === matchup);
      const wins = subset.filter((game) => game.candidateWon).length;
      const captureLosses = subset.filter((game) => game.candidateCaptureLoss).length;
      const margins = subset.map((game) => game.candidateTerritoryMargin).filter((value) => value !== null);
      return {
        games: subset.length,
        wins,
        losses: subset.length - wins,
        winRate: wins / subset.length,
        captureLosses,
        captureLossRate: captureLosses / subset.length,
        territoryGames: margins.length,
        meanCandidateTerritoryMargin: margins.length
          ? margins.reduce((sum, value) => sum + value, 0) / margins.length
          : null,
        byCandidateSeat: { A: summarizeSeat(subset, "A"), B: summarizeSeat(subset, "B") },
        mirroredPairs: pairSummary(subset),
      };
    };

    const previous = summarize("PREVIOUS");
    const current = summarize("CURRENT");
    const lossContexts = games.filter((game) => !game.candidateWon).map((game) => ({
      matchup: game.matchup,
      pairIndex: game.pairIndex,
      candidatePlayer: game.candidatePlayer,
      plies: game.plies,
      winReason: game.winReason,
      lastCandidateDecision: game.lastCandidateDecision,
    }));
    const smokeAcceptance = {
      allGamesCompleted: games.length === gamesPerOpponent * 2,
      mirroredPairing: games.every((game) => games.some((other) =>
        other.matchup === game.matchup &&
        other.pairIndex === game.pairIndex &&
        other.candidatePlayer !== game.candidatePlayer
      )),
      legalMovesOnly: true,
      relativeCandidateInferenceCompleted: stats.CANDIDATE.decisions > 0,
      absoluteChampionInferenceCompleted: stats.CHAMPION.decisions > 0,
      currentVeryHardCompleted: stats.CURRENT.decisions > 0,
      equalTacticalShellAndRescueForPreviousMatchup: true,
      mirroredPairSummaryReported: previous.mirroredPairs.sweeps + previous.mirroredPairs.splits + previous.mirroredPairs.swept === pairCount,
      finalGuardInvariant: stats.CANDIDATE.invariantViolations === 0 && stats.CHAMPION.invariantViolations === 0,
      bothCandidateSeatsMeasured: previous.byCandidateSeat.A.games > 0 && previous.byCandidateSeat.B.games > 0,
      noRandomRollouts: true,
      passed: false,
    };
    smokeAcceptance.passed = Object.entries(smokeAcceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);
    const report = {
      schemaVersion: 1,
      stage: "M3.3_ARENA",
      options: {
        gamesPerOpponent,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        finalVerifyMs,
        finalVerifyLimit,
        rescueCurrentMs,
        rescueVerifyMs,
        rescueVerifyLimit,
        rescueTotalMs,
      },
      previousChampion: previous,
      currentVeryHard: current,
      agents: stats,
      candidateLossContexts: lossContexts,
      smokeAcceptance,
      promotion: {
        minimumMirroredGamesPerOpponent: gamesPerOpponent >= 400,
        beatsPreviousChampion: previous.winRate >= 0.525,
        beatsCurrentVeryHard: current.winRate >= 0.55,
        passed: gamesPerOpponent >= 400 && previous.winRate >= 0.525 && current.winRate >= 0.55,
      },
      games,
      note: "M3.3 compares a fresh player-relative model against the frozen M3.1 absolute model. Both neural agents receive the same root tactical shell, CURRENT rescue, adaptive scan, openings, simulations, and seat mirrors. Smoke results never promote a model.",
    };
    const outputDir = resolve(env.KATACAT_M33_OUTPUT_DIR ?? "katacat-m33-output");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "arena-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`KATACAT_M33_ARENA:${JSON.stringify(report)}`);
    expect(smokeAcceptance.passed).toBe(true);
  }, 7_200_000);
});
