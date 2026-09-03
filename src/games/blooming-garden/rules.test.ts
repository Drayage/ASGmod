import { describe, expect, it } from "vitest";
import { boardFromMap, maps } from "./maps";
import {
  countFlowers,
  createInitialState,
  getAllLegalMoves,
  getLegalMovesFrom,
  hasAnyLegalMove,
  isLegalAction,
  playMove,
  resolveTurn,
} from "./rules";
import type { GameState } from "./types";

function stateFromRows(rows: string[], currentPlayer: "A" | "B" = "A"): GameState {
  const board = boardFromMap({ id: "test", name: "test", description: "", rows });
  return { board, currentPlayer, winner: null, moveHistory: [], mapId: "test" };
}

describe("createInitialState", () => {
  it("places two flowers per player on opposite corners", () => {
    const state = createInitialState("practice-garden");
    expect(state.board[0][0]).toBe("PLAYER_A");
    expect(state.board[6][6]).toBe("PLAYER_A");
    expect(state.board[0][6]).toBe("PLAYER_B");
    expect(state.board[6][0]).toBe("PLAYER_B");
    expect(countFlowers(state)).toEqual({ A: 2, B: 2 });
    expect(state.currentPlayer).toBe("A");
  });

  it("falls back to the first map on an unknown id", () => {
    const state = createInitialState("does-not-exist");
    expect(state.mapId).toBe("practice-garden");
  });
});

describe("getLegalMovesFrom", () => {
  it("offers clones at distance 1 and jumps at distance 2", () => {
    const state = stateFromRows([".......", ".......", ".......", "...P...", ".......", ".......", "......."]);
    const moves = getLegalMovesFrom(state, 3, 3);
    const clones = moves.filter((m) => m.type === "CLONE");
    const jumps = moves.filter((m) => m.type === "JUMP");
    expect(clones).toHaveLength(8);
    expect(jumps).toHaveLength(16);
  });

  it("never targets an occupied or obstacle cell", () => {
    const state = stateFromRows([".......", ".......", "..#Q...", "...P...", ".......", ".......", "......."]);
    const moves = getLegalMovesFrom(state, 3, 3);
    expect(moves.some((m) => m.row === 2 && m.col === 2)).toBe(false); // obstacle
    expect(moves.some((m) => m.row === 2 && m.col === 3)).toBe(false); // occupied by Q
  });

  it("stays inside the board from a corner", () => {
    const state = stateFromRows(["P......", ".......", ".......", ".......", ".......", ".......", "......."]);
    const moves = getLegalMovesFrom(state, 0, 0);
    expect(moves.every((m) => m.row >= 0 && m.col >= 0)).toBe(true);
    // 3 clone targets + 5 jump targets fit on the board from a corner.
    expect(moves).toHaveLength(8);
  });
});

describe("playMove — clone", () => {
  it("adds a flower without removing the source", () => {
    const state = stateFromRows([".......", ".......", ".......", "...P...", ".......", ".......", "......."]);
    const { state: after } = playMove(state, { type: "CLONE", row: 3, col: 4 });
    expect(after.board[3][3]).toBe("PLAYER_A");
    expect(after.board[3][4]).toBe("PLAYER_A");
    expect(countFlowers(after).A).toBe(2);
  });
});

describe("playMove — jump", () => {
  it("relocates the flower, emptying the origin", () => {
    const state = stateFromRows([".......", ".......", ".......", "...P...", ".......", ".......", "......."]);
    const { state: after } = playMove(state, { type: "JUMP", fromRow: 3, fromCol: 3, row: 3, col: 5 });
    expect(after.board[3][3]).toBe("EMPTY");
    expect(after.board[3][5]).toBe("PLAYER_A");
    expect(countFlowers(after).A).toBe(1);
  });
});

describe("playMove — conversion", () => {
  it("converts every adjacent enemy flower around the landing cell", () => {
    const state = stateFromRows(["QQ.....", "Q......", ".......", "...P...", ".......", ".......", "......."]);
    const { state: after } = playMove(state, { type: "CLONE", row: 1, col: 1 });
    expect(after.board[0][0]).toBe("PLAYER_A");
    expect(after.board[0][1]).toBe("PLAYER_A");
    expect(after.board[1][0]).toBe("PLAYER_A");
    // Pre-existing P at (3,3), the new one at (1,1), plus the three converted.
    expect(countFlowers(after)).toEqual({ A: 5, B: 0 });
  });

  it("does not convert flowers beyond the landing cell's 8 neighbours", () => {
    const state = stateFromRows([".......", ".Q.....", "..P....", ".......", ".......", ".......", "......."]);
    const { state: after } = playMove(state, { type: "CLONE", row: 2, col: 4 });
    expect(after.board[1][1]).toBe("PLAYER_B"); // out of range of the new cell
  });
});

