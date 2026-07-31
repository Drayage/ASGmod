// @ts-nocheck -- Opt-in offline contrast mining uses Node filesystem and Python inference.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { createInitialState, getLegalMoves } from "../rules";
import { BOARD_SIZE, FIRST_PLAYER_MARGIN } from "../types";
import type { GameState } from "../types";
import { verifyKataCatRootChoiceM341 } from "./katacatM341Fallback";
import { findBestMoveVeryHard } from "./minimax";
import {
  encodeKataCatPuctAction,
  KATACAT_PASS_INDEX,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluation, KataCatNeuralEvaluator } from "./katacatPuct";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M343_CONTRAST === "1";
const suite = enabled ? describe : describe.skip;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  const previous = state.moveHistory[state.moveHistory.length - 1];
  return !previous || previous.type === "PASS"
    ? KATACAT_PASS_INDEX
    : previous.row * BOARD_SIZE + previous.col;
}

function statePayload(state: GameState) {
  return {
    currentPlayer: state.currentPlayer,
    ply: state.moveHistory.length,
    board: encodeBoard(state),
    legalActions: legalActions(state),
    territoryA: encodeCoords(state.territories.A),
    territoryB: encodeCoords(state.territories.B),
    remainingA: state.remainingCats.A,
    remainingB: state.remainingCats.B,
    consecutivePasses: state.consecutivePasses,
    lastAction: lastAction(state),
  };
}

function inferenceRequest(state: GameState) {
  return statePayload(state);
}

