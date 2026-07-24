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
