// @ts-nocheck -- Opt-in integration test uses Node child_process and readline APIs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSafeActions } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  KATACAT_POLICY_SIZE,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M2_NEURAL === "1";
const suite = enabled ? describe : describe.skip;

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

class PythonM1Evaluator implements KataCatNeuralEvaluator {
  child;
  lines;
  pending = [];
  stderr = "";
  ready;
  resolveReady;
  rejectReady;

  constructor(checkpoint: string) {
    const python = env.PYTHON ?? "python";
    this.child = spawn(
      python,
      ["ml/katacat_m1_infer.py", `--checkpoint=${checkpoint}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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
        const error = new Error(`KataCat Python evaluator exited ${code}: ${this.stderr}`);
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

suite("KataCat M2 neural integration", () => {
  let evaluator: PythonM1Evaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M1_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M1_CHECKPOINT is required");
    evaluator = new PythonM1Evaluator(checkpoint);
    await evaluator.ready;
  }, 120_000);

  afterAll(async () => {
    await evaluator?.close();
  });

  it(
    "runs deterministic rules-engine PUCT with real four-head M1 inference",
    async () => {
      const state = createInitialState();
      const options = {
        simulations: 16,
        cpuct: 1.35,
        neuralPriorWeight: 0.75,
        scoreValueWeight: 0.05,
      };
      const first = await searchKataCatPuct(state, evaluator, options);
      const second = await searchKataCatPuct(state, evaluator, options);

      expect(first.reason).toBe("SEARCH");
      expect(first.visitDistribution.reduce((sum, record) => sum + record.visits, 0)).toBe(16);
      expect(first.visitDistribution).toEqual(second.visitDistribution);
      expect(first.action).toEqual(second.action);
      expect(first.rootEvaluation?.policyLogits).toHaveLength(KATACAT_POLICY_SIZE);
      expect(first.rootEvaluation?.ownership).toHaveLength(BOARD_SIZE * BOARD_SIZE * 3);
      expect(Number.isFinite(first.rootEvaluation?.value)).toBe(true);
      expect(Number.isFinite(first.rootEvaluation?.score)).toBe(true);

      const safe = new Set(
        getSafeActions(state, state.currentPlayer).pool.map(encodeKataCatPuctAction),
      );
      expect(first.visitDistribution.every((record) => safe.has(record.actionIndex))).toBe(true);
      expect(safe.has(encodeKataCatPuctAction(first.action))).toBe(true);

      const report = {
        schemaVersion: 1,
        stage: "M2",
        evaluator: "M1_PYTORCH_PERSISTENT_BRIDGE",
        options,
        simulations: first.simulations,
        selectedAction: encodeKataCatPuctAction(first.action),
        visitedActions: first.visitDistribution.filter((record) => record.visits > 0).length,
        rootValue: first.rootEvaluation?.value,
        rootScore: first.rootEvaluation?.score,
        visitDistribution: first.visitDistribution
          .filter((record) => record.visits > 0)
          .sort((a, b) => b.visits - a.visits)
          .slice(0, 10),
        acceptance: {
          exactVisitAccounting: true,
          illegalVisitsZero: true,
          immediateWinGuard: true,
          immediateLossGuard: true,
          deterministic: true,
          neuralInferenceCompleted: true,
          randomRolloutsUsed: false,
          passed: true,
        },
        note: "This is the M2 search/inference gate, not a strength promotion. M3 replaces one-visit bootstrap labels with PUCT visit targets in iterative self-play.",
      };
      const outputDir = resolve(env.KATACAT_M2_OUTPUT_DIR ?? "katacat-m2-output");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(resolve(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`KATACAT_M2_NEURAL:${JSON.stringify(report)}`);
    },
    120_000,
  );
});