function finalOwnership(state: GameState): string {
  const ownership = Array<string>(BOARD_CELLS).fill(".");
  for (const index of encodeCoords(state.territories.A)) ownership[index] = "A";
  for (const index of encodeCoords(state.territories.B)) ownership[index] = "B";
  return ownership.join("");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positionHash(state: GameState): string {
  return hashJson(statePayload(state));
}

function splitForGame(gameKey: string): "train" | "validation" {
  const value = Number.parseInt(createHash("sha256").update(gameKey).digest("hex").slice(0, 8), 16);
  return value % 5 === 0 ? "validation" : "train";
}

function replayState(game: any, moveCount: number): GameState {
  let state = createInitialState();
  for (const action of game.openingActions ?? []) state = applyAction(state, action);
  for (let index = 0; index < moveCount; index += 1) state = applyAction(state, game.moves[index].action);
  return state;
}

function terminalState(game: any): GameState {
  return replayState(game, game.moves.length);
}

function sourceGameId(game: any): string {
  return `m343:${game.comparisonId ?? game.matchup}:p${game.pairIndex}:${game.candidatePlayer}`;
}

function actionKey(action: any): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
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
    const python = env.PYTHON ?? "python";
    this.child = spawn(python, ["ml/katacat_m33_infer.py", `--checkpoint=${checkpoint}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        const error = new Error(`KataCat M3.4.3 evaluator exited ${code}: ${this.stderr}`);
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

suite("KataCat M3.4.3 balanced terminal and reader contrast", () => {
  let evaluator: PythonCheckpointEvaluator;

  beforeAll(async () => {
    const checkpoint = env.KATACAT_M343_SOURCE_CHECKPOINT;
    if (!checkpoint) throw new Error("KATACAT_M343_SOURCE_CHECKPOINT is required");
    evaluator = new PythonCheckpointEvaluator(checkpoint);
    await evaluator.ready;
  }, 120_000);

  afterAll(async () => {
    await evaluator?.close();
  });

  it("builds balanced win/loss controls and bounded-reader successor pairs", async () => {
    const replayPath = env.KATACAT_M343_REPLAY_PATH;
    if (!replayPath) throw new Error("KATACAT_M343_REPLAY_PATH is required");
    const outputDir = resolve(env.KATACAT_M343_OUTPUT_DIR ?? "katacat-m343-contrast");
    const simulations = positiveInt("KATACAT_M343_SIMULATIONS", 32);
    const maxPairsPerGame = positiveInt("KATACAT_M343_MAX_READER_PAIRS_PER_GAME", 2);
    const distances = (env.KATACAT_M343_DISTANCES ?? "2,4,6")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0 && value % 2 === 0)
      .sort((a, b) => a - b);
    if (distances.length === 0) throw new Error("At least one positive even distance is required");

    const allGames = readJsonl(replayPath).filter((game) =>
      ["CANDIDATE_IMPROVED_VS_CURRENT", "CANDIDATE_IMPROVED_VS_PARENT_IMPROVED"]
        .includes(game.comparisonId)
    );
    const losses = allGames.filter((game) => !game.candidateWon);
    const wins = allGames.filter((game) => game.candidateWon);
    const winsByKey = new Map<string, any[]>();
    for (const game of wins) {
      const key = `${game.comparisonId}:${game.candidatePlayer}:${splitForGame(sourceGameId(game))}`;
      const rows = winsByKey.get(key) ?? [];
      rows.push(game);
      winsByKey.set(key, rows);
    }
    for (const rows of winsByKey.values()) rows.sort((a, b) => sourceGameId(a).localeCompare(sourceGameId(b)));

    const terminalRows: any[] = [];
    const readerPairs: any[] = [];
    const audit: any[] = [];
    const puctOptions = {
      simulations,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight: 0.05,
      tacticalShell: true,
      captureReadDepth: 7,
      captureAttackMs: 25,
      captureDefenseMs: 50,
      captureDefenseLimit: 12,
    };
    const guardOptions = {
      finalVerificationDepth: 7,
      finalVerificationMs: 75,
      finalVerificationLimit: 5,
      rescueVerificationLimit: 8,
      rescueVerificationMs: 50,
      rescueTotalMs: 450,
    };
    const improvedOptions = { verificationDepth: 7, verificationMs: 25, verificationLimit: 82 };
    const rescue = (state, player) => findBestMoveVeryHard(state, player, 50);

    for (const game of losses) {
      const collapseIndex = game.moves.findIndex((move) =>
        move.player === game.candidatePlayer
        && move.agent === "CANDIDATE_IMPROVED"
        && move.guard?.allRootActionsRefuted === true
      );
      if (collapseIndex < 0) continue;
      const lossId = sourceGameId(game);
      const split = splitForGame(lossId);
      const final = terminalState(game);
      if (!final.winner || !final.winReason) continue;
      const adjustedMarginA = final.territories.A.length - final.territories.B.length - FIRST_PLAYER_MARGIN;
      const ownership = finalOwnership(final);
      const winKey = `${game.comparisonId}:${game.candidatePlayer}:${split}`;
      const controls = winsByKey.get(winKey) ?? [];
      let createdLosses = 0;
      let createdControls = 0;

      for (const distance of distances) {
        const moveIndex = collapseIndex - distance;
        if (moveIndex < 0) continue;
        const replayMove = game.moves[moveIndex];
        if (replayMove.player !== game.candidatePlayer || replayMove.agent !== "CANDIDATE_IMPROVED") continue;
        const state = replayState(game, moveIndex);
        if (state.winner || state.currentPlayer !== game.candidatePlayer) continue;
        const pairId = `${lossId}:collapse${game.moves[collapseIndex].ply}:d${distance}`;
        terminalRows.push({
          schemaVersion: 1,
          sampleId: `${pairId}:loss`,
          pairId,
          gameId: lossId,
          split,
          positionHash: positionHash(state),
          sourceMode: "REAL_COLLAPSE_LOSS",
          contrastLabel: "LOSS",
          contrastDistance: distance,
          ...statePayload(state),
          finalWinner: final.winner,
          finalWinReason: final.winReason,
          finalAdjustedMarginA: adjustedMarginA,
          finalOwnership: ownership,
        });
        createdLosses += 1;

        if (controls.length > 0) {
          const selector = Number.parseInt(hashJson(pairId).slice(0, 8), 16);
          const control = controls[selector % controls.length];
          const candidateIndices = control.moves
            .map((move, index) => ({ move, index }))
            .filter(({ move }) => move.player === control.candidatePlayer && move.agent === "CANDIDATE_IMPROVED")
            .sort((left, right) => {
              const leftDelta = Math.abs(left.index - moveIndex);
              const rightDelta = Math.abs(right.index - moveIndex);
              return leftDelta - rightDelta || left.index - right.index;
            });
          if (candidateIndices.length > 0) {
            const controlIndex = candidateIndices[0].index;
            const controlState = replayState(control, controlIndex);
            const controlFinal = terminalState(control);
            if (!controlState.winner && controlFinal.winner === control.candidatePlayer && controlFinal.winReason) {
              const controlMarginA = controlFinal.territories.A.length
                - controlFinal.territories.B.length - FIRST_PLAYER_MARGIN;
              terminalRows.push({
                schemaVersion: 1,
                sampleId: `${pairId}:win:${sourceGameId(control)}:${controlIndex}`,
                pairId,
                gameId: sourceGameId(control),
                split,
                positionHash: positionHash(controlState),
                sourceMode: "MATCHED_NATURAL_WIN_CONTROL",
                contrastLabel: "WIN",
                contrastDistance: distance,
                matchedLossGameId: lossId,
                ...statePayload(controlState),
                finalWinner: controlFinal.winner,
                finalWinReason: controlFinal.winReason,
                finalAdjustedMarginA: controlMarginA,
                finalOwnership: finalOwnership(controlFinal),
              });
              createdControls += 1;
            }
          }
        }
      }

      let pairCount = 0;
      const scanStart = Math.max(0, collapseIndex - 8);
      for (let moveIndex = scanStart; moveIndex < collapseIndex && pairCount < maxPairsPerGame; moveIndex += 1) {
        const move = game.moves[moveIndex];
        if (move.player !== game.candidatePlayer || move.agent !== "CANDIDATE_IMPROVED") continue;
        const state = replayState(game, moveIndex);
        if (state.winner || state.currentPlayer !== game.candidatePlayer) continue;
        const raw = await searchKataCatPuct(state, evaluator, puctOptions);
        const checked = verifyKataCatRootChoiceM341(
          state,
          raw,
          guardOptions,
          improvedOptions,
          undefined,
          rescue,
        );
        if (!checked.report.selectedActionWasRefuted || !checked.report.improvedFallbackSelected) continue;
        if (actionKey(raw.action) === actionKey(checked.action)) continue;
        const dangerous = applyAction(state, raw.action);
        const safer = applyAction(state, checked.action);
        if (dangerous.winner || safer.winner) continue;
        const pairId = `${lossId}:reader:${move.ply}`;
        readerPairs.push({
          schemaVersion: 1,
          pairId,
          gameId: lossId,
          split,
          originalPlayer: state.currentPlayer,
          sourceMode: "BOUNDED_READER_SUCCESSOR_CONTRAST",
          semantics: {
            dangerous: "The configured reader refuted the original PUCT root action.",
            safer: "The configured bounded reader did not find a forced capture for the replacement action.",
            proofCaveat: "NOT_REFUTED is not a mathematical proof of safety.",
            successorPerspective: "Both value predictions are from the opponent-to-move perspective; dangerous should be higher than safer.",
          },
          originalAction: encodeKataCatPuctAction(raw.action),
          saferAction: encodeKataCatPuctAction(checked.action),
          dangerous: { ...statePayload(dangerous), positionHash: positionHash(dangerous) },
          safer: { ...statePayload(safer), positionHash: positionHash(safer) },
        });
        pairCount += 1;
      }
      audit.push({ lossId, split, collapsePly: game.moves[collapseIndex].ply, createdLosses, createdControls, readerPairs: pairCount });
    }

    const dedupeRows = (rows: any[]) => {
      const byHash = new Map<string, any[]>();
      for (const row of rows) {
        const bucket = byHash.get(row.positionHash) ?? [];
        bucket.push(row);
        byHash.set(row.positionHash, bucket);
      }
      return [...byHash.values()]
        .map((bucket) => [...bucket].sort((a, b) => a.sampleId.localeCompare(b.sampleId))[0])
        .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
    };
    const uniqueTerminal = dedupeRows(terminalRows);
    const balanced: any[] = [];
    const balanceAudit: any = {};
    for (const split of ["train", "validation"] as const) {
      balanceAudit[split] = {};
      for (const seat of ["A", "B"] as const) {
        const lossesForSeat = uniqueTerminal
          .filter((row) => row.split === split && row.currentPlayer === seat && row.contrastLabel === "LOSS")
          .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
        const winsForSeat = uniqueTerminal
          .filter((row) => row.split === split && row.currentPlayer === seat && row.contrastLabel === "WIN")
          .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
        const count = Math.min(lossesForSeat.length, winsForSeat.length);
        balanced.push(...lossesForSeat.slice(0, count), ...winsForSeat.slice(0, count));
        balanceAudit[split][seat] = {
          available: { LOSS: lossesForSeat.length, WIN: winsForSeat.length },
          selected: { LOSS: count, WIN: count },
        };
      }
    }
    balanced.sort((a, b) => a.sampleId.localeCompare(b.sampleId));

    const uniquePairs = [...new Map(readerPairs.map((pair) => [pair.pairId, pair])).values()]
      .sort((a, b) => a.pairId.localeCompare(b.pairId));
    const counts = {
      terminal: {
        train: {
          A: { WIN: balanced.filter((r) => r.split === "train" && r.currentPlayer === "A" && r.contrastLabel === "WIN").length,
               LOSS: balanced.filter((r) => r.split === "train" && r.currentPlayer === "A" && r.contrastLabel === "LOSS").length },
          B: { WIN: balanced.filter((r) => r.split === "train" && r.currentPlayer === "B" && r.contrastLabel === "WIN").length,
               LOSS: balanced.filter((r) => r.split === "train" && r.currentPlayer === "B" && r.contrastLabel === "LOSS").length },
        },
        validation: {
          A: { WIN: balanced.filter((r) => r.split === "validation" && r.currentPlayer === "A" && r.contrastLabel === "WIN").length,
               LOSS: balanced.filter((r) => r.split === "validation" && r.currentPlayer === "A" && r.contrastLabel === "LOSS").length },
          B: { WIN: balanced.filter((r) => r.split === "validation" && r.currentPlayer === "B" && r.contrastLabel === "WIN").length,
               LOSS: balanced.filter((r) => r.split === "validation" && r.currentPlayer === "B" && r.contrastLabel === "LOSS").length },
        },
      },
      readerPairs: {
        train: uniquePairs.filter((p) => p.split === "train").length,
        validation: uniquePairs.filter((p) => p.split === "validation").length,
      },
    };
    const sourceGamesBySplit = {
      train: new Set([...balanced.filter((r) => r.split === "train").map((r) => r.gameId), ...uniquePairs.filter((p) => p.split === "train").map((p) => p.gameId)]),
      validation: new Set([...balanced.filter((r) => r.split === "validation").map((r) => r.gameId), ...uniquePairs.filter((p) => p.split === "validation").map((p) => p.gameId)]),
    };
    const terminalHashes = new Set(balanced.map((row) => row.positionHash));
    const readerHashes = uniquePairs.flatMap((pair) => [pair.dangerous.positionHash, pair.safer.positionHash]);
    const acceptance = {
      sourceGamesPresent: allGames.length > 0 && losses.length > 0 && wins.length > 0,
      balancedTerminalRowsPresent: balanced.length > 0,
      exactWinLossBalanceBySplitAndSeat: ["train", "validation"].every((split) =>
        ["A", "B"].every((seat) => counts.terminal[split][seat].WIN > 0
          && counts.terminal[split][seat].WIN === counts.terminal[split][seat].LOSS)),
      readerPairsPresent: counts.readerPairs.train > 0 && counts.readerPairs.validation > 0,
      gameSplitDisjoint: [...sourceGamesBySplit.train].every((gameId) => !sourceGamesBySplit.validation.has(gameId)),
      terminalPositionHashesUnique: terminalHashes.size === balanced.length,
      readerPairHashesComplete: readerHashes.length === uniquePairs.length * 2 && readerHashes.every(Boolean),
      naturalTerminalLabelsOnly: balanced.every((row) => row.finalWinner && row.finalWinReason),
      noInventedPolicyNegatives: balanced.every((row) => row.negativeActions === undefined),
      boundedReaderCaveatRecorded: uniquePairs.every((pair) => pair.semantics?.proofCaveat?.includes("not a mathematical proof")),
      noRandomRollouts: true,
      passed: false,
    };
    acceptance.passed = Object.entries(acceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const summary = {
      schemaVersion: 1,
      stage: "M3.4.3_BALANCED_CONTRAST",
      sourceReplayPath: replayPath,
      sourceGames: allGames.length,
      sourceLosses: losses.length,
      sourceWins: wins.length,
      rawTerminalRows: terminalRows.length,
      uniqueTerminalRows: uniqueTerminal.length,
      selectedBalancedRows: balanced.length,
      readerPairs: uniquePairs.length,
      distances,
      counts,
      balanceAudit,
      audit,
      semantics: {
        terminal: "Natural wins and collapse-loss ancestors are balanced separately by split and seat.",
        readerPair: "A proved-refuted PUCT successor is ranked above a bounded-reader-not-refuted successor from the opponent-to-move perspective.",
        caveat: "Bounded non-refutation is diagnostic evidence, not a proof of safety.",
      },
      acceptance,
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "katacat-m343-balanced-samples.jsonl"),
      balanced.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(
      resolve(outputDir, "katacat-m343-reader-pairs.jsonl"),
      uniquePairs.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M343_CONTRAST:${JSON.stringify(summary)}`);
    expect(acceptance.passed).toBe(true);
  }, 7_200_000);
});
