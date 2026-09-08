import { describe, expect, it } from "vitest";
import {
  countFlats,
  createInitialState,
  getAllLegalActions,
  getLegalMovesFrom,
  getLegalPlacements,
  hasRoad,
  isLegalMove,
  isLegalPlace,
  placingOwner,
  playAction,
  resolveTurn,
} from "./rules";
import { BOARD_SIZE, STARTING_CAPS, STARTING_FLATS } from "./types";
import type { Coord, GameState, Stack } from "./types";

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => [] as Stack));
}

/** A state with the first-move rule already satisfied for both sides, so
 * tests can place/move normally without tripping the opening exception. */
function midGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    ...createInitialState(),
    hasPlayedFirstMove: { P1: true, P2: true },
    ...overrides,
  };
}

describe("createInitialState", () => {
  it("starts with an empty 5x5 board and standard reserves", () => {
    const state = createInitialState();
    expect(state.board).toHaveLength(BOARD_SIZE);
    expect(state.board.every((row) => row.every((stack) => stack.length === 0))).toBe(true);
    expect(state.reserves.P1).toEqual({ flats: STARTING_FLATS, caps: STARTING_CAPS });
    expect(state.reserves.P2).toEqual({ flats: STARTING_FLATS, caps: STARTING_CAPS });
    expect(state.currentPlayer).toBe("P1");
    expect(state.hasPlayedFirstMove).toEqual({ P1: false, P2: false });
  });
});

describe("first-move rule", () => {
  it("only allows a FLAT placement, and it draws from the opponent's reserve", () => {
    const state = createInitialState();
    const to: Coord = { row: 2, col: 2 };
    expect(isLegalPlace(state, to, "FLAT")).toBe(true);
    expect(isLegalPlace(state, to, "STANDING")).toBe(false);
    expect(isLegalPlace(state, to, "CAP")).toBe(false);
    expect(placingOwner(state)).toBe("P2");

    const after = playAction(state, { kind: "PLACE", to, stoneKind: "FLAT" });
    expect(after.board[2][2]).toEqual([{ owner: "P2", kind: "FLAT" }]);
    expect(after.reserves.P2.flats).toBe(STARTING_FLATS - 1);
    expect(after.reserves.P1.flats).toBe(STARTING_FLATS);
    expect(after.currentPlayer).toBe("P2");
    expect(after.hasPlayedFirstMove.P1).toBe(true);
  });

  it("does the same in reverse for P2's own first move, and no moves are legal before it", () => {
    let state = createInitialState();
    state = playAction(state, { kind: "PLACE", to: { row: 0, col: 0 }, stoneKind: "FLAT" });
    expect(placingOwner(state)).toBe("P1");
    expect(getLegalMovesFrom(state, { row: 0, col: 0 })).toEqual([]);

    const after = playAction(state, { kind: "PLACE", to: { row: 4, col: 4 }, stoneKind: "FLAT" });
    expect(after.board[4][4]).toEqual([{ owner: "P1", kind: "FLAT" }]);
    expect(after.reserves.P1.flats).toBe(STARTING_FLATS - 1);
    expect(after.hasPlayedFirstMove).toEqual({ P1: true, P2: true });
  });
});

describe("placement after the opening", () => {
  it("allows all three kinds using the mover's own reserve", () => {
    const state = midGameState();
    for (const kind of ["FLAT", "STANDING", "CAP"] as const) {
      expect(isLegalPlace(state, { row: 1, col: 1 }, kind)).toBe(true);
    }
    const after = playAction(state, { kind: "PLACE", to: { row: 1, col: 1 }, stoneKind: "CAP" });
    expect(after.board[1][1]).toEqual([{ owner: "P1", kind: "CAP" }]);
    expect(after.reserves.P1.caps).toBe(0);
  });

  it("rejects placing onto an occupied square or without reserves", () => {
    const board = emptyBoard();
    board[1][1] = [{ owner: "P1", kind: "FLAT" }];
    const state = midGameState({ board, reserves: { P1: { flats: 0, caps: 0 }, P2: { flats: STARTING_FLATS, caps: STARTING_CAPS } } });
    expect(isLegalPlace(state, { row: 1, col: 1 }, "FLAT")).toBe(false);
    expect(isLegalPlace(state, { row: 2, col: 2 }, "FLAT")).toBe(false);
    expect(isLegalPlace(state, { row: 2, col: 2 }, "CAP")).toBe(false);
  });
});

