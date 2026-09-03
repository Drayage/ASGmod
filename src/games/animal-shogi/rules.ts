import {
  BOARD_COLS,
  BOARD_ROWS,
  demote,
  forwardDelta,
  inBounds,
  opponent,
  promotionRow,
  tryRow,
} from "./types";
import type { Action, Board, Cell, Coord, GameState, HandPieceType, Piece, PieceType, Player } from "./types";

export function createInitialState(): GameState {
  const board: Board = Array.from({ length: BOARD_ROWS }, () => Array<Cell>(BOARD_COLS).fill(null));

  // B's back row (top): Giraffe, Lion, Elephant, left to right.
  board[0][0] = { type: "GIRAFFE", owner: "B" };
  board[0][1] = { type: "LION", owner: "B" };
  board[0][2] = { type: "ELEPHANT", owner: "B" };
  board[1][1] = { type: "CHICK", owner: "B" };

  board[2][1] = { type: "CHICK", owner: "A" };
  // A's back row (bottom): Elephant, Lion, Giraffe, left to right —
  // point-symmetric with B's row above.
  board[3][0] = { type: "ELEPHANT", owner: "A" };
  board[3][1] = { type: "LION", owner: "A" };
  board[3][2] = { type: "GIRAFFE", owner: "A" };

  return {
    board,
    hands: { A: [], B: [] },
    currentPlayer: "A",
    winner: null,
    winReason: null,
    moveHistory: [],
  };
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

/** Offsets a piece may step to, one square, before considering board edges
 * or occupancy. LION/GIRAFFE/ELEPHANT are the same for both players;
 * CHICK/HEN depend on which way "forward" is for `owner`. */
export function stepOffsets(piece: Piece): Array<[number, number]> {
  switch (piece.type) {
    case "LION":
      return [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1], [0, 1],
        [1, -1], [1, 0], [1, 1],
      ];
    case "GIRAFFE":
      return [[-1, 0], [1, 0], [0, -1], [0, 1]];
    case "ELEPHANT":
      return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    case "CHICK": {
      const fwd = forwardDelta(piece.owner);
      return [[fwd, 0]];
    }
    case "HEN": {
      // Moves like a shogi gold general: both forward diagonals, straight
      // forward, straight sideways, and straight back — everything except
      // the two backward diagonals.
      const fwd = forwardDelta(piece.owner);
      return [[fwd, -1], [fwd, 0], [fwd, 1], [0, -1], [0, 1], [-fwd, 0]];
    }
  }
}

/** Every square `piece` (sitting at `from`) may move to — empty squares and
 * enemy-occupied squares alike, since Animal Shogi has no rank-based
 * capture restriction: any piece may capture any piece it can reach. */
export function getMovesFrom(state: GameState, from: Coord): Coord[] {
  const piece = state.board[from.row][from.col];
  if (!piece) return [];
  const moves: Coord[] = [];
  for (const [dr, dc] of stepOffsets(piece)) {
    const row = from.row + dr;
    const col = from.col + dc;
    if (!inBounds(row, col)) continue;
    const target = state.board[row][col];
    if (target && target.owner === piece.owner) continue;
    moves.push({ row, col });
  }
  return moves;
}

/** Whether `pieceType` may legally be dropped at `to` for `player` — the
 * target must be empty, and a Chick may never be dropped on the row where
 * it would have no legal move ever again (mirrors shogi's "dead pawn drop"
 * restriction). */
export function isLegalDrop(state: GameState, pieceType: HandPieceType, to: Coord, player: Player): boolean {
  if (state.board[to.row][to.col] !== null) return false;
  if (pieceType === "CHICK" && to.row === promotionRow(player)) return false;
  return true;
}

export function getLegalDropTargets(state: GameState, pieceType: HandPieceType, player: Player): Coord[] {
  const targets: Coord[] = [];
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      if (isLegalDrop(state, pieceType, { row, col }, player)) targets.push({ row, col });
    }
  }
  return targets;
}

/** Every legal action for `player`: a move for each of their pieces on the
 * board, plus a drop for each distinct piece type in hand at each legal
 * empty square. */
