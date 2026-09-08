import {
  BOARD_SIZE,
  CARRY_LIMIT,
  STARTING_CAPS,
  STARTING_FLATS,
  blocksMovement,
  directionDelta,
  inBounds,
  opponent,
  topStone,
} from "./types";
import type { Action, Board, Coord, Direction, GameState, Player, Stack, StoneKind } from "./types";

export function createInitialState(): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => [] as Stack));
  return {
    board,
    reserves: {
      P1: { flats: STARTING_FLATS, caps: STARTING_CAPS },
      P2: { flats: STARTING_FLATS, caps: STARTING_CAPS },
    },
    currentPlayer: "P1",
    hasPlayedFirstMove: { P1: false, P2: false },
    moveHistory: [],
    winner: null,
    winReason: null,
  };
}

/** Whose stone color is actually being placed this turn — your own,
 * except on each player's very first turn, when Tak's standard opening
 * rule has you place one of your opponent's flat stones instead. */
export function placingOwner(state: GameState): Player {
  return state.hasPlayedFirstMove[state.currentPlayer] ? state.currentPlayer : opponent(state.currentPlayer);
}

export function isLegalPlace(state: GameState, to: Coord, stoneKind: StoneKind): boolean {
  if (!inBounds(to.row, to.col)) return false;
  if (state.board[to.row][to.col].length > 0) return false;
  if (!state.hasPlayedFirstMove[state.currentPlayer] && stoneKind !== "FLAT") return false;

  const owner = placingOwner(state);
  const reserves = state.reserves[owner];
  return stoneKind === "CAP" ? reserves.caps > 0 : reserves.flats > 0;
}

export function getLegalPlacements(state: GameState): Action[] {
  const actions: Action[] = [];
  const kinds: StoneKind[] = state.hasPlayedFirstMove[state.currentPlayer] ? ["FLAT", "STANDING", "CAP"] : ["FLAT"];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      for (const stoneKind of kinds) {
        if (isLegalPlace(state, { row, col }, stoneKind)) actions.push({ kind: "PLACE", to: { row, col }, stoneKind });
      }
    }
  }
  return actions;
}

/** Every way to write `total` as an ordered sum of positive integers —
 * how a carried group of stones may be split across the squares it's
 * dropped onto, one part per square, in order. */
function dropCompositions(total: number): number[][] {
  if (total <= 0) return [];
  const results: number[][] = [];
  const build = (remaining: number, current: number[]) => {
    if (remaining === 0) {
      results.push(current);
      return;
    }
    for (let take = 1; take <= remaining; take++) {
      build(remaining - take, [...current, take]);
    }
  };
  build(total, []);
  return results;
}

/** Whether picking up `carryCount` stones from `from` and dropping them
 * per `drops` along `direction` is legal: every square must be on the
 * board, every square before the last must not be blocked (a standing
 * stone or capstone), and the last may only be blocked if it's a single
 * standing stone being flattened by a lone capstone landing there (i.e.
 * the mover's own top stone is a capstone and the final drop is size 1). */
export function isLegalMove(state: GameState, from: Coord, direction: Direction, drops: number[]): boolean {
  if (!state.hasPlayedFirstMove[state.currentPlayer]) return false;
  const stack = state.board[from.row][from.col];
  const top = topStone(stack);
  if (!top || top.owner !== state.currentPlayer) return false;

  const carryCount = drops.reduce((sum, n) => sum + n, 0);
  if (carryCount < 1 || carryCount > CARRY_LIMIT || carryCount > stack.length) return false;
  if (drops.some((n) => n < 1)) return false;

  const delta = directionDelta(direction);
  for (let i = 0; i < drops.length; i++) {
    const row = from.row + delta.row * (i + 1);
    const col = from.col + delta.col * (i + 1);
    if (!inBounds(row, col)) return false;

    const destination = state.board[row][col];
    if (!blocksMovement(destination)) continue;

    const isLastSquare = i === drops.length - 1;
    const destinationTop = topStone(destination)!;
    if (!isLastSquare || destinationTop.kind === "CAP") return false;
    // Only a lone capstone dropped alone can flatten a standing stone —
    // and since drops are peeled off the carried group front-to-back, a
    // final drop of size 1 is always the stack's original top stone.
    if (destinationTop.kind === "STANDING" && !(drops[i] === 1 && top.kind === "CAP")) return false;
  }
  return true;
}

export function getLegalMovesFrom(state: GameState, from: Coord): Action[] {
  const stack = state.board[from.row][from.col];
  const top = topStone(stack);
  if (!top || top.owner !== state.currentPlayer) return [];

  const actions: Action[] = [];
  const directions: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];
  const maxCarry = Math.min(CARRY_LIMIT, stack.length);
  for (const direction of directions) {
    for (let carry = 1; carry <= maxCarry; carry++) {
      for (const drops of dropCompositions(carry)) {
        if (isLegalMove(state, from, direction, drops)) actions.push({ kind: "MOVE", from, direction, drops });
      }
    }
  }
  return actions;
}

export function getAllLegalActions(state: GameState): Action[] {
  const actions = getLegalPlacements(state);
  if (state.hasPlayedFirstMove[state.currentPlayer]) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        actions.push(...getLegalMovesFrom(state, { row, col }));
      }
    }
  }
  return actions;
}

