/** The 21 standard Blokus piece shapes (1 monomino, 1 domino, 2 trominoes,
 * 5 tetrominoes, 12 pentominoes) — one fixed base orientation per piece,
 * with every rotation/reflection generated and deduped at module load. */
import type { Coord } from "./types";

export type PieceId =
  | "1" | "2"
  | "I3" | "L3"
  | "I4" | "O4" | "L4" | "S4" | "T4"
  | "F5" | "I5" | "L5" | "N5" | "P5" | "T5" | "U5" | "V5" | "W5" | "X5" | "Y5" | "Z5";

export const PIECE_IDS: PieceId[] = [
  "1", "2",
  "I3", "L3",
  "I4", "O4", "L4", "S4", "T4",
  "F5", "I5", "L5", "N5", "P5", "T5", "U5", "V5", "W5", "X5", "Y5", "Z5",
];

function shape(...coords: Array<[number, number]>): Coord[] {
  return coords.map(([row, col]) => ({ row, col }));
}

const BASE_SHAPES: Record<PieceId, Coord[]> = {
  "1": shape([0, 0]),
  "2": shape([0, 0], [0, 1]),
  I3: shape([0, 0], [0, 1], [0, 2]),
  L3: shape([0, 0], [1, 0], [1, 1]),
  I4: shape([0, 0], [0, 1], [0, 2], [0, 3]),
  O4: shape([0, 0], [0, 1], [1, 0], [1, 1]),
  L4: shape([0, 0], [1, 0], [2, 0], [2, 1]),
  S4: shape([0, 1], [0, 2], [1, 0], [1, 1]),
  T4: shape([0, 0], [0, 1], [0, 2], [1, 1]),
  F5: shape([0, 1], [0, 2], [1, 0], [1, 1], [2, 1]),
  I5: shape([0, 0], [0, 1], [0, 2], [0, 3], [0, 4]),
  L5: shape([0, 0], [1, 0], [2, 0], [3, 0], [3, 1]),
  N5: shape([0, 1], [1, 1], [2, 0], [2, 1], [3, 0]),
  P5: shape([0, 0], [0, 1], [1, 0], [1, 1], [2, 0]),
  T5: shape([0, 0], [0, 1], [0, 2], [1, 1], [2, 1]),
  U5: shape([0, 0], [0, 2], [1, 0], [1, 1], [1, 2]),
  V5: shape([0, 0], [1, 0], [2, 0], [2, 1], [2, 2]),
  W5: shape([0, 0], [1, 0], [1, 1], [2, 1], [2, 2]),
  X5: shape([0, 1], [1, 0], [1, 1], [1, 2], [2, 1]),
  Y5: shape([0, 1], [1, 0], [1, 1], [2, 1], [3, 1]),
  Z5: shape([0, 0], [0, 1], [1, 1], [2, 1], [2, 2]),
};

function normalize(cells: Coord[]): Coord[] {
  const minRow = Math.min(...cells.map((c) => c.row));
  const minCol = Math.min(...cells.map((c) => c.col));
  return cells
    .map((c) => ({ row: c.row - minRow, col: c.col - minCol }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

function rotate90(cells: Coord[]): Coord[] {
  return normalize(cells.map(({ row, col }) => ({ row: col, col: -row })));
}

function mirror(cells: Coord[]): Coord[] {
  return normalize(cells.map(({ row, col }) => ({ row, col: -col })));
}

export function cellsKey(cells: Coord[]): string {
  return cells.map((c) => `${c.row},${c.col}`).join(";");
}

function computeOrientations(base: Coord[]): Coord[][] {
  const seen = new Map<string, Coord[]>();
  let sideCells = normalize(base);
  for (let side = 0; side < 2; side++) {
    let rotated = sideCells;
    for (let turn = 0; turn < 4; turn++) {
      const key = cellsKey(rotated);
      if (!seen.has(key)) seen.set(key, rotated);
      rotated = rotate90(rotated);
    }
    sideCells = mirror(sideCells);
  }
  return [...seen.values()];
}

export const PIECE_ORIENTATIONS: Record<PieceId, Coord[][]> = Object.fromEntries(
  PIECE_IDS.map((id) => [id, computeOrientations(BASE_SHAPES[id])]),
) as Record<PieceId, Coord[][]>;

export const PIECE_ORIENTATION_KEYS: Record<PieceId, Set<string>> = Object.fromEntries(
  PIECE_IDS.map((id) => [id, new Set(PIECE_ORIENTATIONS[id].map((cells) => cellsKey(cells)))]),
) as Record<PieceId, Set<string>>;

export function pieceSize(id: PieceId): number {
  return BASE_SHAPES[id].length;
}

export function shapeBounds(cells: Coord[]): { height: number; width: number } {
  const maxRow = Math.max(...cells.map((c) => c.row));
  const maxCol = Math.max(...cells.map((c) => c.col));
  return { height: maxRow + 1, width: maxCol + 1 };
}