describe("movement", () => {
  it("enumerates every carry/drop combination in all four directions from the center", () => {
    const board = emptyBoard();
    board[2][2] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
    ];
    const state = midGameState({ board });
    const actions = getLegalMovesFrom(state, { row: 2, col: 2 });
    // 4 directions x (carry=1: one composition [1], carry=2: two compositions [2] and [1,1])
    expect(actions).toHaveLength(12);
  });

  it("only the top stone's owner may move a stack", () => {
    const board = emptyBoard();
    board[2][2] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P2", kind: "FLAT" },
    ];
    const state = midGameState({ board, currentPlayer: "P1" });
    expect(getLegalMovesFrom(state, { row: 2, col: 2 })).toEqual([]);
  });

  it("caps the carry at the board size even for a taller stack", () => {
    const board = emptyBoard();
    board[2][2] = Array.from({ length: BOARD_SIZE + 3 }, () => ({ owner: "P1" as const, kind: "FLAT" as const }));
    const state = midGameState({ board });
    const actions = getLegalMovesFrom(state, { row: 2, col: 2 });
    const maxCarryUsed = Math.max(...actions.map((a) => (a.kind === "MOVE" ? a.drops.reduce((s, n) => s + n, 0) : 0)));
    expect(maxCarryUsed).toBe(BOARD_SIZE);
  });

  it("blocks landing directly on a standing stone or capstone", () => {
    const board = emptyBoard();
    board[2][1] = [{ owner: "P1", kind: "FLAT" }];
    board[2][2] = [{ owner: "P2", kind: "STANDING" }];
    const state = midGameState({ board });
    expect(isLegalMove(state, { row: 2, col: 1 }, "RIGHT", [1])).toBe(false);

    const capBoard = emptyBoard();
    capBoard[2][1] = [{ owner: "P1", kind: "FLAT" }];
    capBoard[2][2] = [{ owner: "P2", kind: "CAP" }];
    const capState = midGameState({ board: capBoard });
    expect(isLegalMove(capState, { row: 2, col: 1 }, "RIGHT", [1])).toBe(false);
  });

  it("blocks passing over a blocked square to reach one further along", () => {
    const board = emptyBoard();
    board[2][0] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
    ];
    board[2][1] = [{ owner: "P2", kind: "STANDING" }];
    const state = midGameState({ board });
    // (2,1) is blocked and isn't even the final square of this move.
    expect(isLegalMove(state, { row: 2, col: 0 }, "RIGHT", [1, 1])).toBe(false);
  });

  it("lets a lone capstone flatten a standing stone, but not a standing stone underneath other carried pieces", () => {
    const board = emptyBoard();
    board[2][1] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "CAP" },
    ];
    board[2][2] = [{ owner: "P2", kind: "STANDING" }];
    const state = midGameState({ board });

    expect(isLegalMove(state, { row: 2, col: 1 }, "RIGHT", [1])).toBe(true);
    const after = playAction(state, { kind: "MOVE", from: { row: 2, col: 1 }, direction: "RIGHT", drops: [1] });
    expect(after.board[2][2]).toEqual([
      { owner: "P2", kind: "FLAT" },
      { owner: "P1", kind: "CAP" },
    ]);
    expect(after.board[2][1]).toEqual([{ owner: "P1", kind: "FLAT" }]);

    // Landing 3 stones together (cap included, not alone) directly on an
    // adjacent wall can't flatten it...
    const adjacentBoard = emptyBoard();
    adjacentBoard[2][0] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "CAP" },
    ];
    adjacentBoard[2][1] = [{ owner: "P2", kind: "STANDING" }];
    const adjacentState = midGameState({ board: adjacentBoard });
    expect(isLegalMove(adjacentState, { row: 2, col: 0 }, "RIGHT", [3])).toBe(false);

    // ...but dropping 2 along the way toward a farther wall and arriving
    // with just the lone cap still can.
    const farBoard = emptyBoard();
    farBoard[2][0] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "CAP" },
    ];
    farBoard[2][2] = [{ owner: "P2", kind: "STANDING" }];
    const farState = midGameState({ board: farBoard });
    expect(isLegalMove(farState, { row: 2, col: 0 }, "RIGHT", [2, 1])).toBe(true);
  });

  it("preserves stacking order so the original top stone always ends up on top", () => {
    const board = emptyBoard();
    board[2][0] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P2", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
    ];
    const state = midGameState({ board });
    const after = playAction(state, { kind: "MOVE", from: { row: 2, col: 0 }, direction: "RIGHT", drops: [1, 2] });
    // Carrying all 3: square (2,1) gets the bottom-most of the carried group (P1),
    // square (2,2) gets the remaining two (P2 then P1 on top).
    expect(after.board[2][0]).toEqual([]);
    expect(after.board[2][1]).toEqual([{ owner: "P1", kind: "FLAT" }]);
    expect(after.board[2][2]).toEqual([
      { owner: "P2", kind: "FLAT" },
      { owner: "P1", kind: "FLAT" },
    ]);
  });
});

