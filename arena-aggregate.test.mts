import { describe, expect, it } from "vitest";
import { aggregateRecords, summarize, type ArenaGameRecord, type FinishReason } from "./arena-aggregate";

function record(
  game: number,
  winReason: FinishReason,
  margin: number,
  overrides: Partial<ArenaGameRecord> = {},
): ArenaGameRecord {
  const xIsA = game % 2 === 1;
  return {
    game,
    pair: Math.ceil(game / 2),
    engineXSide: xIsA ? "A" : "B",
    engineYSide: xIsA ? "B" : "A",
    winnerSide: margin >= 0 ? (xIsA ? "A" : "B") : xIsA ? "B" : "A",
    winnerEngine: margin >= 0 ? "X" : "Y",
    winReason,
    plies: 50,
    finalTerritoryMargin: margin,
    firstTerritoryTurn: { X: 20, Y: 22, A: 20, B: 22 },
    peakInfluence: { X: 30, Y: 30, A: 30, B: 30 },
    finalTerritory: { X: 5, Y: 5, A: 5, B: 5 },
    influenceToTerritoryConversionPercent: { X: 16, Y: 16 },
    safeMovesAtPly20: { X: 58, Y: 58 },
    ...overrides,
  };
}

describe("summarize", () => {
  it("reports the mean, sample SD and 95% interval", () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary.count).toBe(8);
    expect(summary.mean).toBe(5);
    // Sample (n-1) standard deviation, not the population one.
    expect(summary.standardDeviation).toBeCloseTo(2.13809, 4);
    expect(summary.standardError).toBeCloseTo(0.755929, 4);
    expect(summary.confidence95.halfWidth).toBeCloseTo(1.481621, 4);
  });

  it("says nothing rather than guessing when there is no data", () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.mean).toBeNull();
    expect(summary.confidence95.low).toBeNull();
  });

  it("gives a single sample no spread to claim", () => {
    const summary = summarize([3]);
    expect(summary.mean).toBe(3);
    expect(summary.standardDeviation).toBe(0);
  });
});

describe("aggregateRecords", () => {
  const records = [
    record(1, "TERRITORY", 10),
    record(2, "TERRITORY", -4),
    record(3, "CAPTURE", 1),
    record(4, "CAPTURE", -1),
    record(5, "CAPTURE", 3),
    record(6, "PLY_CAP", 0),
  ];

  it("splits the margin by how the game finished", () => {
    const aggregate = aggregateRecords(records);
    const byReason = aggregate.primaryMetric.byFinishReason;

    // The pooled mean mixes counted verdicts with games that stopped early.
    expect(aggregate.primaryMetric.summary.count).toBe(6);
    expect(aggregate.primaryMetric.summary.mean).toBeCloseTo(9 / 6, 6);

    // Only counted games state a territory verdict.
    expect(byReason.TERRITORY.count).toBe(2);
    expect(byReason.TERRITORY.mean).toBe(3);
    expect(byReason.CAPTURE.count).toBe(3);
    expect(byReason.CAPTURE.mean).toBeCloseTo(1, 6);
    expect(byReason.PLY_CAP.count).toBe(1);
  });

  it("keeps the decision-rate mix alongside the margin", () => {
    const { outcomes } = aggregateRecords(records);
    expect(outcomes.reasons).toEqual({ TERRITORY: 2, CAPTURE: 3, PLY_CAP: 1 });
    expect(outcomes.territoryDecisionRatePercent).toBeCloseTo((2 / 6) * 100, 4);
    expect(outcomes.captureDecisionRatePercent).toBeCloseTo((3 / 6) * 100, 4);
    expect(outcomes.wins.X + outcomes.wins.Y).toBe(6);
  });

  it("catches a candidate that wins the pooled margin by shifting the mix", () => {
    // The same two counted verdicts as the baseline, and nothing better about
    // them — but more games stopped early while ahead. The pooled mean rises,
    // the counted-only mean is unchanged, and the decision-rate mix shows why.
    const gamed = [
      record(1, "TERRITORY", 10),
      record(2, "TERRITORY", -4),
      record(3, "CAPTURE", 9),
      record(4, "CAPTURE", 9),
      record(5, "CAPTURE", 9),
      record(6, "CAPTURE", 9),
      record(7, "CAPTURE", 9),
      record(8, "CAPTURE", 9),
    ];
    const before = aggregateRecords(records);
    const after = aggregateRecords(gamed);

    expect(after.primaryMetric.summary.mean!).toBeGreaterThan(
      before.primaryMetric.summary.mean!,
    );
    expect(after.primaryMetric.byFinishReason.TERRITORY.mean).toBe(
      before.primaryMetric.byFinishReason.TERRITORY.mean,
    );
    expect(after.outcomes.territoryDecisionRatePercent).toBeLessThan(
      before.outcomes.territoryDecisionRatePercent,
    );
  });

  it("does not depend on the order shards happen to be merged in", () => {
    const shuffled = [records[4], records[0], records[5], records[2], records[1], records[3]];
    expect(aggregateRecords(shuffled).primaryMetric.summary).toEqual(
      aggregateRecords(records).primaryMetric.summary,
    );
    expect(aggregateRecords(shuffled).outcomes).toEqual(aggregateRecords(records).outcomes);
  });

  it("counts a metric a game could not supply as missing rather than as zero", () => {
    const withGaps = [
      record(1, "TERRITORY", 2, {
        firstTerritoryTurn: { X: null, Y: 22, A: null, B: 22 },
        influenceToTerritoryConversionPercent: { X: null, Y: 16 },
        safeMovesAtPly20: { X: null, Y: 58 },
      }),
      record(2, "TERRITORY", -2),
    ];
    const aggregate = aggregateRecords(withGaps);
    expect(aggregate.firstTerritoryTurn.X.missing).toBe(1);
    expect(aggregate.firstTerritoryTurn.X.count).toBe(1);
    expect(aggregate.firstTerritoryTurn.Y.missing).toBe(0);
    expect(aggregate.influenceToTerritoryConversionPercent.X.count).toBe(1);
    expect(aggregate.safeMovesAtPly20.X.missing).toBe(1);
  });

  it("prices conversion as total territory over total reach, not a mean of ratios", () => {
    const lopsided = [
      record(1, "TERRITORY", 0, {
        peakInfluence: { X: 10, Y: 10, A: 10, B: 10 },
        finalTerritory: { X: 1, Y: 1, A: 1, B: 1 },
      }),
      record(2, "TERRITORY", 0, {
        peakInfluence: { X: 90, Y: 90, A: 90, B: 90 },
        finalTerritory: { X: 9, Y: 9, A: 9, B: 9 },
      }),
    ];
    const aggregate = aggregateRecords(lopsided);
    expect(aggregate.influenceToTerritoryConversionPercent.X.ratioOfMeans).toBeCloseTo(10, 6);
  });
});
