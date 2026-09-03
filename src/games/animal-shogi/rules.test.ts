import { describe, expect, it } from "vitest";
import {
  createInitialState,
  getAllLegalActions,
  getMovesFrom,
  hasAnyLegalAction,
  isLegalAction,
  isLegalDrop,
  playAction,
  resolveTurn,
} from "./rules";
import type { Board, Cell, GameState } from "./types";

/** Builds a state from a 4x3 grid of shorthand cells for tests: null for
 * empty, or `${owner}${typeLetter}` e.g. "Al" (A's Lion), "Bc" (B's Chick).
 * L=Lion G=Giraffe E=Elephant C=Chick H=Hen. */
function stateFrom(grid: (string | null)[][], currentPlayer: "A" | "B" = "A"): GameState {
  const LETTER_TO_TYPE = { l: "LION", g: "GIRAFFE", e: "ELEPHANT", c: "CHICK", h: "HEN" } as const;
  const board: Board = grid.map((row) =>
    row.map((cell): Cell => {
      if (!cell) return null;
      const owner = cell[0] as "A" | "B";
      const type = LETTER_TO_TYPE[cell[1].toLowerCase() as keyof typeof LETTER_TO_TYPE];
      return { type, owner };
    }),
  );
  return { board, hands: { A: [], B: [] }, currentPlayer, winner: null, winReason: null, moveHistory: [] };
}

describe("createInitialState", () => {
  it("places the standard, point-symmetric starting setup", () => {
    const state = createInitialState();
    expect(state.board[0][0]).toEqual({ type: "GIRAFFE", owner: "B" });
    expect(state.board[0][1]).toEqual({ type: "LION", owner: "B" });
    expect(state.board[0][2]).toEqual({ type: "ELEPHANT", owner: "B" });
    expect(state.board[1][1]).toEqual({ type: "CHICK", owner: "B" });
    expect(state.board[2][1]).toEqual({ type: "CHICK", owner: "A" });
    expect(state.board[3][0]).toEqual({ type: "ELEPHANT", owner: "A" });
    expect(state.board[3][1]).toEqual({ type: "LION", owner: "A" });
    expect(state.board[3][2]).toEqual({ type: "GIRAFFE", owner: "A" });
    expect(state.hands).toEqual({ A: [], B: [] });
    expect(state.currentPlayer).toBe("A");
  });
});

describe("piece movement", () => {
  it("Lion moves one square in all 8 directions", () => {
    const state = stateFrom([
      [null, null, null],
      [null, null, null],
      [null, "Al", null],
      [null, null, null],
    ]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves).toHaveLength(8);
  });

  it("Giraffe moves only orthogonally", () => {
    const state = stateFrom([
      [null, null, null],
      [null, null, null],
      [null, "Ag", null],
      [null, null, null],
    ]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves).toHaveLength(4);
    expect(moves.every((m) => m.row === 2 || m.col === 1)).toBe(true);
  });

  it("Elephant moves only diagonally", () => {
    const state = stateFrom([
      [null, null, null],
      [null, null, null],
      [null, "Ae", null],
      [null, null, null],
    ]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves).toHaveLength(4);
    expect(moves.every((m) => m.row !== 2 && m.col !== 1)).toBe(true);
  });

  it("A's Chick moves one square toward row 0; B's moves toward row 3", () => {
    const stateA = stateFrom([[null, null, null], [null, null, null], [null, "Ac", null], [null, null, null]]);
    expect(getMovesFrom(stateA, { row: 2, col: 1 })).toEqual([{ row: 1, col: 1 }]);

    const stateB = stateFrom([[null, null, null], [null, "Bc", null], [null, null, null], [null, null, null]]);
    expect(getMovesFrom(stateB, { row: 1, col: 1 })).toEqual([{ row: 2, col: 1 }]);
  });

  it("Hen moves like a gold general — not to either backward diagonal", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, "Ah", null], [null, null, null]]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves).toHaveLength(6);
    // A's backward diagonals are row+1 (behind), col-1/col+1.
    expect(moves.some((m) => m.row === 3 && m.col === 0)).toBe(false);
    expect(moves.some((m) => m.row === 3 && m.col === 2)).toBe(false);
    expect(moves.some((m) => m.row === 3 && m.col === 1)).toBe(true); // straight back is fine
  });

  it("cannot move onto a square occupied by your own piece", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, "Ag", "Ac"], [null, null, null]]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves.some((m) => m.row === 2 && m.col === 2)).toBe(false);
  });

  it("can move onto (capture) an enemy piece regardless of type", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, "Ag", "Bl"], [null, null, null]]);
    const moves = getMovesFrom(state, { row: 2, col: 1 });
    expect(moves.some((m) => m.row === 2 && m.col === 2)).toBe(true);
  });
});

describe("capture and hand", () => {
  it("adds a captured non-Lion piece to the capturer's hand, demoted if it was a Hen", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, "Ag", "Bh"], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 2, col: 1 }, to: { row: 2, col: 2 } });
    expect(after.hands.A).toEqual(["CHICK"]);
    expect(after.board[2][2]).toEqual({ type: "GIRAFFE", owner: "A" });
  });

  it("winning by capturing the enemy Lion does not add it to hand", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, "Ag", "Bl"], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 2, col: 1 }, to: { row: 2, col: 2 } });
    expect(after.winner).toBe("A");
    expect(after.winReason).toBe("CAPTURE");
    expect(after.hands.A).toEqual([]);
  });
});

