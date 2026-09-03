/** Contract types for 꽃피는 정원 (Blooming Garden), an Ataxx-style two-player
 * territory game: clone into an adjacent cell or jump two cells away, then
 * convert every enemy flower touching the new cell. */

export type Player = "A" | "B";

export type Cell = "EMPTY" | "PLAYER_A" | "PLAYER_B" | "OBSTACLE";

export type Board = Cell[][];

export interface Coord {
  row: number;
  col: number;
}

/** A move the current player can make. `CLONE` adds a flower next to an
 * existing one; `JUMP` relocates one two cells away (the origin cell empties). */
export type Action =
  | { type: "CLONE"; row: number; col: number }
  | { type: "JUMP"; fromRow: number; fromCol: number; row: number; col: number };

/** An `Action` as it was actually played, kept for the move history. */
export type Move = Action & { turn: number; player: Player };

export interface GameState {
  board: Board;
  currentPlayer: Player;
  /** `null` while the game is in progress, a `Player` for a decisive result,
   * or `"DRAW"` when both gardeners end with the same number of flowers. */
  winner: Player | "DRAW" | null;
  moveHistory: Move[];
  mapId: string;
}

export function opponent(player: Player): Player {
  return player === "A" ? "B" : "A";
}

export function playerCell(player: Player): Cell {
  return player === "A" ? "PLAYER_A" : "PLAYER_B";
}

export function cellOwner(cell: Cell): Player | null {
  if (cell === "PLAYER_A") return "A";
  if (cell === "PLAYER_B") return "B";
  return null;
}
