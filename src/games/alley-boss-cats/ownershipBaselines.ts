import { influenceOwnerMap } from "./engine/territoryPlanner";
import type { Board, Coord, Player } from "./types";

export type OwnershipLabel = 0 | 1 | 2; // neutral, A, B

/**
 * Per-cell form of the exact signal the evaluation uses.
 *
 * Reads the engine's own map rather than recomputing it. `influenceCount` is
 * itself defined in terms of `influenceOwnerMap`, so this baseline cannot drift
 * away from the signal it exists to measure — a copied breadth-first search and
 * a copied reach constant could, and silently.
 *
 * Only empty cells can be predicted as future territory. Occupied and neutral
 * board cells are predicted neutral, matching the dataset's confirmed-territory
 * label semantics.
 */
export function influenceOwnershipPrediction(board: Board): OwnershipLabel[] {
  return influenceOwnerMap(board).map((owner) =>
    owner === "A" ? 1 : owner === "B" ? 2 : 0,
  );
}

/**
 * Trivial baseline: each empty cell goes to the globally nearest placed cat by
 * Manhattan distance. Ties, occupied cells and the neutral centre are neutral.
 */
export function nearestStoneOwnershipPrediction(board: Board): OwnershipLabel[] {
  const stones: Record<Player, Coord[]> = { A: [], B: [] };
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board.length; col += 1) {
      if (board[row][col] === "PLAYER_A") stones.A.push({ row, col });
      if (board[row][col] === "PLAYER_B") stones.B.push({ row, col });
    }
  }

  const nearest = (row: number, col: number, player: Player) => {
    let best = Number.POSITIVE_INFINITY;
    for (const stone of stones[player]) {
      best = Math.min(best, Math.abs(stone.row - row) + Math.abs(stone.col - col));
    }
    return best;
  };

  const labels: OwnershipLabel[] = [];
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board.length; col += 1) {
      if (board[row][col] !== "EMPTY") {
        labels.push(0);
        continue;
      }
      const a = nearest(row, col, "A");
      const b = nearest(row, col, "B");
      labels.push(a === b ? 0 : a < b ? 1 : 2);
    }
  }
  return labels;
}

export function neutralOwnershipPrediction(board: Board): OwnershipLabel[] {
  return Array<OwnershipLabel>(board.length * board.length).fill(0);
}
