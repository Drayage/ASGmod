import { describe, expect, it } from "vitest";
import {
  createInitialState,
  getAllLegalPlacements,
  getLegalAnchors,
  hasAnyLegalPlacement,
  isLegalPlacement,
  playAction,
  resolveTurn,
} from "./rules";
import type { GameState } from "./types";

describe("createInitialState", () => {
  it("starts with an empty 20x20 board, all 21 pieces per color, BLUE to move", () => {
    const state = createInitialState();
    expect(state.board).toHaveLength(20);
    expect(state.board[0]).toHaveLength(20);
    expect(state.board.every((row) => row.every((cell) => cell === null))).toBe(true);
    for (const color of ["BLUE", "YELLOW", "RED", "GREEN"] as const) {
      expect(state.remaining[color]).toHaveLength(21);
      expect(state.hasPlayed[color]).toBe(false);
    }
    expect(state.currentColor).toBe("BLUE");
    expect(state.winner).toBeNull();
  });
});

describe("isLegalPlacement", () => {
  it("requires each color's first piece to cover its own corner start square", () => {
    const state = createInitialState();
    expect(isLegalPlacement(state, "BLUE", "1", [{ row: 0, col: 0 }])).toBe(true);
    expect(isLegalPlacement(state, "YELLOW", "1", [{ row: 0, col: 19 }])).toBe(true);
    expect(isLegalPlacement(state, "RED", "1", [{ row: 19, col: 19 }])).toBe(true);
    expect(isLegalPlacement(state, "GREEN", "1", [{ row: 19, col: 0 }])).toBe(true);
    expect(isLegalPlacement(state, "BLUE", "1", [{ row: 5, col: 5 }])).toBe(false);
  });

  it("a teammate's other color gives no adjacency privilege — only same color matters", () => {
    let state = createInitialState();
    // BLUE (P1) plays first, then RED (P1's teammate color) tries to build
    // off of BLUE's piece — that's not legal; RED must touch RED.
    state = playAction(state, { kind: "PLACE", color: "BLUE", pieceId: "1", cells: [{ row: 0, col: 0 }] });
    // RED isn't even up yet (BLUE -> YELLOW next), but legality doesn't
    // depend on turn order, only on state — corner-adjacent to BLUE's
    // piece, no RED piece anywhere, and RED hasn't played yet so it must
    // cover RED's own start square regardless.
    expect(isLegalPlacement(state, "RED", "1", [{ row: 1, col: 1 }])).toBe(false);
    expect(isLegalPlacement(state, "RED", "1", [{ row: 19, col: 19 }])).toBe(true);
  });

  it("rejects edge-adjacency to the same color but allows corner-adjacency", () => {
    let state = createInitialState();
    state = playAction(state, { kind: "PLACE", color: "BLUE", pieceId: "1", cells: [{ row: 0, col: 0 }] });
    state = playAction(state, { kind: "PLACE", color: "YELLOW", pieceId: "1", cells: [{ row: 0, col: 19 }] });
    state = playAction(state, { kind: "PLACE", color: "RED", pieceId: "1", cells: [{ row: 19, col: 19 }] });
    state = playAction(state, { kind: "PLACE", color: "GREEN", pieceId: "1", cells: [{ row: 19, col: 0 }] });
    // BLUE's second piece: edge-adjacent to (0,0) is illegal...
    expect(isLegalPlacement(state, "BLUE", "2", [{ row: 0, col: 1 }, { row: 0, col: 2 }])).toBe(false);
    // ...but corner-adjacent, no edge touch, is legal.
    expect(isLegalPlacement(state, "BLUE", "2", [{ row: 1, col: 1 }, { row: 1, col: 2 }])).toBe(true);
  });
});

describe("getLegalAnchors", () => {
  it("offers exactly each color's own corner before that color's first move", () => {
    const state = createInitialState();
    expect(getLegalAnchors(state, "GREEN", "1", 0)).toEqual([{ row: 19, col: 0 }]);
  });
});

describe("getAllLegalPlacements / hasAnyLegalPlacement", () => {
  it("has no legal placements for a color with no remaining pieces", () => {
    const state = createInitialState();
    const empty: GameState = { ...state, remaining: { ...state.remaining, BLUE: [] } };
    expect(hasAnyLegalPlacement(empty, "BLUE")).toBe(false);
    expect(getAllLegalPlacements(empty, "BLUE")).toEqual([]);
  });

  it("has legal placements for every color at the start of the game", () => {
    const state = createInitialState();
    for (const color of ["BLUE", "YELLOW", "RED", "GREEN"] as const) {
      expect(hasAnyLegalPlacement(state, color)).toBe(true);
    }
  });
});

describe("playAction / resolveTurn", () => {
  it("cycles BLUE -> YELLOW -> RED -> GREEN -> BLUE", () => {
    let state = createInitialState();
    expect(state.currentColor).toBe("BLUE");
    state = playAction(state, { kind: "PLACE", color: "BLUE", pieceId: "1", cells: [{ row: 0, col: 0 }] });
    expect(state.currentColor).toBe("YELLOW");
    state = playAction(state, { kind: "PLACE", color: "YELLOW", pieceId: "1", cells: [{ row: 0, col: 19 }] });
    expect(state.currentColor).toBe("RED");
  });

  it("skips a color with no legal placement instead of ending the game", () => {
    let state = createInitialState();
    state = { ...state, remaining: { ...state.remaining, YELLOW: [] } };
    // BLUE moves; YELLOW is out of pieces and gets skipped, landing on RED.
    state = playAction(state, { kind: "PLACE", color: "BLUE", pieceId: "1", cells: [{ row: 0, col: 0 }] });
    expect(state.currentColor).toBe("RED");
    expect(state.winner).toBeNull();
  });

  it("ends the game once every color is out of legal placements, scored by team", () => {
    const state = createInitialState();
    const stuck: GameState = {
      ...state,
      remaining: { BLUE: [], YELLOW: [], RED: [], GREEN: [] },
    };
    const after = resolveTurn(stuck);
    expect(after.winner).toBe("DRAW");
    expect(after.colorScores).toEqual({ BLUE: 15, YELLOW: 15, RED: 15, GREEN: 15 });
    expect(after.scores).toEqual({ P1: 30, P2: 30 });
  });

  it("sums each player's two colors into one team score", () => {
    const state = createInitialState();
    // P1 = BLUE + RED, both fully placed; P2 = YELLOW + GREEN, both empty-handed with one piece left.
    const stuck: GameState = {
      ...state,
      remaining: { BLUE: [], YELLOW: ["1"], RED: [], GREEN: ["2"] },
      hasPlayed: { BLUE: true, YELLOW: false, RED: true, GREEN: false },
      board: (() => {
        const b = state.board.map((row) => [...row]);
        b[0][19] = "BLUE"; // occupies YELLOW's own start square before YELLOW ever moves
        b[19][0] = "RED"; // occupies GREEN's own start square before GREEN ever moves
        return b;
      })(),
    };
    const after = resolveTurn(stuck);
    expect(after.colorScores).toEqual({ BLUE: 15, YELLOW: -1, RED: 15, GREEN: -2 });
    expect(after.scores).toEqual({ P1: 30, P2: -3 });
    expect(after.winner).toBe("P1");
  });
});
