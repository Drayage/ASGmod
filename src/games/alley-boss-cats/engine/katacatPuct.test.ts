import { describe, expect, it } from "vitest";
import { getSafeActions } from "../ai";
import { createInitialState } from "../rules";
import { BOARD_SIZE, CENTER, STARTING_CATS } from "../types";
import type { Board, GameState } from "../types";
import {
  encodeKataCatPuctAction,
  KATACAT_POLICY_SIZE,
  searchKataCatPuct,
} from "./katacatPuct";
import type { KataCatNeuralEvaluator } from "./katacatPuct";

function evaluatorWithPreferredAction(preferredAction = -1): KataCatNeuralEvaluator {
  return {
    async evaluate() {
      const policyLogits = Array<number>(KATACAT_POLICY_SIZE).fill(0);
      if (preferredAction >= 0) policyLogits[preferredAction] = 8;
      return {
        policyLogits,
        value: 0,
        score: 0,
        ownership: Array<number>(BOARD_SIZE * BOARD_SIZE * 3).fill(0),
      };
    },
  };
}

function emptyBoard(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill("EMPTY"),
  );
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

function tacticalState(board: Board, currentPlayer: "A" | "B"): GameState {
  return {
    board,
    currentPlayer,
    remainingCats: { A: STARTING_CATS - 1, B: STARTING_CATS - 1 },
    consecutivePasses: 0,
    territories: { A: [], B: [] },
    winner: null,
    winReason: null,
    moveHistory: [],
  };
}

describe("KataCat neural PUCT", () => {
  it("accounts for every simulation, masks unsafe actions, and is deterministic", async () => {
    const state = createInitialState();
    const options = {
      simulations: 32,
      cpuct: 1.35,
      neuralPriorWeight: 0.75,
      scoreValueWeight: 0.05,
    };
    const first = await searchKataCatPuct(state, evaluatorWithPreferredAction(0), options);
    const second = await searchKataCatPuct(state, evaluatorWithPreferredAction(0), options);

    expect(first.reason).toBe("SEARCH");
    expect(first.visitDistribution.reduce((sum, record) => sum + record.visits, 0)).toBe(32);
    expect(first.visitDistribution).toEqual(second.visitDistribution);
    expect(first.action).toEqual(second.action);

    const safe = new Set(
      getSafeActions(state, state.currentPlayer).pool.map(encodeKataCatPuctAction),
    );
    expect(first.visitDistribution.every((record) => safe.has(record.actionIndex))).toBe(true);
    expect(first.visitDistribution.every((record) => Number.isFinite(record.meanValue))).toBe(true);

    const preferred = first.visitDistribution.find((record) => record.actionIndex === 0);
    const maximumOtherVisits = Math.max(
      ...first.visitDistribution
        .filter((record) => record.actionIndex !== 0)
        .map((record) => record.visits),
    );
    expect(preferred?.visits ?? 0).toBeGreaterThan(maximumOtherVisits);
  });

  it("returns an immediate capture without consulting the network", async () => {
    const board = emptyBoard();
    board[0][0] = "PLAYER_B";
    board[1][0] = "PLAYER_A";
    const state = tacticalState(board, "A");
    let evaluations = 0;
    const evaluator: KataCatNeuralEvaluator = {
      async evaluate() {
        evaluations += 1;
        return evaluatorWithPreferredAction().evaluate(state);
      },
    };

    const result = await searchKataCatPuct(state, evaluator, { simulations: 16 });
    expect(result.reason).toBe("IMMEDIATE_WIN");
    expect(result.action).toEqual({ type: "PLACE", row: 0, col: 1 });
    expect(result.simulations).toBe(0);
    expect(evaluations).toBe(0);
  });

  it("never expands a root move that volunteers an immediate capture loss", async () => {
    const board = emptyBoard();
    board[0][0] = "PLAYER_A";
    board[1][0] = "PLAYER_B";
    const state = tacticalState(board, "A");
    const safe = getSafeActions(state, state.currentPlayer);
    const safeIndices = new Set(safe.pool.map(encodeKataCatPuctAction));

    expect(safeIndices.has(1)).toBe(true);
    expect(safeIndices.size).toBeLessThan(BOARD_SIZE * BOARD_SIZE);

    const result = await searchKataCatPuct(state, evaluatorWithPreferredAction(80), {
      simulations: 24,
      neuralPriorWeight: 1,
    });
    expect(result.visitDistribution.every((record) => safeIndices.has(record.actionIndex))).toBe(
      true,
    );
    expect(safeIndices.has(encodeKataCatPuctAction(result.action))).toBe(true);
  });
});
