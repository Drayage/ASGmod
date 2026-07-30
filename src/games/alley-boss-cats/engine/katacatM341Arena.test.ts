// @ts-nocheck -- Opt-in multi-phase arena uses Node child processes and filesystem APIs.
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
import { searchKataCatPuctWithFinalGuard } from "./katacatFinalGuard";
import { searchKataCatPuctWithM341Fallback } from "./katacatM341Fallback";
import { kataCatStateHash } from "./katacatM0";
import { findBestMoveVeryHard } from "./minimax";
import { encodeKataCatPuctAction, KATACAT_PASS_INDEX } from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M341_ARENA === "1";
const suite = enabled ? describe : describe.skip;

type ModelKind = "PARENT" | "CANDIDATE";
type FallbackKind = "OLD" | "IMPROVED";
type ConfigKind = "PARENT_OLD" | "CANDIDATE_OLD" | "PARENT_IMPROVED" | "CANDIDATE_IMPROVED";

interface ComparisonDefinition {
  id: string;
  candidateConfig: ConfigKind;
  opponentConfig: ConfigKind | "CURRENT";
}

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
  const prefixLength = [0, 2, 4, 6, 8, 10, 12, 14][pairIndex % 8];
  let cursor = (pairIndex * 41 + 13) >>> 0;
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

function modelFor(config: ConfigKind): ModelKind {
  return config.startsWith("PARENT") ? "PARENT" : "CANDIDATE";
}

function fallbackFor(config: ConfigKind): FallbackKind {
  return config.endsWith("IMPROVED") ? "IMPROVED" : "OLD";
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
    improvedFallbackAttempts: 0,
    improvedFallbackSelections: 0,
    improvedFallbackChecks: 0,
    preventedUnverifiedFallbacks: 0,
    outcomes: {},
  };
}

