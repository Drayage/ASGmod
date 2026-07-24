import { findCapturedGroups } from "./groups";
import { calculateTerritories } from "./territory";
import {
  BOARD_SIZE,
  CENTER,
  DIRECTIONS,
  FIRST_PLAYER_MARGIN,
  STARTING_CATS,
  inBounds,
  opponent,
  playerCell,
} from "./types";
import type { Board, Coord, GameState, Move, Player } from "./types";

export function createInitialState(): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill("EMPTY"),
  );
  board[CENTER][CENTER] = "NEUTRAL";

  return {
    board,
    currentPlayer: "A",
    remainingCats: { A: STARTING_CATS, B: STARTING_CATS },
    consecutivePasses: 0,
    territories: { A: [], B: [] },
    winner: null,
    winReason: null,
    moveHistory: [],
  };
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

export function isTerritoryCell(state: GameState, row: number, col: number): boolean {
  return (
    state.territories.A.some((c) => c.row === row && c.col === col) ||
    state.territories.B.some((c) => c.row === row && c.col === col)
  );
}

/** Would placing `player`'s cat at (row, col) be legal on the current state?
 * Mirrors section 10's capture-priority rule: a move that captures an
 * opponent group is always legal, even if it would otherwise look like a
 * self-atari; a move is only a forbidden "suicide" if it captures nothing
 * and leaves the mover's own group with zero liberties. */
export function isLegalMove(state: GameState, row: number, col: number, player: Player): boolean {
  if (state.winner) return false;
  if (!inBounds(row, col)) return false;
  if (state.board[row][col] !== "EMPTY") return false;
  if (isTerritoryCell(state, row, col)) return false;

  // Fast path: an orthogonally adjacent empty cell is a guaranteed liberty
  // for the merged group, so the move cannot be a suicide and is always
  // legal. This skips the board-clone simulation for the vast majority of
  // cells — search calls this for every candidate at every node.
  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (inBounds(r, c) && state.board[r][c] === "EMPTY") return true;
  }

  const simBoard = cloneBoard(state.board);
  simBoard[row][col] = playerCell(player);

  const capturedOpponent = findCapturedGroups(simBoard, opponent(player));
  if (capturedOpponent.length > 0) return true;

  const capturedSelf = findCapturedGroups(simBoard, player);
  return capturedSelf.length === 0;
}

export function getLegalMoves(state: GameState, player: Player): Coord[] {
  const moves: Coord[] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (isLegalMove(state, row, col, player)) moves.push({ row, col });
    }
  }
  return moves;
}

export interface FinalResult {
  winner: Player;
  territoryA: number;
  territoryB: number;
}

export function calculateFinalResult(state: GameState): FinalResult {
  const territoryA = state.territories.A.length;
  const territoryB = state.territories.B.length;
  const winner: Player = territoryA >= territoryB + FIRST_PLAYER_MARGIN ? "A" : "B";
  return { winner, territoryA, territoryB };
}

export function applyMove(state: GameState, row: number, col: number): GameState {
  const player = state.currentPlayer;
  if (!isLegalMove(state, row, col, player)) {
    throw new Error(`Illegal move for ${player} at (${row}, ${col})`);
  }

  const board = cloneBoard(state.board);
  board[row][col] = playerCell(player);

  const move: Move = { turn: state.moveHistory.length + 1, player, type: "PLACE", row, col };
  const remainingCats = { ...state.remainingCats, [player]: state.remainingCats[player] - 1 };

  const capturedOpponent = findCapturedGroups(board, opponent(player));
  if (capturedOpponent.length > 0) {
    return {
      ...state,
      board,
      remainingCats,
      winner: player,
      winReason: "CAPTURE",
      moveHistory: [...state.moveHistory, move],
    };
  }

  // Defensive net only: isLegalMove already rules suicides out for callers
  // that check legality first, but a caller bypassing that check should
  // still never end up with a silently-broken state.
  const capturedSelf = findCapturedGroups(board, player);
  if (capturedSelf.length > 0) {
    throw new Error("Illegal move: would self-capture without capturing the opponent");
  }

  const territories = calculateTerritories(board);

  return {
    ...state,
    board,
    remainingCats,
    territories,
    consecutivePasses: 0,
    currentPlayer: opponent(player),
    moveHistory: [...state.moveHistory, move],
  };
}

export function passTurn(state: GameState): GameState {
  if (state.winner) return state;

  const player = state.currentPlayer;
  const move: Move = { turn: state.moveHistory.length + 1, player, type: "PASS" };
  const consecutivePasses = state.consecutivePasses + 1;
  const moveHistory = [...state.moveHistory, move];

  if (consecutivePasses >= 2) {
    const { winner } = calculateFinalResult({ ...state, consecutivePasses });
    return {
      ...state,
      consecutivePasses,
      moveHistory,
      winner,
      winReason: "TERRITORY",
    };
  }

  return {
    ...state,
    consecutivePasses,
    moveHistory,
    currentPlayer: opponent(player),
  };
}

export function isGameOver(state: GameState): boolean {
  return state.winner !== null;
}
