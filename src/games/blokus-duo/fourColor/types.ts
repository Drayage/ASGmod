/** Contract types for the "4색전" variant: the classic 4-color, 20×20
 * Blokus board played by 2 humans who each control two colors. Turn order
 * still cycles through all four colors in the standard clockwise order —
 * a color only ever cares about its own pieces for the corner/edge-touch
 * rule, exactly as in the real 4-player game; controlling two colors is
 * just a way for one human to take two of the four turns in the rotation. */
import type { PieceId } from "../pieces";
import type { Coord } from "../types";

export type Color = "BLUE" | "YELLOW" | "RED" | "GREEN";
export type Player = "P1" | "P2";

export const BOARD_SIZE = 20;

/** Clockwise turn order, matching standard 4-player Blokus. */
export const COLOR_ORDER: Color[] = ["BLUE", "YELLOW", "RED", "GREEN"];

/** Diagonal pairing: each player gets two colors that are opposite corners
 * of the board, so turn order naturally alternates P1, P2, P1, P2... */
export const COLOR_OWNER: Record<Color, Player> = {
  BLUE: "P1",
  RED: "P1",
  YELLOW: "P2",
  GREEN: "P2",
};

export const START_CELL: Record<Color, Coord> = {
  BLUE: { row: 0, col: 0 },
  YELLOW: { row: 0, col: BOARD_SIZE - 1 },
  RED: { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1 },
  GREEN: { row: BOARD_SIZE - 1, col: 0 },
};

export type Board = (Color | null)[][];

export type Action = { kind: "PLACE"; color: Color; pieceId: PieceId; cells: Coord[] };

/** An `Action` as it was actually played, kept for the move history. */
export type Move = Action & { turn: number };

export interface GameState {
  board: Board;
  /** Each color's not-yet-placed piece ids — colors never share a pool,
   * even when the same human controls two of them. */
  remaining: Record<Color, PieceId[]>;
  hasPlayed: Record<Color, boolean>;
  currentColor: Color;
  /** `null` while in progress; "DRAW" on a tied final team score. */
  winner: Player | "DRAW" | null;
  /** Final team scores (each player's two colors summed), set once `winner` is set. */
  scores: Record<Player, number> | null;
  /** Final per-color scores, set alongside `scores`. */
  colorScores: Record<Color, number> | null;
  moveHistory: Move[];
}

export function nextColor(color: Color): Color {
  const index = COLOR_ORDER.indexOf(color);
  return COLOR_ORDER[(index + 1) % COLOR_ORDER.length];
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}
