import { boardFromMap, resolveMap, terrainFromMap } from "./maps";
import { cellOwner, opponent, playerCell } from "./types";
import type { Action, Board, GameState, Player } from "./types";

export function createInitialState(mapId: string): GameState {
  const map = resolveMap(mapId);
  return {
    board: boardFromMap(map),
    terrain: terrainFromMap(map),
    currentPlayer: "A",
    winner: null,
    moveHistory: [],
    mapId: map.id,
  };
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

function inBounds(row: number, col: number, size: number): boolean {
  return row >= 0 && row < size && col >= 0 && col < size;
}

/** Every legal move a flower at (row, col) can make: distance 1 (Chebyshev)
 * clones, distance 2 jumps, target must be an empty cell. */
export function getLegalMovesFrom(state: GameState, row: number, col: number): Action[] {
  const size = state.board.length;
  const actions: Action[] = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue;
      const distance = Math.max(Math.abs(dr), Math.abs(dc));
      if (distance > 2) continue;
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c, size)) continue;
      if (state.board[r][c] !== "EMPTY") continue;
      if (distance === 1) {
        actions.push({ type: "CLONE", row: r, col: c });
      } else {
        actions.push({ type: "JUMP", fromRow: row, fromCol: col, row: r, col: c });
      }
    }
  }
  return actions;
}

export function getAllLegalMoves(state: GameState, player: Player = state.currentPlayer): Action[] {
  const size = state.board.length;
  const cell = playerCell(player);
  const actions: Action[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (state.board[row][col] !== cell) continue;
      actions.push(...getLegalMovesFrom(state, row, col));
    }
  }
  return actions;
}

export function hasAnyLegalMove(state: GameState, player: Player): boolean {
  const size = state.board.length;
  const cell = playerCell(player);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (state.board[row][col] !== cell) continue;
      if (getLegalMovesFrom(state, row, col).length > 0) return true;
    }
  }
  return false;
}

export function isLegalAction(state: GameState, action: Action, player: Player): boolean {
  const from = action.type === "CLONE" ? null : { row: action.fromRow, col: action.fromCol };
  if (from) {
    if (state.board[from.row][from.col] !== playerCell(player)) return false;
    return getLegalMovesFrom(state, from.row, from.col).some(
      (m) => m.type === "JUMP" && m.row === action.row && m.col === action.col,
    );
  }
  // A CLONE's origin isn't carried on the action, so any of the player's
  // flowers adjacent to the target makes it legal.
  return getAllLegalMoves(state, player).some(
    (m) => m.type === "CLONE" && m.row === action.row && m.col === action.col,
  );
}

export function countFlowers(state: GameState): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  for (const row of state.board) {
    for (const cell of row) {
      const owner = cellOwner(cell);
      if (owner) counts[owner] += 1;
    }
  }
  return counts;
}

function computeWinner(state: GameState): Player | "DRAW" {
  const counts = countFlowers(state);
  if (counts.A > counts.B) return "A";
  if (counts.B > counts.A) return "B";
  return "DRAW";
}

/** Places (or relocates) a flower and converts every orthogonally/diagonally
 * adjacent enemy flower around the landing cell. Does not decide whose turn
 * comes next — call `resolveTurn` on the result for that. */
function applyAction(state: GameState, action: Action): GameState {
  const player = state.currentPlayer;
  const board = cloneBoard(state.board);

  if (action.type === "JUMP") {
    board[action.fromRow][action.fromCol] = "EMPTY";
  }
  board[action.row][action.col] = playerCell(player);

  const opponentCell = playerCell(opponent(player));
  const size = board.length;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = action.row + dr;
      const c = action.col + dc;
      if (!inBounds(r, c, size)) continue;
      if (state.terrain[r][c] === "GREENHOUSE") continue;
      if (board[r][c] === opponentCell) board[r][c] = playerCell(player);
    }
  }

  const move = { ...action, turn: state.moveHistory.length, player };
  return {
    ...state,
    board,
    currentPlayer: opponent(player),
    winner: null,
    moveHistory: [...state.moveHistory, move],
  };
}

export interface TurnResolution {
  state: GameState;
  /** Players auto-skipped (had no legal move) while settling whose turn it
   * is now. Empty in the common case; both entries mean the game just ended. */
  skippedPlayers: Player[];
}

/**
 * Given a state whose `currentPlayer` has not yet been checked for a legal
 * move, skips any player with none, and ends the game once neither can move.
 * A player never chooses to pass — the rules skip them automatically.
 */
export function resolveTurn(state: GameState): TurnResolution {
  if (state.winner) return { state, skippedPlayers: [] };
  let s = state;
  const skipped: Player[] = [];
  for (let i = 0; i < 2; i++) {
    if (hasAnyLegalMove(s, s.currentPlayer)) {
      return { state: s, skippedPlayers: skipped };
    }
    skipped.push(s.currentPlayer);
    s = { ...s, currentPlayer: opponent(s.currentPlayer) };
  }
  return { state: { ...s, winner: computeWinner(s) }, skippedPlayers: skipped };
}

/** The single entry point every caller (UI, AI, tests) should use to play a
 * move: applies it, then settles whose turn is next (skipping/ending as needed). */
export function playMove(state: GameState, action: Action): TurnResolution {
  return resolveTurn(applyAction(state, action));
}
