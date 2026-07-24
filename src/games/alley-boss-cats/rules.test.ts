import { describe, expect, it } from "vitest";
import { CENTER } from "./types";
import { applyMove, calculateFinalResult, createInitialState, isLegalMove, passTurn } from "./rules";

describe("createInitialState", () => {
  it("starts with an empty 9x9 board, a communal feeding spot, and 40 cats each", () => {
    const state = createInitialState();
    expect(state.board).toHaveLength(9);
    expect(state.board[CENTER][CENTER]).toBe("NEUTRAL");
    expect(state.remainingCats).toEqual({ A: 40, B: 40 });
    expect(state.currentPlayer).toBe("A");
    expect(state.consecutivePasses).toBe(0);
    expect(state.winner).toBeNull();
  });
});

describe("placement legality", () => {
  it("allows placing on an empty cell", () => {
    const state = createInitialState();
    expect(isLegalMove(state, 0, 0, "A")).toBe(true);
  });

  it("forbids placing on an occupied cell", () => {
    let state = createInitialState();
    state = applyMove(state, 0, 0);
    expect(isLegalMove(state, 0, 0, "B")).toBe(false);
  });

  it("forbids placing on the communal feeding spot", () => {
    const state = createInitialState();
    expect(isLegalMove(state, CENTER, CENTER, "A")).toBe(false);
  });

  it("forbids placing inside a confirmed territory", () => {
    let state = createInitialState();
    // A walls off the (0,0) corner.
    state = applyMove(state, 0, 1); // A
    state = applyMove(state, 8, 8); // B, somewhere irrelevant
    state = applyMove(state, 1, 0); // A completes the pocket
    expect(state.territories.A).toEqual(expect.arrayContaining([{ row: 0, col: 0 }]));
    expect(isLegalMove(state, 0, 0, "B")).toBe(false);
    expect(isLegalMove(state, 0, 0, "A")).toBe(false);
  });
});

describe("capture-priority rule", () => {
  it("lets a move that captures the opponent stand even if it also strands the mover", () => {
    // B has one cat at (4,3) with a single liberty at (4,2). A plays into a
    // spot that captures a fully-surrounded B group; the fact that A's own
    // new stone might look precarious elsewhere must not block this.
    let state = createInitialState();
    // Surround B's lone cat at (3,3): liberties are (2,3),(4,3),(3,2),(3,4).
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 3); // B
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A
    expect(state.winner).toBeNull();
    // Final liberty:
    state = applyMove(state, 5, 7); // B elsewhere (keep it B's turn cycle)
    expect(isLegalMove(state, 4, 3, "A")).toBe(true);
    state = applyMove(state, 4, 3); // A captures
    expect(state.winner).toBe("A");
    expect(state.winReason).toBe("CAPTURE");
  });

  it("captures a whole connected enemy group at once", () => {
    let state = createInitialState();
    // A A A A
    // A B B A
    // A A A A
    // Build it via applyMove alternating turns. B's "elsewhere" filler moves
    // are isolated singletons (spaced 2+ apart) so they never accidentally
    // wall off a territory pocket of their own.
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 1, 1); // B
    state = applyMove(state, 0, 0); // A
    state = applyMove(state, 1, 2); // B
    state = applyMove(state, 0, 1); // A
    state = applyMove(state, 8, 0); // B elsewhere
    state = applyMove(state, 0, 2); // A
    state = applyMove(state, 8, 2); // B elsewhere
    state = applyMove(state, 0, 3); // A
    state = applyMove(state, 8, 4); // B elsewhere
    state = applyMove(state, 1, 0); // A
    state = applyMove(state, 6, 0); // B elsewhere
    state = applyMove(state, 1, 3); // A
    state = applyMove(state, 6, 2); // B elsewhere
    state = applyMove(state, 2, 0); // A
    state = applyMove(state, 6, 4); // B elsewhere
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 4, 0); // B elsewhere
    expect(isLegalMove(state, 2, 1, "A")).toBe(true);
    state = applyMove(state, 2, 1); // A
    state = applyMove(state, 4, 2); // B elsewhere
    state = applyMove(state, 2, 2); // A: closes the last liberty of the B group
    expect(state.winner).toBe("A");
    expect(state.winReason).toBe("CAPTURE");
  });
});

describe("suicide rule", () => {
  it("forbids a move that removes the mover's own last liberty without capturing", () => {
    let state = createInitialState();
    // Surround (4,4) on three sides with B, leaving (4,5) open, then A tries
    // to move into (4,4) — that would leave A's own lone cat with 0 liberties
    // and captures nothing, so it must be illegal.
    state = { ...state, currentPlayer: "B" };
    state = applyMove(state, 3, 4); // B
    state = applyMove(state, 0, 0); // A elsewhere
    state = applyMove(state, 5, 4); // B
    state = applyMove(state, 0, 1); // A elsewhere
    state = applyMove(state, 4, 5); // B
    state = applyMove(state, 0, 2); // A elsewhere
    state = applyMove(state, 4, 3); // B closes 3 of 4 sides
    expect(isLegalMove(state, 4, 4, "A")).toBe(false);
  });
});

describe("pass / game end", () => {
  it("keeps the game going after a single pass", () => {
    let state = createInitialState();
    state = passTurn(state);
    expect(state.winner).toBeNull();
    expect(state.currentPlayer).toBe("B");
    expect(state.consecutivePasses).toBe(1);
  });

  it("resets the pass counter once the opponent places a cat", () => {
    let state = createInitialState();
    state = passTurn(state); // A passes
    state = applyMove(state, 0, 0); // B places
    expect(state.consecutivePasses).toBe(0);
  });

  it("ends the game on two consecutive passes and scores by territory", () => {
    let state = createInitialState();
    state = passTurn(state); // A
    state = passTurn(state); // B
    expect(state.winner).not.toBeNull();
    expect(state.winReason).toBe("TERRITORY");
  });
});

describe("calculateFinalResult (first-player margin)", () => {
  const base = createInitialState();

  it("cheese cat (A) needs at least a 3-cell lead", () => {
    expect(
      calculateFinalResult({ ...base, territories: { A: Array(10).fill({ row: 0, col: 0 }), B: Array(7).fill({ row: 0, col: 0 }) } }).winner,
    ).toBe("A");
    expect(
      calculateFinalResult({ ...base, territories: { A: Array(9).fill({ row: 0, col: 0 }), B: Array(7).fill({ row: 0, col: 0 }) } }).winner,
    ).toBe("B");
    expect(
      calculateFinalResult({ ...base, territories: { A: Array(8).fill({ row: 0, col: 0 }), B: Array(8).fill({ row: 0, col: 0 }) } }).winner,
    ).toBe("B");
    expect(
      calculateFinalResult({ ...base, territories: { A: Array(12).fill({ row: 0, col: 0 }), B: Array(9).fill({ row: 0, col: 0 }) } }).winner,
    ).toBe("A");
  });
});