describe("hasRoad", () => {
  it("detects a completed horizontal or vertical road of flats/capstones", () => {
    const board = emptyBoard();
    for (let col = 0; col < BOARD_SIZE; col++) board[2][col] = [{ owner: "P1", kind: "FLAT" }];
    const state = midGameState({ board });
    expect(hasRoad(state, "P1")).toBe(true);
    expect(hasRoad(state, "P2")).toBe(false);
  });

  it("does not count standing stones toward a road, even the owner's own", () => {
    const board = emptyBoard();
    for (let col = 0; col < BOARD_SIZE; col++) board[2][col] = [{ owner: "P1", kind: "FLAT" }];
    board[2][2] = [{ owner: "P1", kind: "STANDING" }];
    const state = midGameState({ board });
    expect(hasRoad(state, "P1")).toBe(false);
  });

  it("a capstone counts toward a road just like a flat", () => {
    const board = emptyBoard();
    for (let col = 0; col < BOARD_SIZE; col++) board[2][col] = [{ owner: "P1", kind: "FLAT" }];
    board[2][2] = [{ owner: "P1", kind: "CAP" }];
    const state = midGameState({ board });
    expect(hasRoad(state, "P1")).toBe(true);
  });
});

describe("countFlats / flat-count ending", () => {
  it("counts only each player's exposed flat/cap tops", () => {
    const board = emptyBoard();
    board[0][0] = [{ owner: "P1", kind: "FLAT" }];
    board[0][1] = [{ owner: "P1", kind: "STANDING" }];
    board[0][2] = [{ owner: "P1", kind: "CAP" }];
    board[0][3] = [{ owner: "P2", kind: "FLAT" }];
    const state = midGameState({ board });
    expect(countFlats(state, "P1")).toBe(2);
    expect(countFlats(state, "P2")).toBe(1);
  });

  it("ends the game by flat count once a mover's reserves hit zero", () => {
    const board = emptyBoard();
    board[0][0] = [{ owner: "P1", kind: "FLAT" }];
    board[0][1] = [{ owner: "P1", kind: "FLAT" }];
    board[0][2] = [{ owner: "P2", kind: "FLAT" }];
    const state = midGameState({
      board,
      reserves: { P1: { flats: 0, caps: 0 }, P2: { flats: STARTING_FLATS, caps: STARTING_CAPS } },
    });
    const after = resolveTurn(state, "P1");
    expect(after.winner).toBe("P1");
    expect(after.winReason).toBe("FLATS");
  });

  it("draws when both sides end with equal flat counts", () => {
    const board = emptyBoard();
    board[0][0] = [{ owner: "P1", kind: "FLAT" }];
    board[0][1] = [{ owner: "P2", kind: "FLAT" }];
    const state = midGameState({
      board,
      reserves: { P1: { flats: 0, caps: 0 }, P2: { flats: STARTING_FLATS, caps: STARTING_CAPS } },
    });
    const after = resolveTurn(state, "P1");
    expect(after.winner).toBe("DRAW");
  });
});

describe("playAction integration", () => {
  it("declares an immediate road win the instant a placement completes one", () => {
    const board = emptyBoard();
    for (let col = 0; col < BOARD_SIZE - 1; col++) board[3][col] = [{ owner: "P1", kind: "FLAT" }];
    const state = midGameState({ board, currentPlayer: "P1" });
    const after = playAction(state, { kind: "PLACE", to: { row: 3, col: BOARD_SIZE - 1 }, stoneKind: "FLAT" });
    expect(after.winner).toBe("P1");
    expect(after.winReason).toBe("ROAD");
  });

  it("getAllLegalActions never proposes an action rejected by isLegalMove/isLegalPlace", () => {
    const board = emptyBoard();
    board[2][2] = [
      { owner: "P1", kind: "FLAT" },
      { owner: "P1", kind: "CAP" },
    ];
    board[1][2] = [{ owner: "P2", kind: "STANDING" }];
    const state = midGameState({ board });
    const actions = getAllLegalActions(state);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      if (action.kind === "PLACE") expect(isLegalPlace(state, action.to, action.stoneKind)).toBe(true);
      else expect(isLegalMove(state, action.from, action.direction, action.drops)).toBe(true);
    }
    // Sanity: getLegalPlacements is exactly the PLACE subset of getAllLegalActions.
    expect(getLegalPlacements(state)).toEqual(actions.filter((a) => a.kind === "PLACE"));
  });
});
