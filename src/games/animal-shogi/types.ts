/** Contract types for 동물쇼기 (Dōbutsu Shōgi / Animal Shogi): a 3x4 mini
 * shogi. Captured pieces go to the capturer's hand and can be dropped back
 * onto the board as their own; a Chick promotes to a Hen on the far row. */

export type Player = "A" | "B";

/** A moves toward row 0 ("up"); B moves toward row 3 ("down"). */
export const BOARD_ROWS = 4;
export const BOARD_COLS = 3;

export type PieceType = "LION" | "GIRAFFE" | "ELEPHANT" | "CHICK" | "HEN";

/** What a captured piece reverts to in hand — a captured Hen demotes back
 * to a Chick, and Lion is never captured into a hand (capturing it ends
 * the game on the spot). */
export type HandPieceType = "GIRAFFE" | "ELEPHANT" | "CHICK";

export interface Piece {
  type: PieceType;
  owner: Player;
}

export type Cell = Piece | null;
export type Board = Cell[][];

export interface Coord {
  row: number;
  col: number;
}

export type Action =
  | { kind: "MOVE"; from: Coord; to: Coord }
  | { kind: "DROP"; pieceType: HandPieceType; to: Coord };

/** An `Action` as it was actually played, kept for the move history. */
export type Move = Action & { turn: number; player: Player };

export type WinReason = "CAPTURE" | "TRY" | "NO_MOVES" | null;

export interface GameState {
  board: Board;
  /** Captured pieces available to drop, in the order captured. */
  hands: Record<Player, HandPieceType[]>;
  currentPlayer: Player;
  /** `null` while the game is in progress. Animal Shogi has no draws —
   * shogi's own convention, not this implementation's choice. */
  winner: Player | null;
  winReason: WinReason;
  moveHistory: Move[];
}

export function opponent(player: Player): Player {
  return player === "A" ? "B" : "A";
}

/** The row a player's Lion must reach to win by 트라이 (try) — the far
 * edge of the board from that player's own starting side. */
export function tryRow(player: Player): number {
  return player === "A" ? 0 : BOARD_ROWS - 1;
}

/** The row a Chick promotes to a Hen on — same row as `tryRow`, but kept
 * separate since they mean different things even though the value matches. */
export function promotionRow(player: Player): number {
  return tryRow(player);
}

/** `-1` for A (moves toward row 0), `+1` for B (moves toward row 3). */
export function forwardDelta(player: Player): number {
  return player === "A" ? -1 : 1;
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS;
}

/** Base (unpromoted) type a captured piece reverts to. Never called with
 * LION — capturing it ends the game before anything goes to hand. */
export function demote(type: Exclude<PieceType, "LION">): HandPieceType {
  return type === "HEN" ? "CHICK" : type;
}