describe("turn skipping", () => {
  it("auto-skips a player with no legal move instead of asking them to pass", () => {
    // B's only flower sits in the corner with every cell in its reach (clone
    // and jump range both) occupied by A, so B has no legal move; A has moves.
    const state = stateFromRows(
      ["QPP....", "PPP....", "PPP....", ".......", ".......", ".......", "......."],
      "A",
    );
    expect(hasAnyLegalMove(state, "B")).toBe(false);
    const { state: after, skippedPlayers } = playMove(state, { type: "CLONE", row: 0, col: 3 });
    expect(skippedPlayers).toEqual(["B"]);
    expect(after.currentPlayer).toBe("A");
  });

  it("ends the game when neither player has a legal move", () => {
    const rows = [
      "PQPQPQP",
      "QPQPQPQ",
      "PQPQPQP",
      "QPQPQPQ",
      "PQPQPQP",
      "QPQPQPQ",
      "PQPQPQP",
    ];
    const state = stateFromRows(rows, "A");
    const resolution = resolveTurn(state);
    expect(resolution.state.winner).not.toBeNull();
  });
});

describe("game end / winner", () => {
  it("declares the player with more flowers the winner once nobody can move", () => {
    const rows = [
      "PQPQPQP",
      "QPQPQPQ",
      "PQPQPQP",
      "QPQPQPQ",
      "PQPQPQP",
      "QPQPQPQ",
      "PPPQPQP", // one extra P over Q
    ];
    const state = stateFromRows(rows, "A");
    const resolution = resolveTurn(state);
    expect(resolution.state.winner).toBe("A");
  });

  it("declares a draw when flower counts are equal", () => {
    // A wall down the middle column splits the board into two equal, fully
    // occupied halves — 21 flowers each, no empty cell for anyone to reach.
    const rows = Array<string>(7).fill("PPP#QQQ");
    const state = stateFromRows(rows, "A");
    const resolution = resolveTurn(state);
    expect(resolution.state.winner).toBe("DRAW");
  });
});

describe("isLegalAction", () => {
  it("accepts a legal clone and rejects a distance-3 target", () => {
    const state = stateFromRows([".......", ".......", ".......", "...P...", ".......", ".......", "......."]);
    expect(isLegalAction(state, { type: "CLONE", row: 3, col: 4 }, "A")).toBe(true);
    expect(isLegalAction(state, { type: "JUMP", fromRow: 3, fromCol: 3, row: 3, col: 6 }, "A")).toBe(false);
  });

  it("rejects a jump whose origin is not the player's own flower", () => {
    const state = stateFromRows([".......", ".......", ".......", "...P.Q.", ".......", ".......", "......."]);
    expect(isLegalAction(state, { type: "JUMP", fromRow: 3, fromCol: 5, row: 3, col: 3 }, "A")).toBe(false);
  });
});

describe("getAllLegalMoves", () => {
  it("aggregates moves from every flower the player owns", () => {
    const state = stateFromRows([".......", ".......", ".......", "P.....P", ".......", ".......", "......."]);
    const moves = getAllLegalMoves(state, "A");
    expect(moves.length).toBeGreaterThan(getLegalMovesFrom(state, 3, 0).length);
  });
});

describe("map roster", () => {
  it.each(maps.map((m) => [m.id, m] as const))("%s starts with a legal move for both players", (_id, map) => {
    const state = createInitialState(map.id);
    expect(map.rows).toHaveLength(state.board.length);
    for (const row of map.rows) expect(row).toHaveLength(state.board.length);
    expect(hasAnyLegalMove(state, "A")).toBe(true);
    expect(hasAnyLegalMove(state, "B")).toBe(true);
  });

  it("keeps every map's starting flowers on symmetric opposite corners", () => {
    for (const map of maps) {
      const state = createInitialState(map.id);
      const size = state.board.length;
      expect(state.board[0][0]).toBe("PLAYER_A");
      expect(state.board[size - 1][size - 1]).toBe("PLAYER_A");
      expect(state.board[0][size - 1]).toBe("PLAYER_B");
      expect(state.board[size - 1][0]).toBe("PLAYER_B");
    }
  });

  it("has at least the 10 maps the design calls for", () => {
    expect(maps.length).toBeGreaterThanOrEqual(10);
    expect(new Set(maps.map((m) => m.id)).size).toBe(maps.length);
  });
});
