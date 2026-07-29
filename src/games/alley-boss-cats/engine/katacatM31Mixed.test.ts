// @ts-nocheck -- Opt-in mixed curriculum uses Node child processes and filesystem APIs.
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
import { kataCatStateHash } from "./katacatM0";
import { findBestMoveVeryHard } from "./minimax";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M31_MIXED === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

type MixMode =
  | "LATEST_SELFPLAY"
  | "LATEST_VS_CHAMPION_AS_A"
  | "LATEST_VS_CHAMPION_AS_B"
  | "LATEST_VS_CURRENT_AS_A"
  | "LATEST_VS_CURRENT_AS_B";

type AgentKind = "LATEST" | "CHAMPION" | "CURRENT";

const MODE_CYCLE: MixMode[] = [
  "LATEST_SELFPLAY",
  "LATEST_VS_CHAMPION_AS_A",
  "LATEST_VS_CHAMPION_AS_B",
  "LATEST_VS_CURRENT_AS_A",
  "LATEST_VS_CURRENT_AS_B",
];

function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
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
  if (!move || move.type === "PASS") return KATACAT_PASS_INDEX;
  return move.row * BOARD_SIZE + move.col;
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

function latestPlayer(mode: MixMode): Player | null {
  if (mode === "LATEST_VS_CHAMPION_AS_A" || mode === "LATEST_VS_CURRENT_AS_A") return "A";
  if (mode === "LATEST_VS_CHAMPION_AS_B" || mode === "LATEST_VS_CURRENT_AS_B") return "B";
  return null;
}

function agentFor(mode: MixMode, player: Player): AgentKind {
  if (mode === "LATEST_SELFPLAY") return "LATEST";
  const latest = latestPlayer(mode);
  if (player === latest) return "LATEST";
  return mode.includes("CHAMPION") ? "CHAMPION" : "CURRENT";
}

function deterministicPrefix(state: GameState, seed: number, length: number) {
  const moves = [];
  let cursor = seed >>> 0;
  for (let ply = 0; ply < length && !state.winner; ply += 1) {
    const safe = getSafeActions(state, state.currentPlayer);
    const placements = safe.pool
      .filter((action) => action.type === "PLACE")
      .sort((left, right) => encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right));
    if (placements.length === 0) break;
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    const action = placements[cursor % placements.length];
    const actionIndex = encodeKataCatPuctAction(action);
    moves.push({
      ply: state.moveHistory.length,
      player: state.currentPlayer,
      action,
      actionIndex,
      legalActions: legalActions(state),
      preStateHash: kataCatStateHash(state),
      searchReason: "MIXED_PREFIX",
      policyTarget: [{ action: actionIndex, visits: 1 }],
    });
    state = applyAction(state, action);
  }
  return { state, moves };
}

function replayGame(game): void {
  let state = createInitialState();
  for (const move of game.moves) {
    if (state.currentPlayer !== move.player) {
      throw new Error(`${game.gameId} ply ${move.ply}: player mismatch`);
    }
    if (kataCatStateHash(state) !== move.preStateHash) {
      throw new Error(`${game.gameId} ply ${move.ply}: pre-state hash mismatch`);
    }
    if (!move.legalActions.includes(move.actionIndex)) {
      throw new Error(`${game.gameId} ply ${move.ply}: action missing from legal mask`);
    }
    state = applyAction(state, move.action);
  }
  if (
    !state.winner ||
    state.winner !== game.finalWinner ||
    state.winReason !== game.finalWinReason ||
    kataCatStateHash(state) !== game.finalStateHash ||
    finalOwnership(state) !== game.finalOwnership
  ) {
    throw new Error(`${game.gameId}: replayed final state differs`);
  }
}