export function isLegalAction(state: GameState, action: Action): boolean {
  return action.kind === "PLACE"
    ? isLegalPlace(state, action.to, action.stoneKind)
    : isLegalMove(state, action.from, action.direction, action.drops);
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((stack) => [...stack]));
}

function applyAction(state: GameState, action: Action): GameState {
  const player = state.currentPlayer;
  const board = cloneBoard(state.board);
  const reserves = { P1: { ...state.reserves.P1 }, P2: { ...state.reserves.P2 } };

  if (action.kind === "PLACE") {
    const owner = placingOwner(state);
    if (action.stoneKind === "CAP") reserves[owner].caps -= 1;
    else reserves[owner].flats -= 1;
    board[action.to.row][action.to.col] = [{ owner, kind: action.stoneKind }];
  } else {
    const stack = board[action.from.row][action.from.col];
    const carryCount = action.drops.reduce((sum, n) => sum + n, 0);
    let carried = stack.slice(stack.length - carryCount);
    board[action.from.row][action.from.col] = stack.slice(0, stack.length - carryCount);

    const delta = directionDelta(action.direction);
    for (let i = 0; i < action.drops.length; i++) {
      const row = action.from.row + delta.row * (i + 1);
      const col = action.from.col + delta.col * (i + 1);
      const dropped = carried.slice(0, action.drops[i]);
      carried = carried.slice(action.drops[i]);

      let destination = board[row][col];
      const destinationTop = topStone(destination);
      if (destinationTop?.kind === "STANDING") {
        destination = [...destination.slice(0, -1), { ...destinationTop, kind: "FLAT" as StoneKind }];
      }
      board[row][col] = [...destination, ...dropped];
    }
  }

  const hasPlayedFirstMove = { ...state.hasPlayedFirstMove, [player]: true };
  const move = { ...action, turn: state.moveHistory.length, player };

  return {
    board,
    reserves,
    currentPlayer: opponent(player),
    hasPlayedFirstMove,
    moveHistory: [...state.moveHistory, move],
    winner: state.winner,
    winReason: state.winReason,
  };
}

/** Whether `player` has connected two opposite edges of the board with a
 * chain of their own flat stones and/or capstones — standing stones never
 * count toward a road, even their own. */
export function hasRoad(state: GameState, player: Player): boolean {
  const owns = (row: number, col: number) => {
    const top = topStone(state.board[row][col]);
    return top !== null && top.owner === player && (top.kind === "FLAT" || top.kind === "CAP");
  };

  const floodFrom = (starts: Coord[]): Set<string> => {
    const seen = new Set<string>();
    const queue = starts.filter((c) => owns(c.row, c.col));
    for (const c of queue) seen.add(`${c.row},${c.col}`);
    while (queue.length > 0) {
      const { row, col } = queue.pop()!;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const r = row + dr;
        const c = col + dc;
        const key = `${r},${c}`;
        if (inBounds(r, c) && owns(r, c) && !seen.has(key)) {
          seen.add(key);
          queue.push({ row: r, col: c });
        }
      }
    }
    return seen;
  };

  const fromTop = floodFrom(Array.from({ length: BOARD_SIZE }, (_, col) => ({ row: 0, col })));
  if (Array.from({ length: BOARD_SIZE }).some((_, col) => fromTop.has(`${BOARD_SIZE - 1},${col}`))) return true;

  const fromLeft = floodFrom(Array.from({ length: BOARD_SIZE }, (_, row) => ({ row, col: 0 })));
  if (Array.from({ length: BOARD_SIZE }).some((_, row) => fromLeft.has(`${row},${BOARD_SIZE - 1}`))) return true;

  return false;
}

function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every((stack) => stack.length > 0));
}

export function countFlats(state: GameState, player: Player): number {
  let count = 0;
  for (const row of state.board) {
    for (const stack of row) {
      const top = topStone(stack);
      if (top && top.owner === player && (top.kind === "FLAT" || top.kind === "CAP")) count++;
    }
  }
  return count;
}

function finishByFlats(state: GameState): GameState {
  const p1 = countFlats(state, "P1");
  const p2 = countFlats(state, "P2");
  const winner: GameState["winner"] = p1 === p2 ? "DRAW" : p1 > p2 ? "P1" : "P2";
  return { ...state, winner, winReason: "FLATS" };
}

/** Settles the game after `applyAction`: a road for the side that just
 * moved wins immediately; failing that, a road for the other side (a rare
 * side effect) also wins; failing that, running out of reserves or
 * filling the board ends the game on the flat count. */
export function resolveTurn(state: GameState, actingPlayer: Player): GameState {
  if (state.winner) return state;
  if (hasRoad(state, actingPlayer)) return { ...state, winner: actingPlayer, winReason: "ROAD" };
  const other = opponent(actingPlayer);
  if (hasRoad(state, other)) return { ...state, winner: other, winReason: "ROAD" };

  const actingReserves = state.reserves[actingPlayer];
  const outOfReserves = actingReserves.flats === 0 && actingReserves.caps === 0;
  if (outOfReserves || isBoardFull(state.board)) return finishByFlats(state);

  return state;
}

/** The single entry point every caller (UI, AI, tests) should use to play
 * an action: applies it, then settles the game. */
export function playAction(state: GameState, action: Action): GameState {
  const actingPlayer = state.currentPlayer;
  return resolveTurn(applyAction(state, action), actingPlayer);
}

export function materialValue(kind: StoneKind): number {
  return kind === "STANDING" ? 0 : 1;
}