describe("promotion", () => {
  it("promotes a Chick to a Hen on reaching the far row", () => {
    const state = stateFrom([[null, null, null], ["Ac", null, null], [null, null, null], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 1, col: 0 }, to: { row: 0, col: 0 } });
    expect(after.board[0][0]).toEqual({ type: "HEN", owner: "A" });
  });

  it("does not promote on any other row", () => {
    const state = stateFrom([[null, null, null], [null, null, null], ["Ac", null, null], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 2, col: 0 }, to: { row: 1, col: 0 } });
    expect(after.board[1][0]).toEqual({ type: "CHICK", owner: "A" });
  });
});

describe("try rule", () => {
  it("A wins by moving the Lion onto row 0", () => {
    const state = stateFrom([[null, null, null], ["Al", null, null], [null, null, null], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 1, col: 0 }, to: { row: 0, col: 0 } });
    expect(after.winner).toBe("A");
    expect(after.winReason).toBe("TRY");
  });

  it("B wins by moving the Lion onto row 3", () => {
    const state = stateFrom(
      [[null, null, null], [null, null, null], ["Bl", null, null], [null, null, null]],
      "B",
    );
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 2, col: 0 }, to: { row: 3, col: 0 } });
    expect(after.winner).toBe("B");
    expect(after.winReason).toBe("TRY");
  });

  it("a non-Lion piece reaching the far row never triggers a try win", () => {
    // B needs a piece with a legal move of its own, or the move would
    // instead (correctly) end the game on B having nothing to play at all.
    const state = stateFrom([[null, null, null], ["Ag", null, "Bl"], [null, null, null], [null, null, null]]);
    const { state: after } = playAction(state, { kind: "MOVE", from: { row: 1, col: 0 }, to: { row: 0, col: 0 } });
    expect(after.winner).toBeNull();
  });
});

describe("drops", () => {
  it("cannot drop on an occupied square", () => {
    const state = stateFrom([[null, null, null], [null, null, null], ["Ac", null, null], [null, null, null]]);
    expect(isLegalDrop(state, "GIRAFFE", { row: 2, col: 0 }, "A")).toBe(false);
  });

  it("cannot drop a Chick on the row where it would have no legal move", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, null, null], [null, null, null]]);
    expect(isLegalDrop(state, "CHICK", { row: 0, col: 0 }, "A")).toBe(false); // A's promotion row
    expect(isLegalDrop(state, "CHICK", { row: 3, col: 0 }, "A")).toBe(true);
    expect(isLegalDrop(state, "CHICK", { row: 3, col: 0 }, "B")).toBe(false); // B's promotion row
  });

  it("Giraffe and Elephant have no such restriction", () => {
    const state = stateFrom([[null, null, null], [null, null, null], [null, null, null], [null, null, null]]);
    expect(isLegalDrop(state, "GIRAFFE", { row: 0, col: 0 }, "A")).toBe(true);
    expect(isLegalDrop(state, "ELEPHANT", { row: 0, col: 0 }, "A")).toBe(true);
  });

  it("a legal drop places the piece and removes exactly one from hand", () => {
    const state: GameState = { ...createInitialState(), hands: { A: ["CHICK", "CHICK"], B: [] } };
    const { state: after } = playAction(state, { kind: "DROP", pieceType: "CHICK", to: { row: 2, col: 0 } });
    expect(after.board[2][0]).toEqual({ type: "CHICK", owner: "A" });
    expect(after.hands.A).toEqual(["CHICK"]);
  });
});

describe("no legal moves", () => {
  it("a side with no pieces on the board and nothing in hand loses immediately", () => {
    // Every piece belongs to B; A has been wiped out (not achievable via
    // ordinary capture rules here, but this exercises resolveTurn's
    // no-legal-moves loss directly rather than reproducing every capture
    // that could theoretically lead to it).
    const state = stateFrom(
      [
        ["Bg", "Bl", null],
        [null, null, null],
        [null, null, null],
        [null, null, null],
      ],
      "A",
    );
    expect(hasAnyLegalAction(state, "A")).toBe(false);
    const { state: after } = resolveTurn(state);
    expect(after.winner).toBe("B");
    expect(after.winReason).toBe("NO_MOVES");
  });
});

describe("isLegalAction", () => {
  it("rejects a move from a square the player doesn't own", () => {
    const state = stateFrom([[null, null, null], [null, null, null], ["Bg", null, null], [null, null, null]]);
    expect(isLegalAction(state, { kind: "MOVE", from: { row: 2, col: 0 }, to: { row: 1, col: 0 } }, "A")).toBe(false);
  });

  it("rejects dropping a piece type not in hand", () => {
    const state = createInitialState();
    expect(isLegalAction(state, { kind: "DROP", pieceType: "CHICK", to: { row: 2, col: 0 } }, "A")).toBe(false);
  });
});

describe("getAllLegalActions", () => {
  it("includes both board moves and drops", () => {
    const state: GameState = { ...createInitialState(), hands: { A: ["CHICK"], B: [] } };
    const actions = getAllLegalActions(state, "A");
    expect(actions.some((a) => a.kind === "MOVE")).toBe(true);
    expect(actions.some((a) => a.kind === "DROP")).toBe(true);
  });

  it("only offers one drop action per empty square per piece type in hand, not one per duplicate", () => {
    const state: GameState = { ...createInitialState(), hands: { A: ["CHICK", "CHICK"], B: [] } };
    const actions = getAllLegalActions(state, "A").filter((a) => a.kind === "DROP");
    // The initial setup's 4 empty squares are all off A's promotion row
    // (row 0 is fully occupied by B's back rank), so none are excluded.
    const emptySquares = state.board.flat().filter((c) => c === null).length;
    expect(actions).toHaveLength(emptySquares);
  });
});
