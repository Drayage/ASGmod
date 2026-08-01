// @ts-nocheck -- Opt-in offline league generation uses Node child processes and filesystem APIs.
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
import { verifyKataCatRootChoiceM341 } from "./katacatM341Fallback";
import { kataCatStateHash } from "./katacatM0";
import { findBestMoveVeryHard } from "./minimax";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M37_LEAGUE === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function positiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function phaseForPly(ply: number): "early" | "middle" | "late" {
  if (ply <= 20) return "early";
  if (ply <= 45) return "middle";
  return "late";
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
        const error = new Error(`KataCat M3.7 evaluator exited ${code}: ${this.stderr}`);
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
  const lengths = [0, 2, 4, 6, 8, 10, 12, 14, 16];
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

function replayGame(game): void {
  let state = createInitialState();
  for (const action of game.openingActions) state = applyAction(state, action);
  for (const move of game.moves) {
    if (state.currentPlayer !== move.player) {
      throw new Error(`${game.gameId} ply ${move.ply}: player mismatch`);
    }
    if (kataCatStateHash(state) !== move.preStateHash) {
      throw new Error(`${game.gameId} ply ${move.ply}: state hash mismatch`);
    }
    if (!move.legalActions.includes(move.actionIndex)) {
      throw new Error(`${game.gameId} ply ${move.ply}: illegal recorded action`);
    }
    state = applyAction(state, move.action);
  }
  if (
    !state.winner
    || state.winner !== game.finalWinner
    || state.winReason !== game.finalWinReason
    || kataCatStateHash(state) !== game.finalStateHash
    || finalOwnership(state) !== game.finalOwnership
  ) {
    throw new Error(`${game.gameId}: replayed final state differs`);
  }
}

function selectPerGame(rows, cap: number) {
  if (rows.length <= cap) return [...rows];
  const selected = [];
  const selectedIds = new Set();
  const perPhase = Math.max(1, Math.floor(cap / 3));
  for (const phase of ["early", "middle", "late"]) {
    const candidates = rows
      .filter((row) => row.phase === phase)
      .sort((left, right) => left.positionHash.localeCompare(right.positionHash));
    for (const row of candidates.slice(0, perPhase)) {
      selected.push(row);
      selectedIds.add(row.sampleId);
    }
  }
  const remainder = rows
    .filter((row) => !selectedIds.has(row.sampleId))
    .sort((left, right) => left.positionHash.localeCompare(right.positionHash));
  selected.push(...remainder.slice(0, Math.max(0, cap - selected.length)));
  return selected.slice(0, cap);
}

suite("KataCat M3.7 fresh M3.4.1-vs-CURRENT league source", () => {
  let parent: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M37_SOURCE_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M37_SOURCE_CHECKPOINT is required");
    parent = new PythonCheckpointEvaluator(checkpoint);
    await parent.ready;
  }, 120_000);

  afterAll(async () => {
    await parent?.close();
  });

  it("writes diverse, game-split, trusted-action league samples", async () => {
    const gamesRequested = positiveInt("KATACAT_M37_GAMES", 256);
    if (gamesRequested % 2 !== 0) throw new Error("KATACAT_M37_GAMES must be even");
    const simulations = positiveInt("KATACAT_M37_SIMULATIONS", 32);
    const currentMs = positiveInt("KATACAT_M37_CURRENT_MS", 75);
    const maxMoves = positiveInt("KATACAT_M37_MAX_MOVES", 90);
    const captureDepth = positiveInt("KATACAT_M37_CAPTURE_DEPTH", 7);
    const captureAttackMs = positiveInt("KATACAT_M37_CAPTURE_ATTACK_MS", 25);
    const captureDefenseMs = positiveInt("KATACAT_M37_CAPTURE_DEFENSE_MS", 50);
    const captureDefenseLimit = positiveInt("KATACAT_M37_CAPTURE_DEFENSE_LIMIT", 12);
    const finalVerifyMs = positiveInt("KATACAT_M37_FINAL_VERIFY_MS", 75);
    const finalVerifyLimit = positiveInt("KATACAT_M37_FINAL_VERIFY_LIMIT", 5);
    const rescueVerifyMs = positiveInt("KATACAT_M37_RESCUE_VERIFY_MS", 50);
    const rescueVerifyLimit = positiveInt("KATACAT_M37_RESCUE_VERIFY_LIMIT", 8);
    const rescueTotalMs = positiveInt("KATACAT_M37_RESCUE_TOTAL_MS", 450);
    const exhaustiveVerifyMs = positiveInt("KATACAT_M37_EXHAUSTIVE_VERIFY_MS", 25);
    const openingSeed = positiveInt("KATACAT_M37_OPENING_SEED", 20260801);
    const maxSamplesPerGame = positiveInt("KATACAT_M37_MAX_SAMPLES_PER_GAME", 32);
    const outputDir = resolve(env.KATACAT_M37_OUTPUT_DIR ?? "katacat-m37-league");

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

    const games = [];
    const rawSamples = [];
    let discardedNonTerminalGames = 0;
    let candidateDecisions = 0;
    let trustedCandidateDecisions = 0;
    let excludedUnverifiedCandidateDecisions = 0;
    let currentDecisions = 0;

    const play = async (pairIndex: number, candidatePlayer: Player) => {
      const gameId = `katacat-m37-${openingSeed}-p${pairIndex}-${candidatePlayer}`;
      const split = splitForGameId(gameId);
      const opened = deterministicOpening(pairIndex, openingSeed);
      let state = opened.state;
      const pending = [];
      const moves = [];

      while (!state.winner && state.moveHistory.length < maxMoves) {
        const player = state.currentPlayer;
        const legal = legalActions(state);
        const before = inferenceRequest(state);
        let action: AIAction;
        let agentSource: string;
        let policySource: string;
        let fallbackOutcome: string | null = null;
        let trustedPolicyTarget = true;

        if (player === candidatePlayer) {
          candidateDecisions += 1;
          const result = await searchKataCatPuct(state, parent, puctOptions);
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
          const decision = verifyKataCatRootChoiceM341(
            state,
            result,
            guardOptions,
            improvedOptions,
            cachedReader,
            rescue,
          );
          action = decision.action;
          fallbackOutcome = decision.report.outcome;
          trustedPolicyTarget = !decision.report.fallbackToUnverified;
          agentSource = "M341_READER_CHECKED_PUCT";
          policySource = `M341_EXECUTED_${decision.report.outcome}`;
          if (trustedPolicyTarget) trustedCandidateDecisions += 1;
          else excludedUnverifiedCandidateDecisions += 1;
        } else {
          currentDecisions += 1;
          action = findBestMoveVeryHard(state, player, currentMs);
          agentSource = "CURRENT_VERY_HARD";
          policySource = "CURRENT_TEACHER_EXECUTED";
        }

        const actionIndex = encodeKataCatPuctAction(action);
        if (!legal.includes(actionIndex)) {
          throw new Error(`${gameId} ply ${state.moveHistory.length}: illegal action ${actionIndex}`);
        }
        if (trustedPolicyTarget) {
          pending.push({
            schemaVersion: 1,
            sampleId: `${gameId}:p${state.moveHistory.length}`,
            gameId,
            split,
            positionHash: positionHash(state),
            sourceMode: "FRESH_M341_VS_CURRENT_LEAGUE",
            trainingStage: "M3.7",
            agentSource,
            policySource,
            fallbackOutcome,
            currentPlayer: player,
            ply: state.moveHistory.length,
            phase: phaseForPly(state.moveHistory.length),
            ...before,
            policyTarget: [{ action: actionIndex, visits: 1 }],
            executedAction: actionIndex,
            targetUsesUnverifiedFallback: false,
          });
        }
        moves.push({
          ply: state.moveHistory.length,
          player,
          action,
          actionIndex,
          legalActions: legal,
          preStateHash: kataCatStateHash(state),
          agentSource,
          policySource,
          fallbackOutcome,
          trustedPolicyTarget,
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
        stage: "M3.7_LEAGUE",
        gameId,
        pairIndex,
        openingSeed,
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
      replayGame(game);
      games.push(game);
      rawSamples.push(...pending.map((sample) => ({
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
    if (games.length !== gamesRequested) {
      throw new Error(`Generated only ${games.length}/${gamesRequested} terminal games`);
    }

    const groups = new Map();
    for (const sample of rawSamples) {
      const rows = groups.get(sample.positionHash) ?? [];
      rows.push(sample);
      groups.set(sample.positionHash, rows);
    }
    const globallyUnique = [...groups.values()].map((rows) =>
      [...rows].sort((left, right) => left.sampleId.localeCompare(right.sampleId))[0]
    );
    const byGame = new Map();
    for (const sample of globallyUnique) {
      const rows = byGame.get(sample.gameId) ?? [];
      rows.push(sample);
      byGame.set(sample.gameId, rows);
    }
    const samples = [];
    for (const rows of byGame.values()) samples.push(...selectPerGame(rows, maxSamplesPerGame));
    samples.sort((left, right) => left.sampleId.localeCompare(right.sampleId));

    const trainSamples = samples.filter((sample) => sample.split === "train");
    const validationSamples = samples.filter((sample) => sample.split === "validation");
    const trainGames = new Set(trainSamples.map((sample) => sample.gameId));
    const validationGames = new Set(validationSamples.map((sample) => sample.gameId));
    const sourceCounts = Object.fromEntries(
      ["M341_READER_CHECKED_PUCT", "CURRENT_VERY_HARD"].map((source) => [
        source,
        samples.filter((sample) => sample.agentSource === source).length,
      ]),
    );
    const seatCounts = Object.fromEntries(
      ["train", "validation"].map((split) => [split, Object.fromEntries(
        ["A", "B"].map((seat) => [
          seat,
          samples.filter((sample) => sample.split === split && sample.currentPlayer === seat).length,
        ]),
      )]),
    );
    const phaseCounts = Object.fromEntries(
      ["early", "middle", "late"].map((phase) => [
        phase,
        samples.filter((sample) => sample.phase === phase).length,
      ]),
    );
    const resultTypes = games.reduce((counts, game) => {
      counts[game.finalWinReason] = (counts[game.finalWinReason] ?? 0) + 1;
      return counts;
    }, { CAPTURE: 0, TERRITORY: 0 });
    const duplicateGroups = [...groups.values()].filter((rows) => rows.length > 1);
    const acceptance = {
      requestedTerminalGames: games.length === gamesRequested,
      naturalTerminalsOnly: games.every((game) => game.naturalTerminal),
      replayVerified: games.every((game) => {
        try { replayGame(game); return true; } catch { return false; }
      }),
      freshOpeningSeedRecorded: games.every((game) => game.openingSeed === openingSeed),
      uniqueSelectedPositionHashes: new Set(samples.map((sample) => sample.positionHash)).size === samples.length,
      trainValidationGameDisjoint: [...trainGames].every((gameId) => !validationGames.has(gameId)),
      bothAgentsPresent: Object.values(sourceCounts).every((count) => count > 0),
      bothSeatsInBothSplits: ["train", "validation"].every(
        (split) => seatCounts[split].A > 0 && seatCounts[split].B > 0,
      ),
      allPhasesPresent: Object.values(phaseCounts).every((count) => count > 0),
      trustedTargetsOnly: samples.every((sample) => !sample.targetUsesUnverifiedFallback),
      enoughSamples: samples.length >= gamesRequested * 12,
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.7_LEAGUE_SOURCE",
      options: {
        gamesRequested,
        simulations,
        currentMs,
        maxMoves,
        captureDepth,
        openingSeed,
        maxSamplesPerGame,
      },
      generatedGames: games.length,
      rawSamples: rawSamples.length,
      uniqueSamplesBeforeCap: globallyUnique.length,
      generatedSamples: samples.length,
      trainSamples: trainSamples.length,
      validationSamples: validationSamples.length,
      candidateDecisions,
      trustedCandidateDecisions,
      excludedUnverifiedCandidateDecisions,
      currentDecisions,
      discardedNonTerminalGames,
      sourceCounts,
      seatCounts,
      phaseCounts,
      resultTypes,
      splitAudit: {
        trainGames: [...trainGames].sort(),
        validationGames: [...validationGames].sort(),
        disjoint: [...trainGames].every((gameId) => !validationGames.has(gameId)),
      },
      positionAudit: {
        rawRows: rawSamples.length,
        uniqueHashes: groups.size,
        duplicateGroups: duplicateGroups.length,
        selectedHashes: samples.length,
      },
      acceptance,
      note:
        "M3.7 records every trusted executed decision from fresh mirrored M3.4.1-vs-CURRENT games. "
        + "M3.4.1 actions are included only when the bounded reader did not fall back to an unverified move; "
        + "CURRENT actions are direct teacher labels. Splits are game-level and position hashes are globally deduplicated.",
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "katacat-m37-league-games.jsonl"),
      games.map((game) => JSON.stringify(game)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m37-league-samples.jsonl"),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(`KATACAT_M37_LEAGUE:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 14_400_000);
});
