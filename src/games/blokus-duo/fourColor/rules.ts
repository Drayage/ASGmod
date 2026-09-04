import { PIECE_IDS, PIECE_ORIENTATIONS, PIECE_ORIENTATION_KEYS, cellsKey, pieceSize, shapeBounds } from "../pieces";
import type { PieceId } from "../pieces";
import { BOARD_SIZE, COLOR_ORDER, COLOR_OWNER, START_CELL, inBounds, nextColor } from "./types";
import type { Action, Board, Color, GameState, Move, Player } from "./types";
import type { Coord } from "../types";

const EDGE_DELTAS: Array<[number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];
const CORNER_DELTAS: Array<[number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

export function createInitialState(): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array<Color | null>(BOARD_SIZE).fill(null));
  const remaining = {} as Record<Color, PieceId[]>;
  const hasPlayed = {} as Record<Color, boolean>;
  for (const color of COLOR_ORDER) {
    remaining[color] = [...PIECE_IDS];
    hasPlayed[color] = false;
  }
  return {
    board,
    remaining,
    hasPlayed,
    currentColor: "BLUE",
    winner: null,
    scores: null,
    colorScores: null,
    moveHistory: [],
  };
}

function normalize(cells: Coord[]): Coord[] {
  const minRow = Math.min(...cells.map((c) => c.row));
  const minCol = Math.min(...cells.map((c) => c.col));
  return cells
    .map((c) => ({ row: c.row - minRow, col: c.col - minCol }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/** Whether `color` may legally place `pieceId` covering exactly `cells`.
 * The corner/edge-touch rule is checked against `color` alone — a
 * teammate's other color is just another color on the board, with no
 * special adjacency privileges, exactly like the real 4-player game. */
export function isLegalPlacement(state: GameState, color: Color, pieceId: PieceId, cells: Coord[]): boolean {
  if (!state.remaining[color].includes(pieceId)) return false;
  if (cells.length !== pieceSize(pieceId)) return false;
  if (!PIECE_ORIENTATION_KEYS[pieceId].has(cellsKey(normalize(cells)))) return false;

  for (const c of cells) {
    if (!inBounds(c.row, c.col)) return false;
    if (state.board[c.row][c.col] !== null) return false;
  }

  if (!state.hasPlayed[color]) {
    const start = START_CELL[color];
    return cells.some((c) => c.row === start.row && c.col === start.col);
  }

  let touchesOwnCorner = false;
  for (const c of cells) {
    for (const [dr, dc] of EDGE_DELTAS) {
      const r = c.row + dr;
      const cc = c.col + dc;
      if (inBounds(r, cc) && state.board[r][cc] === color) return false;
    }
    for (const [dr, dc] of CORNER_DELTAS) {
      const r = c.row + dr;
      const cc = c.col + dc;
      if (inBounds(r, cc) && state.board[r][cc] === color) touchesOwnCorner = true;
    }
  }
  return touchesOwnCorner;
}

export function getLegalAnchors(state: GameState, color: Color, pieceId: PieceId, orientationIndex: number): Coord[] {
  const shapes = PIECE_ORIENTATIONS[pieceId];
  const shape = shapes[((orientationIndex % shapes.length) + shapes.length) % shapes.length];
  const { height, width } = shapeBounds(shape);
  const anchors: Coord[] = [];
  for (let row = 0; row <= BOARD_SIZE - height; row++) {
    for (let col = 0; col <= BOARD_SIZE - width; col++) {
      const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
      if (isLegalPlacement(state, color, pieceId, cells)) anchors.push({ row, col });
    }
  }
  return anchors;
}

export function getAllLegalPlacements(state: GameState, color: Color): Action[] {
  const result: Action[] = [];
  for (const pieceId of state.remaining[color]) {
    for (const shape of PIECE_ORIENTATIONS[pieceId]) {
      const { height, width } = shapeBounds(shape);
      for (let row = 0; row <= BOARD_SIZE - height; row++) {
        for (let col = 0; col <= BOARD_SIZE - width; col++) {
          const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
          if (isLegalPlacement(state, color, pieceId, cells)) {
            result.push({ kind: "PLACE", color, pieceId, cells });
          }
        }
      }
    }
  }
  return result;
}

export function hasAnyLegalPlacement(state: GameState, color: Color): boolean {
  for (const pieceId of state.remaining[color]) {
    for (const shape of PIECE_ORIENTATIONS[pieceId]) {
      const { height, width } = shapeBounds(shape);
      for (let row = 0; row <= BOARD_SIZE - height; row++) {
        for (let col = 0; col <= BOARD_SIZE - width; col++) {
          const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
          if (isLegalPlacement(state, color, pieceId, cells)) return true;
        }
      }
    }
  }
  return false;
}

export function countOpenCorners(state: GameState, color: Color): number {
  let count = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (state.board[row][col] !== null) continue;
      let cornerTouch = false;
      let edgeTouch = false;
      for (const [dr, dc] of CORNER_DELTAS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && state.board[r][c] === color) cornerTouch = true;
      }
      for (const [dr, dc] of EDGE_DELTAS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && state.board[r][c] === color) edgeTouch = true;
      }
      if (cornerTouch && !edgeTouch) count++;
    }
  }
  return count;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

