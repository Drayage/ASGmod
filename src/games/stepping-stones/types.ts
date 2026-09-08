/** Contract types for 징검다리 (Stepping Stones): a Tak-style stacking and
 * road-building game on a 5×5 board. Each player has flat stones (placed
 * flat or standing) and one capstone. A stack's top piece decides who
 * controls it; connect your own two opposite edges with flats/capstones
 * to win instantly. */

export type Player = "P1" | "P2";

export const BOARD_SIZE = 5;
export const CARRY_LIMIT = BOARD_SIZE;
export const STARTING_FLATS = 21;
export const STARTING_CAPS = 1;

/** A flat stone can be placed flat (counts toward a road and the flat
 * count) or standing/"wall" (blocks roads and movement, counts toward
 * neither). A capstone is always its own kind — stronger than a wall (it
 * can flatten one by moving onto it alone) and always counts as a flat
 * for roads and the end-game tally. */
export type StoneKind = "FLAT" | "STANDING" | "CAP";

export interface Stone {
  owner: Player;
  kind: StoneKind;
}

/** A board square's stack, bottom to top — `[]` means empty, and the last
 * element is always the controlling, visible top stone. */
export type Stack = Stone[];
export type Board = Stack[][];

export interface Reserves {
  flats: number;
  caps: number;
}

export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface Coord {
  row: number;
  col: number;
}

export type Action =
  | { kind: "PLACE"; to: Coord; stoneKind: StoneKind }
  /** Picks up `sum(drops)` stones from the top of the stack at `from`,
   * then drops them one group at a time walking `direction`: `drops[0]`
   * stones (taken from the bottom of the carried group, i.e. the ones
   * that were deepest in the original stack among those carried) land on
   * the first square stepped onto, `drops[1]` on the next, and so on —
   * so the very last stone remaining (originally the top of the stack)
   * always ends up on top at the final square. */
  | { kind: "MOVE"; from: Coord; direction: Direction; drops: number[] };

export type Move = Action & { turn: number; player: Player };

export type WinReason = "ROAD" | "FLATS" | null;

export interface GameState {
  board: Board;
  reserves: Record<Player, Reserves>;
  currentPlayer: Player;
  /** Each player's very first turn must place a FLAT stone belonging to
   * their opponent — Tak's standard first-move balancing rule. */
  hasPlayedFirstMove: Record<Player, boolean>;
  moveHistory: Move[];
  winner: Player | "DRAW" | null;
  winReason: WinReason;
}

export function opponent(player: Player): Player {
  return player === "P1" ? "P2" : "P1";
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function directionDelta(direction: Direction): Coord {
  switch (direction) {
    case "UP":
      return { row: -1, col: 0 };
    case "DOWN":
      return { row: 1, col: 0 };
    case "LEFT":
      return { row: 0, col: -1 };
    case "RIGHT":
      return { row: 0, col: 1 };
  }
}

export function topStone(stack: Stack): Stone | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/** Whether a stack's top stone blocks another stack from moving onto it —
 * true for a standing stone or a capstone, false for flat or empty. */
export function blocksMovement(stack: Stack): boolean {
  const top = topStone(stack);
  return top !== null && (top.kind === "STANDING" || top.kind === "CAP");
}
