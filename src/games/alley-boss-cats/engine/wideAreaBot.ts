import type { AIAction } from "../ai";
import { getSafeActions } from "../ai";
import { findSealingMoves } from "./territoryPlanner";
import { BOARD_SIZE, CENTER, DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Coord, GameState, Player } from "../types";

/**
 * A scripted opponent that plays for area rather than for fights.
 *
 * It exists to test the territory planner honestly. Measuring the new AI only
 * against older versions of itself is circular — they share the same blind
 * spots, so a weakness in both looks like parity. This bot deliberately plays
 * the style a human uses and the engine used to ignore: stake out the board
 * with loose diagonals and one-space jumps, then close the frame.
 *
 * It shares the engines' tactical floor — take a win, never give a castle
 * away — so that games actually reach the point where area decides them. An
 * earlier version without that floor simply got captured every game, and every
 * difficulty beat it 14-0 while telling us nothing.
 */

const JUMPS: ReadonlyArray<[number, number]> = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 2],
  [2, -2],
  [-2, 2],
  [-2, -2],
];

function openness(state: GameState, move: Coord): number {
  let open = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const r = move.row + dr;
    const c = move.col + dc;
    if (inBounds(r, c) && state.board[r][c] === "EMPTY") open += 1;
  }
  return open;
}

/** Distance from the board's rim — the bot likes the third line, as a human
 * staking out territory does. */
function rimDistance(move: Coord): number {
  return Math.min(move.row, move.col, BOARD_SIZE - 1 - move.row, BOARD_SIZE - 1 - move.col);
}

export function wideAreaBotMove(state: GameState, player: Player): AIAction {
  const own = playerCell(player);
  const foe = playerCell(opponent(player));

  // 1. Share the engines' tactical floor: take a win when it is there, and
  //    never volunteer a castle. Without this the bot loses on tactics long
  //    before the board is big enough to argue about, and the match says
  //    nothing about whether the opponent understands area.
  const { winningMove, pool } = getSafeActions(state, player);
  if (winningMove) return winningMove;

  const legal: Coord[] = pool
    .filter((a): a is Extract<AIAction, { type: "PLACE" }> => a.type === "PLACE")
    .map(({ row, col }) => ({ row, col }));
  if (legal.length === 0) return { type: "PASS" };

  const isSafe = (move: Coord) => legal.some((m) => m.row === move.row && m.col === move.col);

  // 2. Close a frame when it settles real ground.
  const seals = findSealingMoves(state, player);
  const worthwhile = seals.find((s) => s.gained.length >= 3 && isSafe(s.move));
  if (worthwhile) return { type: "PLACE", ...worthwhile.move };

  // 3. Otherwise extend the framework: jump or play diagonally away from an
  //    existing castle, staying off the very edge and out of contact.
  const stones: Coord[] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (state.board[row][col] === own) stones.push({ row, col });
    }
  }

  if (stones.length === 0) {
    // Open on the third line, the classic framework start.
    const opening: Coord[] = [
      { row: 2, col: 2 },
      { row: 2, col: 6 },
      { row: 6, col: 2 },
      { row: 6, col: 6 },
    ];
    for (const cell of opening) {
      if (isSafe(cell)) return { type: "PLACE", ...cell };
    }
  }

  const candidates: Array<{ move: Coord; score: number }> = [];
  for (const stone of stones) {
    for (const [dr, dc] of JUMPS) {
      const move = { row: stone.row + dr, col: stone.col + dc };
      if (!inBounds(move.row, move.col)) continue;
      if (move.row === CENTER && move.col === CENTER) continue;
      if (!isSafe(move)) continue;

      let touchingFoe = 0;
      for (const [ar, ac] of DIRECTIONS) {
        const r = move.row + ar;
        const c = move.col + ac;
        if (inBounds(r, c) && state.board[r][c] === foe) touchingFoe += 1;
      }

      // Prefer open ground, the third line, and staying clear of the enemy.
      const score =
        openness(state, move) * 3 + Math.min(rimDistance(move), 3) * 2 - touchingFoe * 4;
      candidates.push({ move, score });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return { type: "PLACE", ...candidates[0].move };
  }

  // 4. Nothing framework-like left: take the most open safe point.
  const fallback = [...legal].sort((a, b) => openness(state, b) - openness(state, a))[0];
  return fallback ? { type: "PLACE", ...fallback } : { type: "PASS" };
}
