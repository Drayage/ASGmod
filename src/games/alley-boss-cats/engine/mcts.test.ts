import { describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { applyMove, createInitialState, isLegalMove } from "../rules";
import { findBestMoveHybridMCTS } from "./mcts";

const FAST_OPTIONS = {
  simulations: 8,
  seed: 17,
  playoutDepth: 3,
  rootScreenLimit: 0,
};

describe("findBestMoveHybridMCTS", () => {
  it("returns a legal action from the opening position", () => {
    const state = createInitialState();
    const result = findBestMoveHybridMCTS(state, "A", FAST_OPTIONS);

    expect(result.simulations).toBe(8);
    expect(result.action.type).toBe("PLACE");
    if (result.action.type === "PLACE") {
      expect(isLegalMove(state, result.action.row, result.action.col, "A")).toBe(true);
    }
  });

  it("is reproducible with the same seed and fixed simulation budget", () => {
    const state = createInitialState();
    const first = findBestMoveHybridMCTS(state, "A", FAST_OPTIONS);
    const second = findBestMoveHybridMCTS(state, "A", FAST_OPTIONS);

    expect(second.action).toEqual(first.action);
    expect(second.rootStats).toEqual(first.rootStats);
  });

  it("takes an immediate capture before starting simulations", () => {
    let state = createInitialState();
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    state = applyMove(state, 5, 7); // B elsewhere

    const result = findBestMoveHybridMCTS(state, "A", FAST_OPTIONS);
    expect(result.action).toEqual({ type: "PLACE", row: 4, col: 3 });
    expect(result.simulations).toBe(0);
    expect(applyAction(state, result.action).winner).toBe("A");
  });
});
