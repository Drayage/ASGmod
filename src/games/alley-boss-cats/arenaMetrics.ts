import type { GameState, Player } from "./types";

/**
 * Ply on which `player` first owns any confirmed territory.
 *
 * This is the shared form of the metric originally introduced in
 * humanGames.test.ts. Index 0 is the initial position, so the returned index is
 * the same move/ply number used by the recorded human-game fixtures.
 */
export function firstTerritoryTurn(states: readonly GameState[], player: Player): number | null {
  for (let index = 1; index < states.length; index += 1) {
    if (states[index].territories[player].length > 0) return index;
  }
  return null;
}
