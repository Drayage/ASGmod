import { getAllGroups, getGroupLiberties } from "./groups";
import { createInitialState, applyMove, passTurn } from "./rules";
import { opponent } from "./types";
import type { Coord, GameState, Move, Player } from "./types";

export interface MatchStats {
  totalPlacements: number;
  winnerTerritory: number;
  largestTerritoryPatch: number;
  threatsCreated: Record<Player, number>;
  durationMs: number;
}

function largestConnectedPatch(cells: Coord[]): number {
  if (cells.length === 0) return 0;
  const cellKeys = new Set(cells.map((c) => `${c.row},${c.col}`));
  const visited = new Set<string>();
  let max = 0;

  for (const cell of cells) {
    const startKey = `${cell.row},${cell.col}`;
    if (visited.has(startKey)) continue;

    let size = 0;
    const queue: Coord[] = [cell];
    visited.add(startKey);

    while (queue.length > 0) {
      const current = queue.shift()!;
      size += 1;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const row = current.row + dr;
        const col = current.col + dc;
        const key = `${row},${col}`;
        if (cellKeys.has(key) && !visited.has(key)) {
          visited.add(key);
          queue.push({ row, col });
        }
      }
    }
    max = Math.max(max, size);
  }

  return max;
}

/** Replays the move history from scratch, counting how many times each
 * player's placement left an opposing group with exactly one liberty
 * (a "threat" — one placement away from capture). */
function countThreatsCreated(moveHistory: Move[]): Record<Player, number> {
  const threats: Record<Player, number> = { A: 0, B: 0 };
  let state: GameState = createInitialState();

  for (const move of moveHistory) {
    if (move.type === "PASS") {
      state = passTurn(state);
      continue;
    }
    state = applyMove(state, move.row, move.col);
    if (state.winner) continue; // capture win — no "threat", the game just ended

    const opponentInAtari = getAllGroups(state.board, opponent(move.player)).some(
      (group) => getGroupLiberties(state.board, group).size === 1,
    );
    if (opponentInAtari) threats[move.player] += 1;
  }

  return threats;
}

export function computeMatchStats(
  finalState: GameState,
  winner: Player,
  matchStartedAt: number,
): MatchStats {
  return {
    totalPlacements: finalState.moveHistory.filter((m) => m.type === "PLACE").length,
    winnerTerritory: finalState.territories[winner].length,
    largestTerritoryPatch: largestConnectedPatch(finalState.territories[winner]),
    threatsCreated: countThreatsCreated(finalState.moveHistory),
    durationMs: Date.now() - matchStartedAt,
  };
}
