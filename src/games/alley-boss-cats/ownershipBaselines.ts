import { influenceCount } from "./engine/territoryPlanner";
import { DIRECTIONS, inBounds, playerCell } from "./types";
import type { Board, Coord, Player } from "./types";

export type OwnershipLabel = 0 | 1 | 2; // neutral, A, B

const INFLUENCE_REACH = 3;

function distanceField(board: Board, player: Player): number[][] {
  const size = board.length;
  const dist = Array.from({ length: size }, () =>
    Array<number>(size).fill(Number.POSITIVE_INFINITY),
  );
  const own = playerCell(player);
  const queue: Coord[] = [];
  const open = (row: number, col: number) =>
    inBounds(row, col) && board[row][col] === "EMPTY";

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (board[row][col] !== own) continue;
      for (const [dr, dc] of DIRECTIONS) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (!open(nextRow, nextCol) || dist[nextRow][nextCol] <= 1) continue;
        dist[nextRow][nextCol] = 1;
        queue.push({ row: nextRow, col: nextCol });
      }
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const { row, col } = queue[head];
    if (dist[row][col] >= INFLUENCE_REACH) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const nextRow = row + dr;
      const nextCol = col + dc;
      const nextDistance = dist[row][col] + 1;
      if (
        !open(nextRow, nextCol) ||
        dist[nextRow][nextCol] <= nextDistance
      ) {
        continue;
      }
      dist[nextRow][nextCol] = nextDistance;
      queue.push({ row: nextRow, col: nextCol });
    }
  }

  return dist;
}

/**
 * Per-cell form of the exact signal used by influenceCount.
 *
 * Only empty cells can be predicted as future territory. Occupied and neutral
 * board cells are predicted neutral, matching the dataset's confirmed-territory
 * label semantics.
 */
export function influenceOwnershipPrediction(board: Board): OwnershipLabel[] {
  const distA = distanceField(board, "A");
  const distB = distanceField(board, "B");
  const labels: OwnershipLabel[] = [];

  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board.length; col += 1) {
      if (board[row][col] !== "EMPTY") {
        labels.push(0);
        continue;
      }
      const a = distA[row][col];
      const b = distB[row][col];
      labels.push(a === b ? 0 : a < b ? 1 : 2);
    }
  }

  // Prevent the baseline implementation from silently drifting away from the
  // live engine signal it is meant to measure.
  const counts = influenceCount(board);
  const predictedA = labels.filter((label) => label === 1).length;
  const predictedB = labels.filter((label) => label === 2).length;
  if (predictedA !== counts.A || predictedB !== counts.B) {
    throw new Error(
      `Influence ownership drift: grid ${predictedA}:${predictedB}, count ${counts.A}:${counts.B}`,
    );
  }
  return labels;
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
