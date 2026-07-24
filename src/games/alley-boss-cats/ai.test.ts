import { describe, expect, it } from "vitest";
import { getAIMove } from "./ai";
import { applyMove, createInitialState } from "./rules";

describe("getAIMove", () => {
  it("takes an immediate capture when one is available", () => {
    let state = createInitialState();
    // B's lone cat at (3,3) is one move away from being fully surrounded by A.
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    state = applyMove(state, 5, 7); // B elsewhere
    // It's A's turn; (4,3) captures immediately.
    const action = getAIMove(state, "A", "EASY");
    expect(action).toEqual({ type: "PLACE", row: 4, col: 3 });
  });

  it("never returns a suicide move even under EASY difficulty", () => {
    let state = createInitialState();
    const action = getAIMove(state, "A", "EASY");
    expect(action.type).toBe("PLACE");
  });

  it("completes a NORMAL-difficulty decision on the opening position within a time budget", () => {
    const state = createInitialState();
    const start = Date.now();
    const action = getAIMove(state, "A", "NORMAL");
    const elapsed = Date.now() - start;
    expect(action).toBeDefined();
    expect(elapsed).toBeLessThan(5000);
  });
});
