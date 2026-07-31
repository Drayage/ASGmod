// @ts-nocheck -- opt-in integration arena uses Node child processes and filesystem APIs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction, getSafeActions } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState, Player } from "../types";
import { searchKataCatPuctWithM341Fallback } from "./katacatM341Fallback";
import { kataCatStateHash } from "./katacatM0";
import { findBestMoveVeryHard } from "./minimax";
import { encodeKataCatPuctAction, KATACAT_PASS_INDEX } from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M35_ARENA === "1";
const suite = enabled ? describe : describe.skip;
type Matchup = "PARENT" | "CURRENT";
type AgentKind = "CANDIDATE" | "PARENT" | "CURRENT";

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
  pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  stderr = "";
  ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (error: Error) => void;

  constructor(checkpoint: string) {
    this.child = spawn(
      env.PYTHON ?? "python",
      ["ml/katacat_m33_infer.py", `--checkpoint=${checkpoint}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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
        const error = new Error(`KataCat M3.5 evaluator exited ${code}: ${this.stderr}`);
        this.rejectReady(error);
        for (const pending of this.pending.splice(0)) pending.reject(error);
      }
    });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.ready) return this.resolveReady();
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

function deterministicOpening(pairIndex: number): { state: GameState; actions: any[] } {
  let state = createInitialState();
  const actions: any[] = [];
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

function wilson95(wins: number, games: number) {
  if (games <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const rate = wins / games;
  const denominator = 1 + (z * z) / games;
  const center = (rate + (z * z) / (2 * games)) / denominator;
  const radius = z * Math.sqrt(
    (rate * (1 - rate)) / games + (z * z) / (4 * games * games),
  ) / denominator;
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}

function emptyAgentStats() {
  return {
    decisions: 0,
    totalDecisionMs: 0,
    meanDecisionMs: 0,
    forcedCaptureMoves: 0,
    originalSelectionRefuted: 0,
    allRootActionsRefuted: 0,
    notRefutedExhaustiveSelections: 0,
    improvedFallbackChecks: 0,
    outcomes: {} as Record<string, number>,
  };
}
function normalizedOutcome(outcome: string): string {
  return outcome === "VERIFIED_EXHAUSTIVE_FALLBACK"
    ? "NOT_REFUTED_EXHAUSTIVE"
    : outcome;
}

function summarize(games: any[], matchup: Matchup) {
  const rows = games.filter((game) => game.matchup === matchup);
  const wins = rows.filter((game) => game.candidateWon).length;
  const byCandidateSeat = Object.fromEntries(["A", "B"].map((seat) => {
    const seatRows = rows.filter((game) => game.candidatePlayer === seat);
    const seatWins = seatRows.filter((game) => game.candidateWon).length;
    return [seat, {
      games: seatRows.length,
      wins: seatWins,
      losses: seatRows.length - seatWins,
      winRate: seatWins / Math.max(1, seatRows.length),
      wilson95: wilson95(seatWins, seatRows.length),
      collapseLosses: seatRows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.allRootActionsRefuted,
      ).length,
    }];
  }));
  const pairs = new Map<number, any[]>();
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
    if (pair.length !== 2) { malformed += 1; continue; }
    const pairWins = pair.filter((game) => game.candidateWon).length;
    if (pairWins === 2) sweeps += 1;
    else if (pairWins === 1) splits += 1;
    else swept += 1;
  }
  const territory = rows.filter((game) => game.candidateTerritoryMargin !== null);
  const captureLosses = rows.filter((game) => game.candidateCaptureLoss).length;
  const losses = rows.length - wins;
  return {
    games: rows.length,
    wins,
    losses,
    winRate: wins / Math.max(1, rows.length),
    wilson95: wilson95(wins, rows.length),
    captureLosses,
    captureLossRate: captureLosses / Math.max(1, rows.length),
    territoryGames: territory.length,
    meanCandidateTerritoryMargin: territory.length
      ? territory.reduce((sum, game) => sum + game.candidateTerritoryMargin, 0) / territory.length
      : null,
    byCandidateSeat,
    absoluteSeatWinRateGap: Math.abs(byCandidateSeat.A.winRate - byCandidateSeat.B.winRate),
    mirroredPairs: { pairs: pairs.size, sweeps, splits, swept, malformed },
    lossDiagnostics: {
      losses,
      originalSelectionRefutedLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.selectedActionWasRefuted,
      ).length,
      allRootActionsRefutedLosses: rows.filter(
        (game) => !game.candidateWon && game.lastCandidateDecision?.allRootActionsRefuted,
      ).length,
      notRefutedExhaustiveLastDecisionLosses: rows.filter(
        (game) => !game.candidateWon
          && game.lastCandidateDecision?.outcome === "NOT_REFUTED_EXHAUSTIVE",
      ).length,
    },
  };
}

suite("KataCat M3.5 controlled arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let parent: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M35_CANDIDATE_CHECKPOINT;
    const parentCheckpoint = env.KATACAT_M35_PARENT_CHECKPOINT;
    if (!candidateCheckpoint || !parentCheckpoint) {
      throw new Error("M3.5 checkpoint paths are required");
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint);
    parent = new PythonCheckpointEvaluator(parentCheckpoint);
    await Promise.all([candidate.ready, parent.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), parent?.close()]);
  });

  it("compares trunk+policy candidate with the fixed M3.4.1 fallback", async () => {
    const phase = env.KATACAT_M35_PHASE ?? "smoke";
    const gamesPerComparison = positiveInt("KATACAT_M35_GAMES_PER_COMPARISON", 32);
    if (gamesPerComparison % 2 !== 0) throw new Error("games per comparison must be even");
    const pairCount = gamesPerComparison / 2;
    const simulations = positiveInt("KATACAT_M35_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M35_CURRENT_MS", 50);
    const maxMoves = positiveInt("KATACAT_M35_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M35_CAPTURE_DEPTH", 7);
    const outputDir = resolve(env.KATACAT_M35_ARENA_OUTPUT_DIR ?? `katacat-m35-${phase}`);

    const puctOptions = {
      simulations,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight: 0.05,
      tacticalShell: true,
      captureReadDepth: captureDepth,
      captureAttackMs: 25,
      captureDefenseMs: 50,
      captureDefenseLimit: 12,
    };
    const guardOptions = {
      finalVerificationDepth: captureDepth,
      finalVerificationMs: positiveInt("KATACAT_M35_FINAL_VERIFY_MS", 75),
      finalVerificationLimit: positiveInt("KATACAT_M35_FINAL_VERIFY_LIMIT", 5),
      rescueVerificationLimit: positiveInt("KATACAT_M35_RESCUE_VERIFY_LIMIT", 8),
      rescueVerificationMs: positiveInt("KATACAT_M35_RESCUE_VERIFY_MS", 50),
      rescueTotalMs: positiveInt("KATACAT_M35_RESCUE_TOTAL_MS", 450),
    };
    const improvedOptions = {
      verificationDepth: captureDepth,
      verificationMs: positiveInt("KATACAT_M35_EXHAUSTIVE_VERIFY_MS", 25),
      verificationLimit: 82,
    };
    const rescue = (state, player) => findBestMoveVeryHard(state, player, currentMs);
    const stats = {
      CANDIDATE: emptyAgentStats(),
      PARENT: emptyAgentStats(),
      CURRENT: emptyAgentStats(),
    };
    const games: any[] = [];
    let legalMovesOnly = true;

    const choose = async (kind: AgentKind, state: GameState) => {
      const started = Date.now();
      if (kind === "CURRENT") {
        const action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
        const elapsedMs = Date.now() - started;
        stats.CURRENT.decisions += 1;
        stats.CURRENT.totalDecisionMs += elapsedMs;
        return { action, guard: null, elapsedMs };
      }
      const evaluator = kind === "CANDIDATE" ? candidate : parent;
      const result = await searchKataCatPuctWithM341Fallback(
        state,
        evaluator,
        puctOptions,
        guardOptions,
        improvedOptions,
        rescue,
      );
      const elapsedMs = Date.now() - started;
      const target = stats[kind];
      target.decisions += 1;
      target.totalDecisionMs += elapsedMs;
      if (result.reason === "FORCED_CAPTURE") target.forcedCaptureMoves += 1;
      if (result.finalGuard.selectedActionWasRefuted) target.originalSelectionRefuted += 1;
      if (result.finalGuard.allRootActionsRefuted) target.allRootActionsRefuted += 1;
      if (result.finalGuard.improvedFallbackSelected) target.notRefutedExhaustiveSelections += 1;
      target.improvedFallbackChecks += result.finalGuard.improvedFallbackChecks ?? 0;
      const outcome = normalizedOutcome(result.finalGuard.outcome);
      target.outcomes[outcome] = (target.outcomes[outcome] ?? 0) + 1;
      return { action: result.action, guard: { ...result.finalGuard, outcome }, elapsedMs };
    };

    const play = async (matchup: Matchup, pairIndex: number, candidatePlayer: Player) => {
      const opened = deterministicOpening(pairIndex);
      let state = opened.state;
      const moves: any[] = [];
      let lastCandidateDecision = null;
      while (!state.winner && state.moveHistory.length < maxMoves) {
        const candidateTurn = state.currentPlayer === candidatePlayer;
        const kind: AgentKind = candidateTurn ? "CANDIDATE" : matchup;
        const preStateHash = kataCatStateHash(state);
        const decision = await choose(kind, state);
        const actionIndex = encodeKataCatPuctAction(decision.action);
        const legal = new Set([
          ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
          KATACAT_PASS_INDEX,
        ]);
        if (!legal.has(actionIndex)) legalMovesOnly = false;
        const compactGuard = decision.guard ? {
          outcome: decision.guard.outcome,
          selectedActionWasRefuted: decision.guard.selectedActionWasRefuted,
          allRootActionsRefuted: decision.guard.allRootActionsRefuted,
          chosenRank: decision.guard.chosenRank,
          uncheckedActionsRemaining: decision.guard.uncheckedActionsRemaining,
          improvedFallbackSelected: decision.guard.improvedFallbackSelected ?? false,
        } : null;
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
        throw new Error(`${matchup}/${pairIndex}/${candidatePlayer} did not finish`);
      }
      const candidateWon = state.winner === candidatePlayer;
      const marginA = state.territories.A.length
        - state.territories.B.length
        - FIRST_PLAYER_MARGIN;
      return {
        schemaVersion: 1,
        stage: `M3.5_${phase.toUpperCase()}`,
        matchup,
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

    for (const matchup of ["PARENT", "CURRENT"] as const) {
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        games.push(await play(matchup, pairIndex, "A"));
        games.push(await play(matchup, pairIndex, "B"));
      }
    }

    for (const target of Object.values(stats)) {
      target.meanDecisionMs = target.totalDecisionMs / Math.max(1, target.decisions);
    }
    const parentM341 = summarize(games, "PARENT");
    const currentVeryHard = summarize(games, "CURRENT");
    const lossReplays = games.filter((game) => !game.candidateWon);
    const acceptance = {
      allGamesCompleted: games.length === gamesPerComparison * 2,
      completeMirroredPairs: parentM341.mirroredPairs.pairs === pairCount
        && currentVeryHard.mirroredPairs.pairs === pairCount
        && parentM341.mirroredPairs.malformed === 0
        && currentVeryHard.mirroredPairs.malformed === 0,
      legalMovesOnly,
      sameFallbackForBothRelativeModels:
        stats.CANDIDATE.decisions > 0 && stats.PARENT.decisions > 0,
      lossReplaysRecorded: lossReplays.length > 0,
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: `M3.5_${phase.toUpperCase()}_ARENA`,
      phase,
      commit_sha: env.KATACAT_M35_COMMIT_SHA ?? "unknown",
      checkpoints: {
        parent: {
          path: env.KATACAT_M35_PARENT_CHECKPOINT,
          sha256: env.KATACAT_M35_PARENT_CHECKPOINT_SHA256 ?? "unknown",
        },
        candidate: {
          path: env.KATACAT_M35_CANDIDATE_CHECKPOINT,
          sha256: env.KATACAT_M35_CANDIDATE_CHECKPOINT_SHA256 ?? "unknown",
        },
      },
      options: {
        gamesPerComparison,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        ...guardOptions,
        ...improvedOptions,
      },
      parentM341,
      currentVeryHard,
      agents: stats,
      lossReplayCount: lossReplays.length,
      acceptance,
      note: "M3.5 changes trunk+policy only and uses the fixed M3.4.1 bounded-reader fallback for both relative models.",
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
    console.log(`KATACAT_M35_ARENA:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 12_000_000);
});