export function getAllLegalActions(state: GameState, player: Player = state.currentPlayer): Action[] {
  const actions: Action[] = [];

  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const piece = state.board[row][col];
      if (!piece || piece.owner !== player) continue;
      for (const to of getMovesFrom(state, { row, col })) {
        actions.push({ kind: "MOVE", from: { row, col }, to });
      }
    }
  }

  const droppableTypes = new Set(state.hands[player]);
  for (const pieceType of droppableTypes) {
    for (let row = 0; row < BOARD_ROWS; row++) {
      for (let col = 0; col < BOARD_COLS; col++) {
        if (isLegalDrop(state, pieceType, { row, col }, player)) {
          actions.push({ kind: "DROP", pieceType, to: { row, col } });
        }
      }
    }
  }

  return actions;
}

export function hasAnyLegalAction(state: GameState, player: Player): boolean {
  const board = state.board;
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const piece = board[row][col];
      if (piece && piece.owner === player && getMovesFrom(state, { row, col }).length > 0) return true;
    }
  }
  for (const pieceType of new Set(state.hands[player])) {
    for (let row = 0; row < BOARD_ROWS; row++) {
      for (let col = 0; col < BOARD_COLS; col++) {
        if (isLegalDrop(state, pieceType, { row, col }, player)) return true;
      }
    }
  }
  return false;
}

export function isLegalAction(state: GameState, action: Action, player: Player): boolean {
  if (action.kind === "MOVE") {
    const piece = state.board[action.from.row][action.from.col];
    if (!piece || piece.owner !== player) return false;
    return getMovesFrom(state, action.from).some((m) => m.row === action.to.row && m.col === action.to.col);
  }
  return state.hands[player].includes(action.pieceType) && isLegalDrop(state, action.pieceType, action.to, player);
}

function removeFirst<T>(items: T[], value: T): T[] {
  const index = items.indexOf(value);
  if (index === -1) return items;
  const copy = [...items];
  copy.splice(index, 1);
  return copy;
}

/** Applies `action` for the side to move. Does not decide whose turn comes
 * next or check for a no-legal-moves loss — call `resolveTurn` for that. */
function applyAction(state: GameState, action: Action): GameState {
  const player = state.currentPlayer;
  const board = cloneBoard(state.board);
  const hands = { A: [...state.hands.A], B: [...state.hands.B] };
  let winner: Player | null = null;
  let winReason: GameState["winReason"] = null;

  if (action.kind === "DROP") {
    board[action.to.row][action.to.col] = { type: action.pieceType, owner: player };
    hands[player] = removeFirst(hands[player], action.pieceType);
  } else {
    const piece = board[action.from.row][action.from.col]!;
    const captured = board[action.to.row][action.to.col];

    if (captured) {
      if (captured.type === "LION") {
        winner = player;
        winReason = "CAPTURE";
      } else {
        hands[player] = [...hands[player], demote(captured.type)];
      }
    }

    board[action.from.row][action.from.col] = null;
    const moved: Piece = { ...piece };
    if (moved.type === "CHICK" && action.to.row === promotionRow(player)) {
      moved.type = "HEN";
    }
    board[action.to.row][action.to.col] = moved;

    if (!winner && moved.type === "LION" && action.to.row === tryRow(player)) {
      winner = player;
      winReason = "TRY";
    }
  }

  const move = { ...action, turn: state.moveHistory.length, player };
  return {
    board,
    hands,
    currentPlayer: opponent(player),
    winner,
    winReason,
    moveHistory: [...state.moveHistory, move],
  };
}

export interface TurnResolution {
  state: GameState;
}

/** Settles whose turn it is after `applyAction`. A side with literally no
 * legal action (board moves or drops) loses on the spot — shogi has no
 * stalemate draw, and Animal Shogi inherits that. */
export function resolveTurn(state: GameState): TurnResolution {
  if (state.winner) return { state };
  if (!hasAnyLegalAction(state, state.currentPlayer)) {
    return {
      state: { ...state, winner: opponent(state.currentPlayer), winReason: "NO_MOVES" },
    };
  }
  return { state };
}

/** The single entry point every caller (UI, AI, tests) should use to play
 * an action: applies it, then settles whose turn is next. */
export function playAction(state: GameState, action: Action): TurnResolution {
  return resolveTurn(applyAction(state, action));
}

export function materialValue(type: PieceType): number {
  switch (type) {
    case "LION":
      return 0; // never counted as material — capturing it ends the game
    case "HEN":
      return 3;
    case "ELEPHANT":
    case "GIRAFFE":
      return 3;
    case "CHICK":
      return 1;
  }
}
