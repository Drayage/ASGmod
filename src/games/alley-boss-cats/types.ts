export type Player = "A" | "B";

export type Cell = "EMPTY" | "PLAYER_A" | "PLAYER_B" | "NEUTRAL";

export const BOARD_SIZE = 9;
export const CENTER = 4;
export const STARTING_CATS = 40;
/** Cheese cat (A, first player) must lead by this many territory cells to win. */
export const FIRST_PLAYER_MARGIN = 3;

export type Board = Cell[][];

export interface Coord {
  row: number;
  col: number;
}

export type Move =
  | { turn: number; player: Player; type: "PLACE"; row: number; col: number }
  | { turn: number; player: Player; type: "PASS" };

export type WinReason = "CAPTURE" | "TERRITORY" | null;

export interface GameState {
  board: Board;
  currentPlayer: Player;
  remainingCats: Record<Player, number>;
  consecutivePasses: number;
  territories: Record<Player, Coord[]>;
  winner: Player | null;
  winReason: WinReason;
  moveHistory: Move[];
}

export function playerCell(player: Player): Cell {
  return player === "A" ? "PLAYER_A" : "PLAYER_B";
}

export function opponent(player: Player): Player {
  return player === "A" ? "B" : "A";
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export const DIRECTIONS: ReadonlyArray<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
