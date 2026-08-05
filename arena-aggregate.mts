/**
 * Arena record types and the aggregation over them.
 *
 * Split out of ai-arena.mts so a sharded run can be recombined without
 * importing the arena itself, which starts playing games the moment it loads.
 * A merged shard set therefore goes through exactly the same aggregation as an
 * unsharded run rather than a second copy of it.
 */

export type FinishReason = "CAPTURE" | "TERRITORY" | "PLY_CAP";
export type EngineSeat = "X" | "Y";
export type Player = "A" | "B";

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

export function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function summarize(values: number[]): NumericSummary {
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

export interface ArenaGameRecord {
  game: number;
  pair: number;
  engineXSide: Player;
  engineYSide: Player;
  winnerSide: Player;
  winnerEngine: EngineSeat;
  winReason: FinishReason;
  plies: number;
  finalTerritoryMargin: number;
  firstTerritoryTurn: Record<EngineSeat, number | null> & Record<Player, number | null>;
  peakInfluence: Record<EngineSeat, number> & Record<Player, number>;
  finalTerritory: Record<EngineSeat, number> & Record<Player, number>;
  influenceToTerritoryConversionPercent: Record<EngineSeat, number | null>;
  safeMovesAtPly20: Record<EngineSeat, number | null>;
}

export interface MatchAggregate {
  games: number;
  mirroredPairs: number;
  primaryMetric: {
    name: "finalTerritoryMargin";
    positiveMeans: "engineX";
    summary: NumericSummary;
    byFinishReason: Record<FinishReason, NumericSummary>;
  };
  outcomes: {
    wins: Record<EngineSeat, number>;
    winRatePercent: Record<EngineSeat, number>;
    reasons: Record<FinishReason, number>;
    territoryDecisionRatePercent: number;
    captureDecisionRatePercent: number;
    plyCapRatePercent: number;
  };
  plies: NumericSummary;
  firstTerritoryTurn: Record<EngineSeat, NumericSummary & { missing: number }>;
  peakInfluence: Record<EngineSeat, NumericSummary>;
  finalTerritory: Record<EngineSeat, NumericSummary>;
  influenceToTerritoryConversionPercent: Record<
    EngineSeat,
    NumericSummary & { ratioOfMeans: number | null }
  >;
  safeMovesAtPly20: Record<EngineSeat, NumericSummary & { missing: number }>;
}

export function aggregateRecords(records: ArenaGameRecord[]): MatchAggregate {
  const games = records.length;
  const xWins = records.filter((game) => game.winnerEngine === "X").length;
  const reasons: Record<FinishReason, number> = { CAPTURE: 0, TERRITORY: 0, PLY_CAP: 0 };
  for (const game of records) reasons[game.winReason] += 1;

  const present = <T>(values: Array<T | null>): T[] =>
    values.filter((value): value is T => value !== null);
  const firstTerritory = (seat: EngineSeat) =>
    present(records.map((game) => game.firstTerritoryTurn[seat]));
  const conversions = (seat: EngineSeat) =>
    present(records.map((game) => game.influenceToTerritoryConversionPercent[seat]));
  const safeMoves = (seat: EngineSeat) => present(records.map((game) => game.safeMovesAtPly20[seat]));
  const ratioOfMeans = (seat: EngineSeat) => {
    const peak = records.reduce((sum, game) => sum + game.peakInfluence[seat], 0);
    if (peak === 0) return null;
    const territory = records.reduce((sum, game) => sum + game.finalTerritory[seat], 0);
    return rounded((territory / peak) * 100);
  };
  const marginsWhere = (reason: FinishReason) =>
    records.filter((game) => game.winReason === reason).map((game) => game.finalTerritoryMargin);

  const share = (part: number) => (games === 0 ? 0 : rounded((part / games) * 100));

  return {
    games,
    mirroredPairs: games / 2,
    primaryMetric: {
      name: "finalTerritoryMargin",
      positiveMeans: "engineX",
      summary: summarize(records.map((game) => game.finalTerritoryMargin)),
      byFinishReason: {
        TERRITORY: summarize(marginsWhere("TERRITORY")),
        CAPTURE: summarize(marginsWhere("CAPTURE")),
        PLY_CAP: summarize(marginsWhere("PLY_CAP")),
      },
    },
    outcomes: {
      wins: { X: xWins, Y: games - xWins },
      winRatePercent: { X: share(xWins), Y: share(games - xWins) },
      reasons,
      territoryDecisionRatePercent: share(reasons.TERRITORY),
      captureDecisionRatePercent: share(reasons.CAPTURE),
      plyCapRatePercent: share(reasons.PLY_CAP),
    },
    plies: summarize(records.map((game) => game.plies)),
    firstTerritoryTurn: {
      X: { ...summarize(firstTerritory("X")), missing: games - firstTerritory("X").length },
      Y: { ...summarize(firstTerritory("Y")), missing: games - firstTerritory("Y").length },
    },
    peakInfluence: {
      X: summarize(records.map((game) => game.peakInfluence.X)),
      Y: summarize(records.map((game) => game.peakInfluence.Y)),
    },
    finalTerritory: {
      X: summarize(records.map((game) => game.finalTerritory.X)),
      Y: summarize(records.map((game) => game.finalTerritory.Y)),
    },
    influenceToTerritoryConversionPercent: {
      X: { ...summarize(conversions("X")), ratioOfMeans: ratioOfMeans("X") },
      Y: { ...summarize(conversions("Y")), ratioOfMeans: ratioOfMeans("Y") },
    },
    safeMovesAtPly20: {
      X: { ...summarize(safeMoves("X")), missing: games - safeMoves("X").length },
      Y: { ...summarize(safeMoves("Y")), missing: games - safeMoves("Y").length },
    },
  };
}
