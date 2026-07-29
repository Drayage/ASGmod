// @ts-nocheck -- Opt-in Node integration arena uses child_process and filesystem APIs.
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
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M4_ARENA === "1";
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
  const prefixLength = [0, 2, 4, 6][pairIndex % 4];
  let cursor = (pairIndex * 17 + 11) >>> 0;
  for (let ply = 0; ply < prefixLength && !state.winner; ply += 1) {
    const safe = getSafeActions(state, state.currentPlayer);
    const placements = safe.pool
      .filter((action) => action.type === "PLACE")
      .sort((a, b) => encodeKataCatPuctAction(a) - encodeKataCatPuctAction(b));
    if (placements.length === 0) break;
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    state = applyAction(state, placements[cursor % placements.length]);
  }
  return state.winner ? createInitialState() : state;
}

type AgentKind = "CANDIDATE" | "CHAMPION" | "CURRENT";

interface ArenaGame {
  matchup: "PREVIOUS" | "CURRENT";
  pairIndex: number;
  candidatePlayer: Player;
  winner: Player;
  winReason: "CAPTURE" | "TERRITORY";
  plies: number;
  candidateWon: boolean;
  candidateCaptureLoss: boolean;
  candidateTerritoryMargin: number | null;
}

suite("KataCat M4 mirrored arena", () => {
  let candidate: PythonCheckpointEvaluator;
  let champion: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const candidateCheckpoint = env.KATACAT_M4_CANDIDATE_CHECKPOINT;
    const championCheckpoint = env.KATACAT_M4_CHAMPION_CHECKPOINT;
    if (!candidateCheckpoint || !championCheckpoint) {
      throw new Error("KATACAT_M4_CANDIDATE_CHECKPOINT and KATACAT_M4_CHAMPION_CHECKPOINT are required");
    }
    candidate = new PythonCheckpointEvaluator(candidateCheckpoint);
    champion = new PythonCheckpointEvaluator(championCheckpoint);
    await Promise.all([candidate.ready, champion.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([candidate?.close(), champion?.close()]);
  });

  it(
    "runs fixed mirrored full-game suites and reports promotion thresholds",
    async () => {
      const gamesPerOpponent = positiveInt(env.KATACAT_M4_GAMES_PER_OPPONENT, 8);
      if (gamesPerOpponent % 2 !== 0) throw new Error("games per opponent must be even for mirrored pairs");
      const simulations = positiveInt(env.KATACAT_M4_SIMULATIONS, 64);
      const currentMs = positiveInt(env.KATACAT_M4_CURRENT_MS, 100);
      const maxMoves = positiveInt(env.KATACAT_M4_MAX_MOVES, 90);
      const strictPromotion = env.KATACAT_M4_STRICT_PROMOTION === "1";
      const previousThreshold = numberValue(env.KATACAT_M4_PREVIOUS_THRESHOLD, 0.525);
      const currentThreshold = numberValue(env.KATACAT_M4_CURRENT_THRESHOLD, 0.55);
      const pairCount = gamesPerOpponent / 2;
      const games: ArenaGame[] = [];

      const choose = async (kind: AgentKind, state: GameState): Promise<AIAction> => {
        if (kind === "CURRENT") return findBestMoveVeryHard(state, state.currentPlayer, currentMs);
        const evaluator = kind === "CANDIDATE" ? candidate : champion;
        return (
          await searchKataCatPuct(state, evaluator, {
            simulations,
            cpuct: 1.35,
            neuralPriorWeight: 0.75,
            scoreValueWeight: 0.05,
          })
        ).action;
      };

      const play = async (
        matchup: "PREVIOUS" | "CURRENT",
        pairIndex: number,
        candidatePlayer: Player,
      ): Promise<ArenaGame> => {
        let state = deterministicOpening(pairIndex);
        while (!state.winner && state.moveHistory.length < maxMoves) {
          const candidateTurn = state.currentPlayer === candidatePlayer;
          const kind: AgentKind = candidateTurn
            ? "CANDIDATE"
            : matchup === "PREVIOUS"
              ? "CHAMPION"
              : "CURRENT";
          const action = await choose(kind, state);
          const legal = new Set([
            ...getLegalMoves(state, state.currentPlayer).map(({ row, col }) => row * BOARD_SIZE + col),
            KATACAT_PASS_INDEX,
          ]);
          expect(legal.has(encodeKataCatPuctAction(action))).toBe(true);
          state = applyAction(state, action);
        }
        if (!state.winner || !state.winReason) {
          throw new Error(`${matchup} pair ${pairIndex} did not finish in ${maxMoves} plies`);
        }
        const candidateWon = state.winner === candidatePlayer;
        const rawMarginA = state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
        const candidateTerritoryMargin =
          state.winReason === "TERRITORY"
            ? candidatePlayer === "A"
              ? rawMarginA
              : -rawMarginA
            : null;
        return {
          matchup,
          pairIndex,
          candidatePlayer,
          winner: state.winner,
          winReason: state.winReason,
          plies: state.moveHistory.length,
          candidateWon,
          candidateCaptureLoss: !candidateWon && state.winReason === "CAPTURE",
          candidateTerritoryMargin,
        };
      };

      for (const matchup of ["PREVIOUS", "CURRENT"] as const) {
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          games.push(await play(matchup, pairIndex, "A"));
          games.push(await play(matchup, pairIndex, "B"));
        }
      }

      const summarize = (matchup: "PREVIOUS" | "CURRENT") => {
        const subset = games.filter((game) => game.matchup === matchup);
        const wins = subset.filter((game) => game.candidateWon).length;
        const captureLosses = subset.filter((game) => game.candidateCaptureLoss).length;
        const territoryMargins = subset
          .map((game) => game.candidateTerritoryMargin)
          .filter((value): value is number => value !== null);
        return {
          games: subset.length,
          wins,
          losses: subset.length - wins,
          winRate: wins / subset.length,
          captureLosses,
          captureLossRate: captureLosses / subset.length,
          territoryGames: territoryMargins.length,
          meanCandidateTerritoryMargin:
            territoryMargins.length > 0
              ? territoryMargins.reduce((sum, value) => sum + value, 0) / territoryMargins.length
              : null,
        };
      };

      const previous = summarize("PREVIOUS");
      const current = summarize("CURRENT");
      const mirroredPairing = games.every((game) =>
        games.some(
          (other) =>
            other.matchup === game.matchup &&
            other.pairIndex === game.pairIndex &&
            other.candidatePlayer !== game.candidatePlayer,
        ),
      );
      const smokeAcceptance = {
        allGamesCompleted: games.length === gamesPerOpponent * 2,
        mirroredPairing,
        legalMovesOnly: true,
        candidateAndChampionInferenceCompleted: true,
        currentVeryHardCompleted: true,
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
        captureLossRate: {
          previous: previous.captureLossRate,
          current: current.captureLossRate,
        },
        territoryMargin: {
          previous: previous.meanCandidateTerritoryMargin,
          current: current.meanCandidateTerritoryMargin,
        },
        passed: false,
      };
      promotion.passed =
        promotion.minimumMirroredGamesPerOpponent &&
        promotion.beatsPreviousChampion &&
        promotion.beatsCurrentVeryHard;

      const report = {
        schemaVersion: 1,
        stage: "M4",
        mode: strictPromotion ? "PROMOTION" : "SMOKE",
        options: { gamesPerOpponent, simulations, currentMs, maxMoves },
        previousChampion: previous,
        currentVeryHard: current,
        smokeAcceptance,
        promotion,
        games,
        note:
          "Smoke mode validates the mirrored arena. Promotion requires at least 400 mirrored games per opponent plus the frozen 52.5%/55% thresholds; tactical and territory regression suites are separate workflow gates.",
      };
      const outputDir = resolve(env.KATACAT_M4_OUTPUT_DIR ?? "katacat-m4-output");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(resolve(outputDir, "arena-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`KATACAT_M4:${JSON.stringify(report)}`);

      expect(smokeAcceptance.passed).toBe(true);
      if (strictPromotion) expect(promotion.passed).toBe(true);
    },
    7_200_000,
  );
});