function applyAction(state: GameState, action: Action): GameState {
  const color = action.color;
  const board = cloneBoard(state.board);
  for (const c of action.cells) board[c.row][c.col] = color;

  const remaining = { ...state.remaining, [color]: state.remaining[color].filter((id) => id !== action.pieceId) };
  const hasPlayed = { ...state.hasPlayed, [color]: true };
  const move: Move = { ...action, turn: state.moveHistory.length };

  return {
    board,
    remaining,
    hasPlayed,
    currentColor: nextColor(color),
    winner: state.winner,
    scores: state.scores,
    colorScores: state.colorScores,
    moveHistory: [...state.moveHistory, move],
  };
}

function remainingSquareCount(state: GameState, color: Color): number {
  return state.remaining[color].reduce((sum, id) => sum + pieceSize(id), 0);
}

function lastPlacedMonomino(state: GameState, color: Color): boolean {
  for (let i = state.moveHistory.length - 1; i >= 0; i--) {
    const move = state.moveHistory[i];
    if (move.color === color) return move.pieceId === "1";
  }
  return false;
}

function scoreForColor(state: GameState, color: Color): number {
  const remainingSquares = remainingSquareCount(state, color);
  let score = -remainingSquares;
  if (remainingSquares === 0) {
    score += 15;
    if (lastPlacedMonomino(state, color)) score += 5;
  }
  return score;
}

function finishGame(state: GameState): GameState {
  const colorScores = {} as Record<Color, number>;
  for (const color of COLOR_ORDER) colorScores[color] = scoreForColor(state, color);

  const scores: Record<Player, number> = { P1: 0, P2: 0 };
  for (const color of COLOR_ORDER) scores[COLOR_OWNER[color]] += colorScores[color];

  const winner: GameState["winner"] = scores.P1 === scores.P2 ? "DRAW" : scores.P1 > scores.P2 ? "P1" : "P2";
  return { ...state, winner, scores, colorScores };
}

/** Settles whose turn it is after `applyAction`: a color with no legal
 * placement left is skipped automatically (trying every other color in
 * rotation order), and the game ends the moment none of the four can move. */
export function resolveTurn(state: GameState): GameState {
  if (state.winner) return state;
  if (hasAnyLegalPlacement(state, state.currentColor)) return state;

  let candidate = nextColor(state.currentColor);
  for (let i = 0; i < COLOR_ORDER.length - 1; i++) {
    if (hasAnyLegalPlacement(state, candidate)) {
      return { ...state, currentColor: candidate };
    }
    candidate = nextColor(candidate);
  }
  return finishGame(state);
}

export function playAction(state: GameState, action: Action): GameState {
  return resolveTurn(applyAction(state, action));
}
