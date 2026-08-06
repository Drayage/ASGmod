import type { GameState, Player } from "./types";

export type ArenaFinishReason = "CAPTURE" | "TERRITORY" | "PLY_CAP";

export interface NumericSummary {
  count: number;
  mean: number | null;
  standardDeviation: number | null;
  standardError: number | null;
  confidence95: {
    low: number | null;
    high: number | null;
    halfWidth: number | null;
  };
}

export interface TerritoryMarginBreakdown {
  all: NumericSummary;
  territoryOnly: NumericSummary;
  captureOnly: NumericSummary;
  plyCapOnly: NumericSummary;
}

export function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function summarize(values: readonly number[]): NumericSummary {
  if (values.length === 0) {
    return {
      count: 0,
      mean: null,
      standardDeviation: null,
      standardError: null,
      confidence95: { low: null, high: null, halfWidth: null },
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
      : 0;
  const standardDeviation = Math.sqrt(variance);
  const standardError = standardDeviation / Math.sqrt(values.length);
  const halfWidth = 1.96 * standardError;

  return {
    count: values.length,
    mean: rounded(mean),
    standardDeviation: rounded(standardDeviation),
    standardError: rounded(standardError),
    confidence95: {
      low: rounded(mean - halfWidth),
      high: rounded(mean + halfWidth),
      halfWidth: rounded(halfWidth),
    },
  };
}

export function summarizeTerritoryMargins(
  games: readonly { finalTerritoryMargin: number; winReason: ArenaFinishReason }[],
): TerritoryMarginBreakdown {
  const forReason = (reason: ArenaFinishReason) =>
    games
      .filter((game) => game.winReason === reason)
      .map((game) => game.finalTerritoryMargin);

  return {
    all: summarize(games.map((game) => game.finalTerritoryMargin)),
    territoryOnly: summarize(forReason("TERRITORY")),
    captureOnly: summarize(forReason("CAPTURE")),
    plyCapOnly: summarize(forReason("PLY_CAP")),
  };
}

/**
 * Ply on which `player` first owns any confirmed territory.
 *
 * Index 0 is the initial position, so the returned index is the same move/ply
 * number used by the recorded human-game fixtures.
 */
export function firstTerritoryTurn(
  states: readonly GameState[],
  player: Player,
): number | null {
  for (let index = 1; index < states.length; index += 1) {
    if (states[index].territories[player].length > 0) return index;
  }
  return null;
}
