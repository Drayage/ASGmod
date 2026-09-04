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
  it("starts with an empty 14x14 board, all 21 pieces each, and P1 to move", () => {
    const state = createInitialState();
    expect(state.board).toHaveLength(14);
    expect(state.board[0]).toHaveLength(14);
    expect(state.board.every((row) => row.every((cell) => cell === null))).toBe(true);
    expect(state.remaining.P1).toHaveLength(21);
    expect(state.remaining.P2).toHaveLength(21);
    expect(state.currentPlayer).toBe("P1");
    expect(state.winner).toBeNull();
  });
});

describe("isLegalPlacement", () => {
  it("requires a player's first piece to cover their start square", () => {
    const state = createInitialState();
    expect(isLegalPlacement(state, "P1", "1", [{ row: 4, col: 4 }])).toBe(true);
    expect(isLegalPlacement(state, "P1", "1", [{ row: 0, col: 0 }])).toBe(false);
    expect(isLegalPlacement(state, "P2", "1", [{ row: 9, col: 9 }])).toBe(true);
  });

  it("rejects a placement whose shape doesn't match any real orientation of the piece", () => {
    const state = createInitialState();
    // Two cells that aren't adjacent at all — not a domino in any orientation.
    expect(isLegalPlacement(state, "P1", "2", [{ row: 4, col: 4 }, { row: 6, col: 6 }])).toBe(false);
  });

  it("rejects out-of-bounds or already-occupied cells", () => {
    const state = createInitialState();
    expect(isLegalPlacement(state, "P1", "1", [{ row: 14, col: 4 }])).toBe(false);
    const afterFirst = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    expect(isLegalPlacement(afterFirst, "P2", "1", [{ row: 4, col: 4 }])).toBe(false);
  });

  it("after a first move, a same-color piece must corner-touch and never edge-touch", () => {
    let state = createInitialState();
    state = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    // Edge-adjacent to (4,4): illegal even though it's otherwise a valid domino shape.
    expect(isLegalPlacement(state, "P1", "2", [{ row: 4, col: 5 }, { row: 4, col: 6 }])).toBe(false);
    // Corner-adjacent to (4,4) via (3,5), no edge touch: legal.
    expect(isLegalPlacement(state, "P1", "2", [{ row: 3, col: 5 }, { row: 3, col: 6 }])).toBe(true);
    // Touches neither corner nor edge of the only P1 piece: illegal.
    expect(isLegalPlacement(state, "P1", "2", [{ row: 8, col: 8 }, { row: 8, col: 9 }])).toBe(false);
  });

  it("lets a placement touch an opponent piece freely, edge or corner", () => {
    let state = createInitialState();
    state = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    state = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 9, col: 9 }] });
    // P1's second piece placed edge-adjacent to P2's lone piece is fine —
    // only same-color edge-touching is forbidden.
    expect(isLegalPlacement(state, "P1", "2", [{ row: 3, col: 5 }, { row: 3, col: 6 }])).toBe(true);
  });

  it("never allows a piece not currently in the player's remaining set", () => {
    let state = createInitialState();
    state = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    expect(isLegalPlacement(state, "P1", "1", [{ row: 3, col: 5 }])).toBe(false);
  });
});

describe("getLegalAnchors", () => {
  it("offers exactly the start square before a player's first move", () => {
    const state = createInitialState();
    const anchors = getLegalAnchors(state, "P1", "1", 0);
    expect(anchors).toEqual([{ row: 4, col: 4 }]);
  });

  it("wraps orientation index by modulo instead of throwing", () => {
    const state = createInitialState();
    expect(() => getLegalAnchors(state, "P1", "2", 99)).not.toThrow();
  });
});

describe("getAllLegalPlacements / hasAnyLegalPlacement", () => {
  it("has no legal placements for a player with no remaining pieces", () => {
    const state = createInitialState();
    const empty: GameState = { ...state, remaining: { ...state.remaining, P1: [] } };
    expect(hasAnyLegalPlacement(empty, "P1")).toBe(false);
    expect(getAllLegalPlacements(empty, "P1")).toEqual([]);
  });

  it("has legal placements for both players at the start of the game", () => {
    const state = createInitialState();
    expect(hasAnyLegalPlacement(state, "P1")).toBe(true);
    expect(hasAnyLegalPlacement(state, "P2")).toBe(true);
  });
});

describe("playAction / resolveTurn", () => {
  it("switches the turn after a legal placement", () => {
    const state = createInitialState();
    const after = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    expect(after.currentPlayer).toBe("P2");
    expect(after.remaining.P1).not.toContain("1");
    expect(after.board[4][4]).toBe("P1");
    expect(after.hasPlayed.P1).toBe(true);
  });

  it("skips a player with no legal placement instead of ending the game", () => {
    let state = createInitialState();
    state = { ...state, remaining: { ...state.remaining, P2: [] } };
    // It's P1's move; after P1 plays, P2 (out of pieces) must be skipped,
    // landing back on P1 rather than ending the game (P1 still has pieces).
    const after = playAction(state, { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }] });
    expect(after.currentPlayer).toBe("P1");
    expect(after.winner).toBeNull();
  });

  it("ends the game the moment neither player has a legal placement", () => {
    const state = createInitialState();
    const stuck: GameState = { ...state, remaining: { P1: [], P2: [] } };
    const after = resolveTurn(stuck);
    expect(after.winner).toBe("DRAW");
    expect(after.scores).toEqual({ P1: 15, P2: 15 });
  });

  it("awards the all-placed bonus only to the side with zero remaining squares", () => {
    const state = createInitialState();
    // P1 occupies P2's own start square before P2 ever moves — P2 can never
    // place a first piece, so P2 is permanently stuck with "1" unplaced
    // while P1 has nothing left to place.
    const board = state.board.map((row) => [...row]);
    board[9][9] = "P1";
    const almostDone: GameState = {
      ...state,
      board,
      hasPlayed: { P1: true, P2: false },
      remaining: { P1: [], P2: ["1"] },
    };
    const after = resolveTurn(almostDone);
    expect(after.winner).toBe("P1");
    expect(after.scores).toEqual({ P1: 15, P2: -1 });
  });

  it("gives the extra bonus for finishing on the monomino, but only to the side that did", () => {
    const state = createInitialState();
    const bothDone: GameState = {
      ...state,
      remaining: { P1: [], P2: [] },
      moveHistory: [
        { kind: "PLACE", pieceId: "I4", cells: [{ row: 0, col: 0 }], turn: 0, player: "P1" },
        { kind: "PLACE", pieceId: "1", cells: [{ row: 4, col: 4 }], turn: 1, player: "P1" },
        { kind: "PLACE", pieceId: "I4", cells: [{ row: 9, col: 9 }], turn: 2, player: "P2" },
      ],
    };
    const after = resolveTurn(bothDone);
    expect(after.scores).toEqual({ P1: 20, P2: 15 });
    expect(after.winner).toBe("P1");
  });
});
