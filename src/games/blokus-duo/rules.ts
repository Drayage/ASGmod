import { PIECE_IDS, PIECE_ORIENTATIONS, PIECE_ORIENTATION_KEYS, cellsKey, pieceSize, shapeBounds } from "./pieces";
import type { PieceId } from "./pieces";
import { BOARD_SIZE, START_CELL, inBounds, opponent } from "./types";
import type { Action, Board, Coord, GameState, Move, Player } from "./types";

const EDGE_DELTAS: Array<[number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];
const CORNER_DELTAS: Array<[number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

export function createInitialState(): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array<Player | null>(BOARD_SIZE).fill(null));
  return {
    board,
    remaining: { P1: [...PIECE_IDS], P2: [...PIECE_IDS] },
    hasPlayed: { P1: false, P2: false },
    currentPlayer: "P1",
    winner: null,
    scores: null,
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

/** Whether `player` may legally place `pieceId` covering exactly `cells`
 * (absolute board coordinates) on `state`'s current board. */
export function isLegalPlacement(state: GameState, player: Player, pieceId: PieceId, cells: Coord[]): boolean {
  if (!state.remaining[player].includes(pieceId)) return false;
  if (cells.length !== pieceSize(pieceId)) return false;
  if (!PIECE_ORIENTATION_KEYS[pieceId].has(cellsKey(normalize(cells)))) return false;

  for (const c of cells) {
    if (!inBounds(c.row, c.col)) return false;
    if (state.board[c.row][c.col] !== null) return false;
  }

  if (!state.hasPlayed[player]) {
    const start = START_CELL[player];
    return cells.some((c) => c.row === start.row && c.col === start.col);
  }

  let touchesOwnCorner = false;
  for (const c of cells) {
    for (const [dr, dc] of EDGE_DELTAS) {
      const r = c.row + dr;
      const cc = c.col + dc;
      if (inBounds(r, cc) && state.board[r][cc] === player) return false;
    }
    for (const [dr, dc] of CORNER_DELTAS) {
      const r = c.row + dr;
      const cc = c.col + dc;
      if (inBounds(r, cc) && state.board[r][cc] === player) touchesOwnCorner = true;
    }
  }
  return touchesOwnCorner;
}

/** Board coordinates where the normalized shape's (0,0) cell could land to
 * produce a legal placement of `pieceId` at `orientationIndex`. */
export function getLegalAnchors(state: GameState, player: Player, pieceId: PieceId, orientationIndex: number): Coord[] {
  const shapes = PIECE_ORIENTATIONS[pieceId];
  const shape = shapes[((orientationIndex % shapes.length) + shapes.length) % shapes.length];
  const { height, width } = shapeBounds(shape);
  const anchors: Coord[] = [];
  for (let row = 0; row <= BOARD_SIZE - height; row++) {
    for (let col = 0; col <= BOARD_SIZE - width; col++) {
      const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
      if (isLegalPlacement(state, player, pieceId, cells)) anchors.push({ row, col });
    }
  }
  return anchors;
}

/** Every legal placement available to `player`, across every remaining
 * piece and every orientation of it. Used for AI move choice and for
 * detecting a forced pass. */
export function getAllLegalPlacements(state: GameState, player: Player): Action[] {
  const result: Action[] = [];
  for (const pieceId of state.remaining[player]) {
    for (const shape of PIECE_ORIENTATIONS[pieceId]) {
      const { height, width } = shapeBounds(shape);
      for (let row = 0; row <= BOARD_SIZE - height; row++) {
        for (let col = 0; col <= BOARD_SIZE - width; col++) {
          const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
          if (isLegalPlacement(state, player, pieceId, cells)) {
            result.push({ kind: "PLACE", pieceId, cells });
          }
        }
      }
    }
  }
  return result;
}

export function hasAnyLegalPlacement(state: GameState, player: Player): boolean {
  for (const pieceId of state.remaining[player]) {
    for (const shape of PIECE_ORIENTATIONS[pieceId]) {
      const { height, width } = shapeBounds(shape);
      for (let row = 0; row <= BOARD_SIZE - height; row++) {
        for (let col = 0; col <= BOARD_SIZE - width; col++) {
          const cells = shape.map((c) => ({ row: row + c.row, col: col + c.col }));
          if (isLegalPlacement(state, player, pieceId, cells)) return true;
        }
      }
    }
  }
  return false;
}

/** Empty squares that are a legal anchor point for `player` right now —
 * corner-touching one of their own pieces (or, before their first move,
 * their start square) and not edge-touching one. Used as a mobility proxy
 * by the AI, not for legality itself. */
export function countOpenCorners(state: GameState, player: Player): number {
  let count = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (state.board[row][col] !== null) continue;
      let cornerTouch = false;
      let edgeTouch = false;
      for (const [dr, dc] of CORNER_DELTAS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && state.board[r][c] === player) cornerTouch = true;
      }
      for (const [dr, dc] of EDGE_DELTAS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && state.board[r][c] === player) edgeTouch = true;
      }
      if (cornerTouch && !edgeTouch) count++;
    }
  }
  return count;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

