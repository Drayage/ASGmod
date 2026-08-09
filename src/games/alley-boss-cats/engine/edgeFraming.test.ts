import { describe, expect, it } from "vitest";
import { edgeFramingPoints, orderedCandidates, setEdgeFramingEnabled } from "./moveOrdering";
import { createInitialState } from "../rules";
import { playerCell } from "../types";
import type { GameState, Player } from "../types";

/**
 * `edgeFramingPoints` exists to put a move in front of the search that the move
 * ordering never would. These pin the three properties that makes it safe to
 * add candidates at an inner node: it only ever offers legal empty points, it
 * stays on the first two lines, and it refuses points an enemy stone already
 * touches — a contact fight is what the ordering is good at, and the slot is
 * not there to duplicate it.
 */
function withStones(stones: Array<[number, number, Player]>): GameState {
  const state = createInitialState();
  const board = state.board.map((r) => [...r]);
  for (const [row, col, side] of stones) board[row][col] = playerCell(side);
  return { ...state, board, currentPlayer: "A" };
}

const keys = (state: GameState, player: Player) =>
  edgeFramingPoints(state, player, 8)
    .map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS"))
    .sort();

describe("edgeFramingPoints", () => {
  it("extends along the edge from a stone on the first line", () => {
    const state = withStones([[0, 2, "A"]]);
    const found = keys(state, "A");
    expect(found).toContain("0,3");
    expect(found).toContain("0,5"); // three steps, the far end of the range
    expect(found).not.toContain("0,6"); // four is past MAX_EDGE_STEP
  });

  it("stops at the first occupied cell rather than jumping over it", () => {
    const state = withStones([
      [0, 2, "A"],
      [0, 4, "B"],
    ]);
    const found = keys(state, "A");
    expect(found).not.toContain("0,5"); // the walk ends at the stone on 0,4
    expect(found).toContain("0,1"); // the other direction is still open
  });

  it("skips points an enemy stone already touches", () => {
    // 0,3 is adjacent to the enemy at 0,4, so it is a contact move, not a frame.
    const state = withStones([
      [0, 2, "A"],
      [0, 4, "B"],
      [1, 3, "B"],
    ]);
    expect(keys(state, "A")).not.toContain("0,3");
  });

  it("does not wander inward off the second line", () => {
    const state = withStones([[1, 1, "A"]]);
    for (const key of keys(state, "A")) {
      const [row, col] = key.split(",").map(Number);
      expect(Math.min(row, col, 8 - row, 8 - col)).toBeLessThanOrEqual(1);
    }
  });

  it("offers nothing from a stone in the centre", () => {
    expect(keys(withStones([[4, 3, "A"]]), "A")).toEqual([]);
  });

  it("adds to the candidate list rather than displacing it", () => {
    const state = withStones([
      [0, 2, "A"],
      [3, 3, "A"],
      [3, 5, "B"],
    ]);
    const base = orderedCandidates(state, "A", 14, undefined, false);
    setEdgeFramingEnabled(true);
    const framed = orderedCandidates(state, "A", 14, undefined, true);
    setEdgeFramingEnabled(false);

    const asKeys = (list: ReturnType<typeof orderedCandidates>) =>
      list.map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS"));
    // Every move the ordering already chose survives; the slot only appends.
    expect(asKeys(framed)).toEqual(expect.arrayContaining(asKeys(base)));
    expect(framed.length).toBeGreaterThanOrEqual(base.length);
  });

  it("is inert while the switch is off, even when asked for", () => {
    setEdgeFramingEnabled(false);
    const state = withStones([[0, 2, "A"]]);
    const base = orderedCandidates(state, "A", 14, undefined, false);
    expect(orderedCandidates(state, "A", 14, undefined, true)).toEqual(base);
  });
});
