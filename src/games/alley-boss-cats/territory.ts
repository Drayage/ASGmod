import { BOARD_SIZE, DIRECTIONS, inBounds } from "./types";
import type { Board, Coord, Player } from "./types";

type Edge = "top" | "bottom" | "left" | "right";

function edgesOf(row: number, col: number): Edge[] {
  const edges: Edge[] = [];
  if (row === 0) edges.push("top");
  if (row === BOARD_SIZE - 1) edges.push("bottom");
  if (col === 0) edges.push("left");
  if (col === BOARD_SIZE - 1) edges.push("right");
  return edges;
}

interface EmptyRegion {
  cells: Coord[];
  borderingPlayers: Set<Player>;
  touchesNeutral: boolean;
  touchedEdges: Set<Edge>;
}

function floodFillEmptyRegions(board: Board): EmptyRegion[] {
  const visited = new Set<string>();
  const regions: EmptyRegion[] = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== "EMPTY") continue;
      const key = `${row},${col}`;
      if (visited.has(key)) continue;

      const region: EmptyRegion = {
        cells: [],
        borderingPlayers: new Set(),
        touchesNeutral: false,
        touchedEdges: new Set(),
      };
      const queue: Coord[] = [{ row, col }];
      visited.add(key);

      while (queue.length > 0) {
        const cell = queue.shift()!;
        region.cells.push(cell);
        for (const edge of edgesOf(cell.row, cell.col)) region.touchedEdges.add(edge);

        for (const [dr, dc] of DIRECTIONS) {
          const r = cell.row + dr;
          const c = cell.col + dc;
          if (!inBounds(r, c)) continue;
          const value = board[r][c];
          if (value === "PLAYER_A") region.borderingPlayers.add("A");
          else if (value === "PLAYER_B") region.borderingPlayers.add("B");
          else if (value === "NEUTRAL") region.touchesNeutral = true;
          else {
            const k = `${r},${c}`;
            if (!visited.has(k)) {
              visited.add(k);
              queue.push({ row: r, col: c });
            }
          }
        }
      }

      regions.push(region);
    }
  }

  return regions;
}

/** A region only counts as a confirmed territory when exactly one player
 * borders it and it isn't the board's wide-open outer space (which would
 * otherwise register as "owned" by whichever single color happens to have
 * placed a cat, early in the game). */
export function isValidTerritoryRegion(region: EmptyRegion): Player | null {
  if (region.borderingPlayers.size !== 1) return null;
  if (region.touchedEdges.size >= 4) return null;
  const [owner] = region.borderingPlayers;
  return owner;
}

export function calculateTerritories(board: Board): Record<Player, Coord[]> {
  const territories: Record<Player, Coord[]> = { A: [], B: [] };
  for (const region of floodFillEmptyRegions(board)) {
    const owner = isValidTerritoryRegion(region);
    if (owner) territories[owner].push(...region.cells);
  }
  return territories;
}

/** One empty region, grown from a single starting cell. `visited` is shared
 * across calls so two starting cells in the same region are only walked
 * once. */
function floodRegionFrom(
  board: Board,
  startRow: number,
  startCol: number,
  visited: Set<string>,
): EmptyRegion {
  const region: EmptyRegion = {
    cells: [],
    borderingPlayers: new Set(),
    touchesNeutral: false,
    touchedEdges: new Set(),
  };
  const queue: Coord[] = [{ row: startRow, col: startCol }];
  visited.add(`${startRow},${startCol}`);

  while (queue.length > 0) {
    const cell = queue.shift()!;
    region.cells.push(cell);
    for (const edge of edgesOf(cell.row, cell.col)) region.touchedEdges.add(edge);

    for (const [dr, dc] of DIRECTIONS) {
      const r = cell.row + dr;
      const c = cell.col + dc;
      if (!inBounds(r, c)) continue;
      const value = board[r][c];
      if (value === "PLAYER_A") region.borderingPlayers.add("A");
      else if (value === "PLAYER_B") region.borderingPlayers.add("B");
      else if (value === "NEUTRAL") region.touchesNeutral = true;
      else {
        const k = `${r},${c}`;
        if (!visited.has(k)) {
          visited.add(k);
          queue.push({ row: r, col: c });
        }
      }
    }
  }

  return region;
}

/**
 * The territories of `board` — which is a position whose territories were
 * `before`, with one cat just placed at (row, col) — without re-deriving the
 * whole board.
 *
 * Two properties of the rules make this exact rather than approximate:
 *
 *  - **Settled territory never comes undone.** Nobody may play inside it, and
 *    a cat is never removed from the board, so neither its cells nor the wall
 *    around them can change. Whatever was territory before still is.
 *  - **Placing a cat can only shrink or split an empty region, never merge
 *    two.** So the only regions whose border changed are the ones that
 *    contained the cell just filled — precisely those still reachable from
 *    that cell's empty neighbours.
 *
 * Everything else on the board kept both its cells and its wall, so its
 * verdict is the one it already had. That is what the full scan spends its
 * time recomputing: measured at 16.6µs of a per-node cost the search pays at
 * every leaf, most of it on regions the move could not have touched.
 */
export function territoriesAfterPlacement(
  board: Board,
  row: number,
  col: number,
  before: Record<Player, Coord[]>,
): Record<Player, Coord[]> {
  const territories: Record<Player, Coord[]> = { A: [...before.A], B: [...before.B] };
  const alreadyOwned = new Set<string>();
  for (const player of ["A", "B"] as const) {
    for (const { row: r, col: c } of before[player]) alreadyOwned.add(`${r},${c}`);
  }

  const visited = new Set<string>();
  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) continue;
    if (board[r][c] !== "EMPTY") continue;
    if (visited.has(`${r},${c}`)) continue;

    const region = floodRegionFrom(board, r, c, visited);
    const owner = isValidTerritoryRegion(region);
    if (!owner) continue;
    for (const cell of region.cells) {
      const k = `${cell.row},${cell.col}`;
      if (alreadyOwned.has(k)) continue;
      alreadyOwned.add(k);
      territories[owner].push(cell);
    }
  }

  return territories;
}

/** "row,col" keys for one coordinate list — the same key format
 * getGroupLiberties uses, so liberty sets can be intersected with it. */
export function coordKeySet(coords: Coord[]): Set<string> {
  return new Set(coords.map(({ row, col }) => `${row},${col}`));
}

export function lockedCellKeys(territories: Record<Player, Coord[]>): Set<string> {
  const keys = new Set<string>();
  for (const player of ["A", "B"] as const) {
    for (const { row, col } of territories[player]) keys.add(`${row},${col}`);
  }
  return keys;
}