/** Applies `action` for the side to move. Does not decide whose turn comes
 * next or check for a forced pass / game end — call `resolveTurn` for that. */
function applyAction(state: GameState, action: Action): GameState {
  const player = state.currentPlayer;
  const board = cloneBoard(state.board);
  for (const c of action.cells) board[c.row][c.col] = player;

  const remaining = { ...state.remaining, [player]: state.remaining[player].filter((id) => id !== action.pieceId) };
  const hasPlayed = { ...state.hasPlayed, [player]: true };
  const move: Move = { ...action, turn: state.moveHistory.length, player };

  return {
    board,
    remaining,
    hasPlayed,
    currentPlayer: opponent(player),
    winner: state.winner,
    scores: state.scores,
    moveHistory: [...state.moveHistory, move],
  };
}

function remainingSquareCount(state: GameState, player: Player): number {
  return state.remaining[player].reduce((sum, id) => sum + pieceSize(id), 0);
}

function lastPlacedMonomino(state: GameState, player: Player): boolean {
  for (let i = state.moveHistory.length - 1; i >= 0; i--) {
    const move = state.moveHistory[i];
    if (move.player === player) return move.pieceId === "1";
  }
  return false;
}

/** Standard Blokus scoring: negative one point per square left unplaced;
 * +15 if every piece got placed, plus another +5 if the very last piece
 * placed was the 1-square monomino. */
function scoreFor(state: GameState, player: Player): number {
  const remainingSquares = remainingSquareCount(state, player);
  let score = -remainingSquares;
  if (remainingSquares === 0) {
    score += 15;
    if (lastPlacedMonomino(state, player)) score += 5;
  }
  return score;
}

function finishGame(state: GameState): GameState {
  const scores = { P1: scoreFor(state, "P1"), P2: scoreFor(state, "P2") };
  const winner: GameState["winner"] = scores.P1 === scores.P2 ? "DRAW" : scores.P1 > scores.P2 ? "P1" : "P2";
  return { ...state, winner, scores };
}

/** Settles whose turn it is after `applyAction`: a player with no legal
 * placement left for any remaining piece is skipped automatically, and the
 * game ends the moment neither side can move. */
export function resolveTurn(state: GameState): GameState {
  if (state.winner) return state;
  if (hasAnyLegalPlacement(state, state.currentPlayer)) return state;
  const other = opponent(state.currentPlayer);
  if (hasAnyLegalPlacement(state, other)) return resolveTurn({ ...state, currentPlayer: other });
  return finishGame(state);
}

/** The single entry point every caller (UI, AI, tests) should use to play
 * an action: applies it, then settles whose turn is next. */
export function playAction(state: GameState, action: Action): GameState {
  return resolveTurn(applyAction(state, action));
}
