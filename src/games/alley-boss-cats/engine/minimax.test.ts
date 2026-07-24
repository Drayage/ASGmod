import { describe, expect, it } from "vitest";
import { applyMove, createInitialState } from "../rules";
import { findBestMoveMinimax } from "./minimax";

describe("findBestMoveMinimax", () => {
  it("takes an immediate capture when one is available", () => {
    let state = createInitialState();
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    state = applyMove(state, 5, 7); // B elsewhere

    const action = findBestMoveMinimax(state, "A", 500);
    expect(action).toEqual({ type: "PLACE", row: 4, col: 3 });
  });

  it("returns a legal action on the opening position within its time budget", () => {
    const state = createInitialState();
    const start = Date.now();
    const action = findBestMoveMinimax(state, "A", 700);
    const elapsed = Date.now() - start;
    expect(action.type === "PLACE" || action.type === "PASS").toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});
