/** Contract types for 블로커스 듀오 (Blokus Duo): a 2-player, 14×14-board
 * variant of Blokus. Each side has all 21 standard pieces; every piece
 * after your first must touch one of your own pieces corner-to-corner and
 * must never touch one of your own pieces edge-to-edge. Opponent pieces
 * impose no such restriction. */

import type { PieceId } from "./pieces";

export type Player = "P1" | "P2";

export const BOARD_SIZE = 14;

export interface Coord {
  row: number;
  col: number;
}

export type Board = (Player | null)[][];

/** The square each player's first piece must cover — five squares in from
 * two opposite corners, the standard Duo layout. */
export const START_CELL: Record<Player, Coord> = {
  P1: { row: 4, col: 4 },
  P2: { row: 9, col: 9 },
};

export type Action = { kind: "PLACE"; pieceId: PieceId; cells: Coord[] };

/** An `Action` as it was actually played, kept for the move history. */
export type Move = Action & { turn: number; player: Player };

export interface GameState {
  board: Board;
  /** Each player's not-yet-placed piece ids. */
  remaining: Record<Player, PieceId[]>;
  hasPlayed: Record<Player, boolean>;
  currentPlayer: Player;
  /** `null` while the game is in progress; "DRAW" on a tied final score. */
  winner: Player | "DRAW" | null;
  /** Final scores, set once `winner` is set. */
  scores: Record<Player, number> | null;
  moveHistory: Move[];
}

export function opponent(player: Player): Player {
  return player === "P1" ? "P2" : "P1";
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}