suite("KataCat M3.1 mixed curriculum", () => {
  let latest: PythonCheckpointEvaluator;
  let champion: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const latestCheckpoint = env.KATACAT_M31_LATEST_CHECKPOINT;
    const championCheckpoint = env.KATACAT_M31_CHAMPION_CHECKPOINT;
    if (!latestCheckpoint || !championCheckpoint) {
      throw new Error("KATACAT_M31_LATEST_CHECKPOINT and KATACAT_M31_CHAMPION_CHECKPOINT are required");
    }
    latest = new PythonCheckpointEvaluator(latestCheckpoint);
    champion = new PythonCheckpointEvaluator(championCheckpoint);
    await Promise.all([latest.ready, champion.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([latest?.close(), champion?.close()]);
  });

  it(
    "writes replayable latest/champion/CURRENT games with tactical-shell targets",
    async () => {
      const requestedGames = envInt("KATACAT_M31_GAMES", 5, 5);
      const simulations = envInt("KATACAT_M31_SIMULATIONS", 48, 8);
      const currentMs = envInt("KATACAT_M31_CURRENT_MS", 50, 1);
      const maxMoves = envInt("KATACAT_M31_MAX_MOVES", 90, 20);
      const seed = envInt("KATACAT_M31_SEED", 20260730, 1);
      const captureReadDepth = envInt("KATACAT_M31_CAPTURE_DEPTH", 7, 1);
      const captureAttackMs = envInt("KATACAT_M31_CAPTURE_ATTACK_MS", 25, 0);
      const captureDefenseMs = envInt("KATACAT_M31_CAPTURE_DEFENSE_MS", 50, 0);
      const captureDefenseLimit = envInt("KATACAT_M31_CAPTURE_DEFENSE_LIMIT", 12, 1);
      const outputDir = resolve(env.KATACAT_M31_OUTPUT_DIR ?? "katacat-m31-output");

      const games = [];
      const samples = [];
      let attempt = 0;
      let discardedNonTerminalGames = 0;
      let exactVisitAccounting = true;
      let legalVisitsOnly = true;
      let puctSamples = 0;
      let currentTeacherSamples = 0;
      let tacticalShellCalls = 0;
      let forcedCaptureMoves = 0;
      let refutedRootActions = 0;
      const maxAttempts = requestedGames * 5;

      while (games.length < requestedGames && attempt < maxAttempts) {
        const gameIndex = games.length + 1;
        const mode = MODE_CYCLE[(gameIndex - 1) % MODE_CYCLE.length];
        const gameSeed = seed + attempt * 104729;
        const gameId = `katacat-m31-${seed}-g${gameIndex}-a${attempt}`;
        const split = gameIndex % 5 === 0 ? "validation" : "train";
        const prefixLength = [0, 2, 4, 6, 8][attempt % 5];
        const prefixed = deterministicPrefix(createInitialState(), gameSeed, prefixLength);
        let state = prefixed.state;
        const moves = [...prefixed.moves];
        const pending = [];

        while (!state.winner && state.moveHistory.length < maxMoves) {
          const ply = state.moveHistory.length;
          const agent = agentFor(mode, state.currentPlayer);
          let action: AIAction;
          let policyTarget;
          let searchReason: string;
          let tactical = null;

          if (agent === "CURRENT") {
            action = findBestMoveVeryHard(state, state.currentPlayer, currentMs);
            policyTarget = [{ action: encodeKataCatPuctAction(action), visits: 1 }];
            searchReason = "CURRENT_TEACHER";
            currentTeacherSamples += 1;
          } else {
            const evaluator = agent === "LATEST" ? latest : champion;
            const result = await searchKataCatPuct(state, evaluator, {
              simulations,
              cpuct: 1.35,
              neuralPriorWeight: 0.75,
              scoreValueWeight: 0.05,
              tacticalShell: true,
              captureReadDepth,
              captureAttackMs,
              captureDefenseMs,
              captureDefenseLimit,
            });
            action = result.action;
            policyTarget = result.visitDistribution
              .filter((record) => record.visits > 0)
              .map((record) => ({ action: record.actionIndex, visits: record.visits }));
            searchReason = result.reason;
            tactical = result.tactical;
            puctSamples += 1;
            tacticalShellCalls += 1;
            if (result.reason === "FORCED_CAPTURE") forcedCaptureMoves += 1;
            refutedRootActions += result.tactical.refutedActions;
            const visitTotal = policyTarget.reduce((sum, item) => sum + item.visits, 0);
            if (
              (result.reason === "SEARCH" && visitTotal !== simulations) ||
              (result.reason !== "SEARCH" && visitTotal !== 1)
            ) {
              exactVisitAccounting = false;
            }
          }

          const actionIndex = encodeKataCatPuctAction(action);
          const legal = legalActions(state);
          if (!legal.includes(actionIndex) || policyTarget.some((item) => !legal.includes(item.action))) {
            legalVisitsOnly = false;
          }
          pending.push({
            schemaVersion: 1,
            sampleId: `${gameId}:p${ply}`,
            gameId,
            gameIndex,
            split,
            sourceMode: mode,
            agentSource: agent,
            ply,
            board: encodeBoard(state),
            currentPlayer: state.currentPlayer,
            legalActions: legal,
            territoryA: encodeCoords(state.territories.A),
            territoryB: encodeCoords(state.territories.B),
            remainingA: state.remainingCats.A,
            remainingB: state.remainingCats.B,
            consecutivePasses: state.consecutivePasses,
            lastAction: lastAction(state),
            policyTarget,
            policySource: agent === "CURRENT" ? "CURRENT_TEACHER" : "PUCT_VISITS",
          });
          moves.push({
            ply,
            player: state.currentPlayer,
            action,
            actionIndex,
            legalActions: legal,
            preStateHash: kataCatStateHash(state),
            searchReason,
            tactical,
            policyTarget,
          });
          state = applyAction(state, action);
        }

        attempt += 1;
        if (!state.winner || !state.winReason) {
          discardedNonTerminalGames += 1;
          continue;
        }

        const ownership = finalOwnership(state);
        const adjustedMarginA =
          state.territories.A.length - state.territories.B.length - FIRST_PLAYER_MARGIN;
        const game = {
          schemaVersion: 1,
          stage: "M3.1",
          gameId,
          gameIndex,
          seed: gameSeed,
          split,
          mode,
          naturalTerminal: true,
          moves,
          finalWinner: state.winner,
          finalWinReason: state.winReason,
          finalAdjustedMarginA: adjustedMarginA,
          finalOwnership: ownership,
          finalStateHash: kataCatStateHash(state),
        };
        replayGame(game);
        games.push(game);
        samples.push(
          ...pending.map((sample) => ({
            ...sample,
            finalWinner: state.winner as Player,
            finalWinReason: state.winReason,
            finalAdjustedMarginA: adjustedMarginA,
            finalOwnership: ownership,
          })),
        );
      }

      if (games.length < requestedGames) {
        throw new Error(`Generated only ${games.length}/${requestedGames} terminal M3.1 games`);
      }

      const modes = games.reduce((counts, game) => {
        counts[game.mode] = (counts[game.mode] ?? 0) + 1;
        return counts;
      }, {});
      const trainGames = new Set(samples.filter((sample) => sample.split === "train").map((sample) => sample.gameId));
      const validationGames = new Set(
        samples.filter((sample) => sample.split === "validation").map((sample) => sample.gameId),
      );
      const replayVerified = (() => {
        try {
          for (const game of games) replayGame(game);
          return true;
        } catch {
          return false;
        }
      })();
      const acceptance = {
        generatedRequestedGames: games.length === requestedGames,
        allFiveModesPresent: MODE_CYCLE.every((mode) => (modes[mode] ?? 0) > 0),
        replayVerified,
        naturalTerminalsOnly: games.every((game) => game.naturalTerminal && game.finalWinner && game.finalWinReason),
        exactVisitAccounting,
        legalVisitsOnly,
        puctTargetsPresent: puctSamples > 0,
        currentTeacherTargetsPresent: currentTeacherSamples > 0,
        tacticalShellUsed: tacticalShellCalls > 0,
        splitDisjoint: [...trainGames].every((gameId) => !validationGames.has(gameId)),
        noRandomRollouts: true,
        passed: false,
      };
      acceptance.passed = Object.entries(acceptance)
        .filter(([key]) => key !== "passed")
        .every(([, value]) => value === true);

      const summary = {
        schemaVersion: 1,
        stage: "M3.1_MIXED",
        options: {
          games: requestedGames,
          simulations,
          currentMs,
          maxMoves,
          seed,
          captureReadDepth,
          captureAttackMs,
          captureDefenseMs,
          captureDefenseLimit,
        },
        generatedGames: games.length,
        generatedSamples: samples.length,
        discardedNonTerminalGames,
        sourceModes: modes,
        policySources: { PUCT_VISITS: puctSamples, CURRENT_TEACHER: currentTeacherSamples },
        tactical: { tacticalShellCalls, forcedCaptureMoves, refutedRootActions },
        resultTypes: games.reduce(
          (counts, game) => {
            counts[game.finalWinReason] = (counts[game.finalWinReason] ?? 0) + 1;
            return counts;
          },
          { CAPTURE: 0, TERRITORY: 0 },
        ),
        splits: { trainGames: trainGames.size, validationGames: validationGames.size },
        acceptance,
        note: "M3.1 mixes latest self-play, previous champion PUCT, and CURRENT teacher turns. Only the root uses the focused forced-capture shell.",
      };

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        resolve(outputDir, "katacat-m31-games.jsonl"),
        games.map((game) => JSON.stringify(game)).join("\n") + "\n",
      );
      writeFileSync(
        resolve(outputDir, "katacat-m31-samples.jsonl"),
        samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
      );
      writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      console.log(`KATACAT_M31_MIXED:${JSON.stringify(summary)}`);

      expect(acceptance.passed).toBe(true);
    },
    3_600_000,
  );
});
