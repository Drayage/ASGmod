// @ts-nocheck -- Opt-in diagnostic integration test uses child processes and filesystem APIs.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction, getSafeActions } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";
import { kataCatStateHash } from "./katacatM0";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M3431_DETERMINISM === "1";
const suite = enabled ? describe : describe.skip;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    this.child = spawn(env.PYTHON ?? "python", [
      "ml/katacat_m33_infer.py",
      `--checkpoint=${checkpoint}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });
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
        const error = new Error(`M3.4.3.1 evaluator exited ${code}: ${this.stderr}`);
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

function deterministicState(index: number): GameState {
  let state = createInitialState();
  const targetPly = [0, 2, 4, 6, 8, 10, 12, 14][index % 8];
  let cursor = (index * 2654435761 + 17) >>> 0;
  for (let ply = 0; ply < targetPly && !state.winner; ply += 1) {
    const actions = getSafeActions(state, state.currentPlayer).pool
      .filter((action) => action.type === "PLACE")
      .sort((a, b) => encodeKataCatPuctAction(a) - encodeKataCatPuctAction(b));
    if (actions.length === 0) break;
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    state = applyAction(state, actions[cursor % actions.length]);
  }
  return state.winner ? createInitialState() : state;
}

function maxAbsDelta(left: number[], right: number[]): number {
  let maximum = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function compactVisits(result: any) {
  return result.visitDistribution.map((row) => ({
    actionIndex: row.actionIndex,
    visits: row.visits,
    prior: row.prior,
    meanValue: row.meanValue,
  }));
}

suite("KataCat M3.4.3.1 deterministic-core audit", () => {
  let left: PythonCheckpointEvaluator;
  let right: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const leftCheckpoint = env.KATACAT_M3431_LEFT_CHECKPOINT;
    const rightCheckpoint = env.KATACAT_M3431_RIGHT_CHECKPOINT;
    if (!leftCheckpoint || !rightCheckpoint) throw new Error("M3.4.3.1 checkpoint paths are required");
    left = new PythonCheckpointEvaluator(leftCheckpoint);
    right = new PythonCheckpointEvaluator(rightCheckpoint);
    await Promise.all([left.ready, right.ready]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([left?.close(), right?.close()]);
  });

  it("reproduces identical neural outputs and fixed-simulation PUCT decisions", async () => {
    const outputDir = resolve(env.KATACAT_M3431_DETERMINISM_OUTPUT_DIR ?? "katacat-m3431-determinism");
    const leftCheckpoint = env.KATACAT_M3431_LEFT_CHECKPOINT;
    const rightCheckpoint = env.KATACAT_M3431_RIGHT_CHECKPOINT;
    const states = Array.from({ length: 8 }, (_, index) => deterministicState(index));
    let neuralMaxAbsDelta = 0;
    let actionMismatches = 0;
    let visitMismatches = 0;
    const rows: any[] = [];

    for (const state of states) {
      const [leftEval, rightEval] = await Promise.all([left.evaluate(state), right.evaluate(state)]);
      neuralMaxAbsDelta = Math.max(
        neuralMaxAbsDelta,
        Math.abs(leftEval.value - rightEval.value),
        Math.abs(leftEval.score - rightEval.score),
        maxAbsDelta(leftEval.policyLogits, rightEval.policyLogits),
        maxAbsDelta(leftEval.ownership ?? [], rightEval.ownership ?? []),
      );
      const options = {
        simulations: 32,
        cpuct: 1.35,
        neuralPriorWeight: 0.75,
        scoreValueWeight: 0.05,
        tacticalShell: false,
        captureReadDepth: 7,
        captureAttackMs: 0,
        captureDefenseMs: 0,
        captureDefenseLimit: 1,
      };
      const [leftSearch, rightSearch] = await Promise.all([
        searchKataCatPuct(state, left, options),
        searchKataCatPuct(state, right, options),
      ]);
      const leftAction = encodeKataCatPuctAction(leftSearch.action);
      const rightAction = encodeKataCatPuctAction(rightSearch.action);
      const leftVisits = compactVisits(leftSearch);
      const rightVisits = compactVisits(rightSearch);
      if (leftAction !== rightAction) actionMismatches += 1;
      if (JSON.stringify(leftVisits) !== JSON.stringify(rightVisits)) visitMismatches += 1;
      rows.push({
        stateHash: kataCatStateHash(state),
        ply: state.moveHistory.length,
        currentPlayer: state.currentPlayer,
        leftAction,
        rightAction,
        actionMatch: leftAction === rightAction,
        visitMatch: JSON.stringify(leftVisits) === JSON.stringify(rightVisits),
      });
    }

    const decisionSuiteHash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const leftSha = sha256File(leftCheckpoint);
    const rightSha = sha256File(rightCheckpoint);
    const identicalCheckpoint = leftSha === rightSha;
    const acceptance = {
      identicalCheckpoint,
      neuralOutputsExact: neuralMaxAbsDelta === 0,
      fixedSimulationActionsExact: actionMismatches === 0,
      fixedSimulationVisitsExact: visitMismatches === 0,
      timeBoxedReaderExcluded: true,
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);
    const summary = {
      schemaVersion: 1,
      stage: "M3.4.3.1_DETERMINISTIC_CORE_AUDIT",
      checkpointSha256: { left: leftSha, right: rightSha },
      fixedPositions: rows.length,
      neuralMaxAbsDelta,
      actionMismatches,
      visitMismatches,
      decisionSuiteHash,
      versions: {
        puct: "KATACAT_PUCT_FIXED_SIMULATION_V1",
        tacticalShell: "DISABLED_FOR_DETERMINISM_AUDIT",
        fallback: "M3.4.1_BOUNDED_READER_TESTED_SEPARATELY",
      },
      rows,
      acceptance,
      note: "The wall-clock-bounded tactical reader is excluded from this exact reproducibility audit. Live-agent collapse rates must not be compared on unmatched state distributions, especially when checkpoint SHA values are identical.",
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M3431_DETERMINISM:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 600_000);
});
