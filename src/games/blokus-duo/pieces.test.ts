import { describe, expect, it } from "vitest";
import { PIECE_IDS, PIECE_ORIENTATIONS, cellsKey, pieceSize } from "./pieces";

describe("pieces", () => {
  it("has exactly the 21 standard Blokus pieces", () => {
    expect(PIECE_IDS).toHaveLength(21);
    expect(new Set(PIECE_IDS).size).toBe(21);
  });

  it("sums to 89 squares per player, the standard Blokus total", () => {
    const total = PIECE_IDS.reduce((sum, id) => sum + pieceSize(id), 0);
    expect(total).toBe(89);
  });

  it("every generated orientation has the same cell count as the piece itself", () => {
    for (const id of PIECE_IDS) {
      for (const shape of PIECE_ORIENTATIONS[id]) {
        expect(shape).toHaveLength(pieceSize(id));
      }
    }
  });

  it("every orientation is normalized (min row and col are 0) with no duplicate cells", () => {
    for (const id of PIECE_IDS) {
      for (const shape of PIECE_ORIENTATIONS[id]) {
        expect(Math.min(...shape.map((c) => c.row))).toBe(0);
        expect(Math.min(...shape.map((c) => c.col))).toBe(0);
        expect(new Set(shape.map((c) => `${c.row},${c.col}`)).size).toBe(shape.length);
      }
    }
  });

  it("every orientation list is internally deduplicated", () => {
    for (const id of PIECE_IDS) {
      const keys = PIECE_ORIENTATIONS[id].map((shape) => cellsKey(shape));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("the fully symmetric pieces (monomino, square, plus) have exactly one orientation", () => {
    expect(PIECE_ORIENTATIONS["1"]).toHaveLength(1);
    expect(PIECE_ORIENTATIONS.O4).toHaveLength(1);
    expect(PIECE_ORIENTATIONS.X5).toHaveLength(1);
  });

  it("straight pieces (domino, I-trominoes/tetrominoes/pentominoes) have exactly two orientations", () => {
    expect(PIECE_ORIENTATIONS["2"]).toHaveLength(2);
    expect(PIECE_ORIENTATIONS.I3).toHaveLength(2);
    expect(PIECE_ORIENTATIONS.I4).toHaveLength(2);
    expect(PIECE_ORIENTATIONS.I5).toHaveLength(2);
  });

  it("a fully asymmetric piece (F pentomino) has all eight orientations", () => {
    expect(PIECE_ORIENTATIONS.F5).toHaveLength(8);
  });
});