function wilson(wins: number, games: number) {
  if (games <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = wins / games;
  const denominator = 1 + (z * z) / games;
  const center = (p + (z * z) / (2 * games)) / denominator;
  const spread = (
    z * Math.sqrt((p * (1 - p)) / games + (z * z) / (4 * games * games))
  ) / denominator;
  return { low: center - spread, high: center + spread };
}

function summarize(games, comparisonId) {
  const rows = games.filter((game) => game.comparisonId === comparisonId);
  const bySeat = Object.fromEntries(["A", "B"].map((seat) => {
    const seatRows = rows.filter((game) => game.candidatePlayer === seat);
    const wins = seatRows.filter((game) => game.candidateWon).length;
    return [seat, {
      games: seatRows.length,
      wins,
      losses: seatRows.length - wins,
      winRate: wins / Math.max(1, seatRows.length),
      wilson95: wilson(wins, seatRows.length),
      fallbackLastDecisionLosses: seatRows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.fallbackToUnverified,
      ).length,
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
  let malformed = 0;
  for (const pair of pairs.values()) {
    if (pair.length !== 2) {
      malformed += 1;
      continue;
    }
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
    wilson95: wilson(wins, rows.length),
    captureLosses: rows.filter((game) => game.candidateCaptureLoss).length,
    captureLossRate: rows.filter((game) => game.candidateCaptureLoss).length / Math.max(1, rows.length),
    territoryGames: territoryRows.length,
    meanCandidateTerritoryMargin: territoryRows.length > 0
      ? territoryRows.reduce((sum, game) => sum + game.candidateTerritoryMargin, 0) / territoryRows.length
      : null,
    byCandidateSeat: bySeat,
    absoluteSeatWinRateGap: Math.abs(bySeat.A.winRate - bySeat.B.winRate),
    mirroredPairs: { pairs: pairs.size, sweeps, splits, swept, malformed },
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
      improvedFallbackLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.improvedFallbackSelected,
      ).length,
    },
  };
}

function comparisonsForPhase(phase: string): ComparisonDefinition[] {
  if (phase === "promotion") {
    return [
      {
        id: "CANDIDATE_IMPROVED_VS_PARENT_IMPROVED",
        candidateConfig: "CANDIDATE_IMPROVED",
        opponentConfig: "PARENT_IMPROVED",
      },
      {
        id: "CANDIDATE_IMPROVED_VS_CURRENT",
        candidateConfig: "CANDIDATE_IMPROVED",
        opponentConfig: "CURRENT",
      },
    ];
  }
  return [
    { id: "PARENT_OLD_VS_CURRENT", candidateConfig: "PARENT_OLD", opponentConfig: "CURRENT" },
    { id: "CANDIDATE_OLD_VS_CURRENT", candidateConfig: "CANDIDATE_OLD", opponentConfig: "CURRENT" },
    { id: "PARENT_IMPROVED_VS_CURRENT", candidateConfig: "PARENT_IMPROVED", opponentConfig: "CURRENT" },
    { id: "CANDIDATE_IMPROVED_VS_CURRENT", candidateConfig: "CANDIDATE_IMPROVED", opponentConfig: "CURRENT" },
    { id: "CANDIDATE_OLD_VS_PARENT_OLD", candidateConfig: "CANDIDATE_OLD", opponentConfig: "PARENT_OLD" },
    {
      id: "CANDIDATE_IMPROVED_VS_PARENT_IMPROVED",
      candidateConfig: "CANDIDATE_IMPROVED",
      opponentConfig: "PARENT_IMPROVED",
    },
  ];
}

suite("KataCat M3.4.1 four-configuration paired arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let parent: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M341_CANDIDATE_CHECKPOINT;
    const parentCheckpoint = env.KATACAT_M341_PARENT_CHECKPOINT;
    if (!candidateCheckpoint || !parentCheckpoint) {
      throw new Error("KATACAT_M341 candidate and parent checkpoints are required");
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint);
    parent = new PythonCheckpointEvaluator(parentCheckpoint);
    await Promise.all([candidate.ready, parent.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), parent?.close()]);
  });

  it("runs the requested phase on identical paired openings and saves loss replays", async () => {
    const phase = env.KATACAT_M341_PHASE ?? "smoke";
    const gamesPerComparison = positiveInt("KATACAT_M341_GAMES_PER_COMPARISON", 32);
    if (gamesPerComparison % 2 !== 0) throw new Error("games per comparison must be even");
    const simulations = positiveInt("KATACAT_M341_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M341_CURRENT_MS", 50);
    const maxMoves = positiveInt("KATACAT_M341_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M341_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M341_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M341_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M341_CAPTURE_DEFENSE_LIMIT", 12);
    const finalVerifyMs = positiveInt("KATACAT_M341_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M341_FINAL_VERIFY_LIMIT", 5);
    const rescueCurrentMs = positiveInt("KATACAT_M341_RESCUE_CURRENT_MS", 50);
    const rescueVerifyMs = positiveInt("KATACAT_M341_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M341_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M341_RESCUE_TOTAL_MS", 450);
    const exhaustiveVerifyMs = positiveInt("KATACAT_M341_EXHAUSTIVE_VERIFY_MS", 25);
    const outputDir = resolve(env.KATACAT_M341_ARENA_OUTPUT_DIR ?? `katacat-m341-${phase}`);
    const pairCount = gamesPerComparison / 2;
    const comparisons = comparisonsForPhase(phase);
    const games = [];
    const stats = {
      PARENT_OLD: emptyAgentStats(),
      CANDIDATE_OLD: emptyAgentStats(),
      PARENT_IMPROVED: emptyAgentStats(),
      CANDIDATE_IMPROVED: emptyAgentStats(),
      CURRENT: emptyAgentStats(),
    };
    let legalMovesOnly = true;

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
    const rescue = (state, player) => findBestMoveVeryHard(state, player, rescueCurrentMs);

    const choose = async (kind: ConfigKind | "CURRENT", state: GameState) => {
      const started = Date.now();
      if (kind === "CURRENT") {
        const action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
        const elapsedMs = Date.now() - started;
        stats.CURRENT.decisions += 1;
        stats.CURRENT.totalDecisionMs += elapsedMs;
        return { action, guard: null, elapsedMs };
      }
      const evaluator = modelFor(kind) === "CANDIDATE" ? candidate : parent;
      const result = fallbackFor(kind) === "IMPROVED"
        ? await searchKataCatPuctWithM341Fallback(
            state,
            evaluator,
            puctOptions,
            guardOptions,
            improvedOptions,
            rescue,
          )
        : await searchKataCatPuctWithFinalGuard(
            state,
            evaluator,
            puctOptions,
            guardOptions,
            rescue,
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
      if (result.finalGuard.improvedFallbackAttempted) target.improvedFallbackAttempts += 1;
      if (result.finalGuard.improvedFallbackSelected) target.improvedFallbackSelections += 1;
      if (result.finalGuard.improvedFallbackChecks) {
        target.improvedFallbackChecks += result.finalGuard.improvedFallbackChecks;
      }
      if (result.finalGuard.preventedUnverifiedFallback) {
        target.preventedUnverifiedFallbacks += 1;
      }
      target.outcomes[result.finalGuard.outcome] = (target.outcomes[result.finalGuard.outcome] ?? 0) + 1;
      return { action: result.action, guard: result.finalGuard, elapsedMs };
    };

    const play = async (
      comparison: ComparisonDefinition,
      pairIndex: number,
      candidatePlayer: Player,
    ) => {
      const opened = deterministicOpening(pairIndex);
      let state = opened.state;
      let lastCandidateDecision = null;
      const moves = [];
      while (!state.winner && state.moveHistory.length < maxMoves) {
        const candidateTurn = state.currentPlayer === candidatePlayer;
        const kind = candidateTurn ? comparison.candidateConfig : comparison.opponentConfig;
        const preStateHash = kataCatStateHash(state);
        const decision = await choose(kind, state);
        const legal = new Set([
          ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
          KATACAT_PASS_INDEX,
        ]);
        const actionIndex = encodeKataCatPuctAction(decision.action);
        if (!legal.has(actionIndex)) legalMovesOnly = false;
        const compactGuard = decision.guard
          ? {
              outcome: decision.guard.outcome,
              selectedActionWasRefuted: decision.guard.selectedActionWasRefuted,
              fallbackToUnverified: decision.guard.fallbackToUnverified,
              allRootActionsRefuted: decision.guard.allRootActionsRefuted,
              chosenRank: decision.guard.chosenRank,
              uncheckedActionsRemaining: decision.guard.uncheckedActionsRemaining,
              improvedFallbackAttempted: decision.guard.improvedFallbackAttempted ?? false,
              improvedFallbackSelected: decision.guard.improvedFallbackSelected ?? false,
              preventedUnverifiedFallback: decision.guard.preventedUnverifiedFallback ?? false,
            }
          : null;
        moves.push({
          ply: state.moveHistory.length,
          player: state.currentPlayer,
          agent: kind,
          action: decision.action,
          actionIndex,
          preStateHash,
          guard: compactGuard,
          decisionMs: decision.elapsedMs,
        });
        if (candidateTurn && compactGuard) {
          lastCandidateDecision = {
            ply: state.moveHistory.length,
            actionIndex,
            ...compactGuard,
            decisionMs: decision.elapsedMs,
          };
        }
        state = applyAction(state, decision.action);
      }
      if (!state.winner || !state.winReason) {
        throw new Error(
          `${comparison.id} pair ${pairIndex}/${candidatePlayer} did not finish in ${maxMoves} plies`,
        );
      }
      const candidateWon = state.winner === candidatePlayer;
      const marginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
      return {
        schemaVersion: 1,
        stage: `M3.4.1_${phase.toUpperCase()}`,
        comparisonId: comparison.id,
        candidateConfig: comparison.candidateConfig,
        opponentConfig: comparison.opponentConfig,
        pairIndex,
        openingId: `paired-opening-${pairIndex}`,
        openingActions: opened.actions,
        candidatePlayer,
        winner: state.winner,
        winReason: state.winReason,
        plies: state.moveHistory.length,
        candidateWon,
        candidateCaptureLoss: !candidateWon && state.winReason === "CAPTURE",
        candidateTerritoryMargin: state.winReason === "TERRITORY"
          ? candidatePlayer === "A" ? marginA : -marginA
          : null,
        finalStateHash: kataCatStateHash(state),
        lastCandidateDecision,
        moves,
      };
    };

    for (const comparison of comparisons) {
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        games.push(await play(comparison, pairIndex, "A"));
        games.push(await play(comparison, pairIndex, "B"));
      }
    }

    for (const target of Object.values(stats)) {
      target.meanDecisionMs = target.totalDecisionMs / Math.max(1, target.decisions);
    }
    const comparisonSummaries = Object.fromEntries(
      comparisons.map((comparison) => [comparison.id, summarize(games, comparison.id)]),
    );
    const acceptance = {
      allGamesCompleted: games.length === gamesPerComparison * comparisons.length,
      completeMirroredPairs: Object.values(comparisonSummaries).every(
        (summary) => summary.mirroredPairs.pairs === pairCount
          && summary.mirroredPairs.malformed === 0,
      ),
      samePairedOpeningIds: comparisons.every((comparison) => {
        const rows = games.filter((game) => game.comparisonId === comparison.id);
        return new Set(rows.map((game) => game.openingId)).size === pairCount;
      }),
      legalMovesOnly,
      allFourConfigurationsMeasured: phase === "promotion"
        || ["PARENT_OLD", "CANDIDATE_OLD", "PARENT_IMPROVED", "CANDIDATE_IMPROVED"]
          .every((kind) => stats[kind].decisions > 0),
      fallbackDiagnosticsReported: Object.values(stats).every(
        (target) => Number.isFinite(target.unverifiedFallbacks),
      ),
      lossReplaysRecorded: games.filter((game) => !game.candidateWon).length > 0,
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const lossReplays = games.filter((game) => !game.candidateWon);
    const summary = {
      schemaVersion: 1,
      stage: `M3.4.1_${phase.toUpperCase()}_ARENA`,
      phase,
      commit_sha: env.KATACAT_M341_COMMIT_SHA ?? "unknown",
      checkpoints: {
        parent: {
          path: env.KATACAT_M341_PARENT_CHECKPOINT,
          sha256: env.KATACAT_M341_PARENT_CHECKPOINT_SHA256 ?? "unknown",
        },
        candidate: {
          path: env.KATACAT_M341_CANDIDATE_CHECKPOINT,
          sha256: env.KATACAT_M341_CANDIDATE_CHECKPOINT_SHA256 ?? "unknown",
        },
      },
      options: {
        gamesPerComparison,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        finalVerifyMs,
        finalVerifyLimit,
        rescueVerifyMs,
        rescueVerifyLimit,
        rescueTotalMs,
        exhaustiveVerifyMs,
      },
      comparisons: comparisonSummaries,
      agents: stats,
      lossReplayCount: lossReplays.length,
      acceptance,
      note: "Smoke and development phases measure all four model/fallback configurations against CURRENT plus matched parent head-to-heads. Promotion narrows to candidate+improved fallback versus parent+improved fallback and CURRENT. Every phase reuses the same deterministic paired-opening prefix.",
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "arena-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writeFileSync(
      resolve(outputDir, "loss-replays.jsonl"),
      lossReplays.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "all-replays.jsonl"),
      games.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    console.log(`KATACAT_M341_ARENA:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 12_000_000);
});
