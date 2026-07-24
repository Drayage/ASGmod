import { BOARD_SIZE, DIRECTIONS, inBounds, playerCell } from "./types";
import type { Board, Coord, Player } from "./types";

function key(row: number, col: number): string {
  return `${row},${col}`;
}

/** BFS over 4-connected same-color cats starting from (startRow, startCol). */
export function getConnectedGroup(board: Board, startRow: number, startCol: number): Coord[] {
  const player = board[startRow][startCol];
  if (player !== "PLAYER_A" && player !== "PLAYER_B") return [];

  const seen = new Set<string>([key(startRow, startCol)]);
  const queue: Coord[] = [{ row: startRow, col: startCol }];
  const group: Coord[] = [];

  while (queue.length > 0) {
    const cell = queue.shift()!;
    group.push(cell);
    for (const [dr, dc] of DIRECTIONS) {
      const row = cell.row + dr;
      const col = cell.col + dc;
      if (!inBounds(row, col)) continue;
      const k = key(row, col);
      if (seen.has(k)) continue;
      if (board[row][col] !== player) continue;
      seen.add(k);
      queue.push({ row, col });
    }
  }

  return group;
}

/** Empty cells adjacent to `group` that count as an escape route: not an
 * opponent/own cat, not the communal feeding spot, and not confirmed
 * territory (`lockedCells`). */
export function getGroupLiberties(
  board: Board,
  group: Coord[],
  lockedCells: ReadonlySet<string> = new Set(),
): Set<string> {
  const liberties = new Set<string>();
  for (const { row, col } of group) {
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] !== "EMPTY") continue;
      const k = key(r, c);
      if (lockedCells.has(k)) continue;
      liberties.add(k);
    }
  }
  return liberties;
}

/** Every group of `player`'s cats on the board (as arrays of coords). */
export function getAllGroups(board: Board, player: Player): Coord[][] {
  const target = playerCell(player);
  const seen = new Set<string>();
  const groups: Coord[][] = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== target) continue;
      const k = key(row, col);
      if (seen.has(k)) continue;
      const group = getConnectedGroup(board, row, col);
      for (const cell of group) seen.add(key(cell.row, cell.col));
      groups.push(group);
    }
  }

  return groups;
}

/** Any group of `player` that has zero liberties, i.e. is captured. */
export function findCapturedGroups(
  board: Board,
  player: Player,
  lockedCells: ReadonlySet<string> = new Set(),
): Coord[][] {
  return getAllGroups(board, player).filter(
    (group) => getGroupLiberties(board, group, lockedCells).size === 0,
  );
}
