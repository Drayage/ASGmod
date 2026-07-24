import type { AIAction } from "../ai";
import { getConnectedGroup, getGroupLiberties } from "../groups";
import { getLegalMoves } from "../rules";
import { DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Board, GameState, Player } from "../types";

/**
 * A cheap, purely local score for a candidate placement.
 *
 * Ranking moves by the full evaluation meant applying the move and rescanning
 * the whole board for every child of every node — the ordering alone cost more
 * than the search it was meant to speed up. This only inspects the groups
 * touching the placed cell, which is what decides captures and escapes anyway.
 */
export function localMoveScore(board: Board, row: number, col: number, player: Player): number {
  const own = playerCell(player);
  const enemy = playerCell(opponent(player));

  board[row][col] = own;
  let score = 0;

  try {
    const scoredEnemyGroups = new Set<string>();

    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) {
        score += 3; // hugging a wall helps close off territory cheaply
        continue;
      }

      const value = board[r][c];
      if (value === enemy) {
        const group = getConnectedGroup(board, r, c);
        // Canonical key so a group touched from two sides is scored once.
        const anchor = group.reduce((a, b) => (a.row * 100 + a.col <= b.row * 100 + b.col ? a : b));
        const key = `${anchor.row},${anchor.col}`;
        if (!scoredEnemyGroups.has(key)) {
          scoredEnemyGroups.add(key);
          const liberties = getGroupLiberties(board, group).size;
          if (liberties === 0) score += 1_000_000; // outright capture = win
          else if (liberties === 1) score += 900;
          else if (liberties === 2) score += 130;
          score += group.length * 6;
        }
      } else if (value === own) {
        score += 6; // connecting is usually solid
      }
    }

    const ownGroup = getConnectedGroup(board, row, col);
    const ownLiberties = getGroupLiberties(board, ownGroup).size;
    if (ownLiberties === 1) score -= 800;
    else if (ownLiberties === 2) score -= 170;
    else score += ownLiberties * 4;
  } finally {
    board[row][col] = "EMPTY";
  }

  return score;
}

/**
 * Legal placements sorted by `localMoveScore`, capped at `limit`. Because
 * captures and escapes dominate the score, trimming the tail never drops a
 * tactically relevant move.
 */
export function orderedCandidates(
  state: GameState,
  player: Player,
  limit: number,
  preferredKey?: string,
): AIAction[] {
  const scored = getLegalMoves(state, player).map((move) => ({
    action: { type: "PLACE", row: move.row, col: move.col } as AIAction,
    score: localMoveScore(state.board, move.row, move.col, player),
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit).map(({ action }) => action);

  if (!preferredKey) return top;

  // Search the full list for the transposition table's hint, not just the
  // trimmed head, so a good move found at a shallower depth is never lost.
  const hintIndex = top.findIndex(
    (a) => a.type === "PLACE" && `${a.row},${a.col}` === preferredKey,
  );
  if (hintIndex > 0) {
    const [hinted] = top.splice(hintIndex, 1);
    return [hinted, ...top];
  }
  if (hintIndex === 0) return top;

  const fromFull = scored.find(
    ({ action }) => action.type === "PLACE" && `${action.row},${action.col}` === preferredKey,
  );
  return fromFull ? [fromFull.action, ...top] : top;
}
