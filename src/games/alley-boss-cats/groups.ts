import { BOARD_SIZE, DIRECTIONS, inBounds, playerCell } from "./types";
import type { Board, Coord, GameState, Player } from "./types";

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

/**
 * Empty cells adjacent to `group` — a group is only captured when it is
 * surrounded with no gap left at all.
 *
 * Confirmed territory still counts as a liberty even though nobody may play
 * there. A territory is only recognised when a single player's castles form
 * its entire border, so the cells it would "take away" always belong to that
 * same player's own walls; excluding them would mean sealing your own
 * territory could strangle the very group that formed it.
 */
export function getGroupLiberties(board: Board, group: Coord[]): Set<string> {
  const liberties = new Set<string>();
  for (const { row, col } of group) {
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] !== "EMPTY") continue;
      liberties.add(key(r, c));
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

/**
 * Groups that lose the game if the opponent plays one more cat: exactly one
 * escape route left, and one the opponent may actually take.
 *
 * A group whose last breath sits inside its owner's own confirmed living area
 * is deliberately excluded. Nobody may ever play there, so that group can never
 * be surrounded however the count looks — flagging it as endangered would be
 * telling the player to defend something that is already permanently safe.
 */
export function findEndangeredGroups(state: GameState, player: Player): Coord[][] {
  const ownTerritory = new Set(state.territories[player].map((c) => key(c.row, c.col)));
  return getAllGroups(state.board, player).filter((group) => {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size !== 1) return false;
    const [only] = liberties;
    return !ownTerritory.has(only);
  });
}

/** Any group of `player` that has zero liberties, i.e. is captured. */
export function findCapturedGroups(board: Board, player: Player): Coord[][] {
  return getAllGroups(board, player).filter(
    (group) => getGroupLiberties(board, group).size === 0,
  );
}

/**
 * The same question as findCapturedGroups, asked only where the answer can
 * have changed: `board` is a position that had no captured group at all,
 * with one cat just placed at (row, col).
 *
 * That precondition is not an assumption about how callers behave, it is the
 * rule — a capture ends the game outright, so any board play continues from
 * has every group breathing. Given that, a cat of `foe`'s can only have been
 * surrounded just now if the cell that filled its last gap is the one that
 * was placed, which is to say if it sits orthogonally beside it. Every other
 * group on the board kept every liberty it had, and re-deriving that for all
 * of them is the single most expensive thing the search does per node:
 * measured at 21.5µs of a ~90µs node, against a board where at most four
 * groups can possibly qualify.
 */
export function findCapturedGroupsAround(
  board: Board,
  row: number,
  col: number,
  foe: Player,
): Coord[][] {
  const target = playerCell(foe);
  const captured: Coord[][] = [];
  const seen = new Set<string>();

  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) continue;
    if (board[r][c] !== target) continue;
    // Two neighbours can belong to one group; it must not be reported twice.
    if (seen.has(key(r, c))) continue;

    const group = getConnectedGroup(board, r, c);
    for (const cell of group) seen.add(key(cell.row, cell.col));
    if (getGroupLiberties(board, group).size === 0) captured.push(group);
  }

  return captured;
}

/**
 * Whether the cat just placed at (row, col) left its own group with nowhere
 * to breathe, under the same precondition as findCapturedGroupsAround.
 *
 * Only the group containing the new cat needs testing. Placing a cat can
 * take a liberty away from no group it does not touch, and every group it
 * does touch is merged into this one by the placement itself.
 */
export function placedGroupIsCaptured(board: Board, row: number, col: number): boolean {
  const group = getConnectedGroup(board, row, col);
  return group.length > 0 && getGroupLiberties(board, group).size === 0;
}
