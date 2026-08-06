/**
 * Recombines sharded arena runs into the single output an unsharded run would
 * have produced.
 *
 * Shards each play a disjoint set of mirrored pairs and write their own partial
 * records. Merging concatenates those records and re-runs the *same*
 * aggregation, rather than averaging the shards' summaries — averaging summaries
 * would silently weight a short shard like a long one and cannot recover a
 * standard deviation at all.
 *
 * The merge refuses anything it cannot prove is one run: shards disagreeing on
 * seed or budget are different experiments, a missing game number means a shard
 * failed, and a repeated one means two shards played the same pair.
 *
 *   npx vite-node arena-merge.mts -- --out merged.json shard0.json shard1.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aggregateRecords, type ArenaGameRecord } from "./arena-aggregate";

interface ShardMatch {
  label: string;
  engines: { X: string; Y: string };
  timeBudgetMs: { X: number | null; Y: number | null };
  games: ArenaGameRecord[];
  aggregate: unknown;
}

interface ShardRun {
  schemaVersion: number;
  stage: string;
  primaryMetric: string;
  config: Record<string, unknown>;
  matches: ShardMatch[];
  [key: string]: unknown;
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
if (outIndex === -1 || !argv[outIndex + 1]) {
  throw new Error("usage: arena-merge.mts --out <merged.json> <shard.json>...");
}
const outPath = argv[outIndex + 1];
const shardPaths = argv.filter((value, index) => {
  if (index === outIndex || index === outIndex + 1) return false;
  return !value.startsWith("--");
});
if (shardPaths.length === 0) throw new Error("no shard files given");

const shards: ShardRun[] = shardPaths.map(
  (path) => JSON.parse(readFileSync(path, "utf8")) as ShardRun,
);

/** Fields that must agree for the shards to be one experiment. */
const IDENTITY_KEYS = [
  "gamesPerMatch",
  "maxPlies",
  "openingPlies",
  "arenaSeed",
  "hardMs",
  "veryHardMs",
  "mirrored",
  "seeded",
  "seedPlies",
  "seedFiles",
] as const;

const [first, ...rest] = shards;
for (const [index, shard] of rest.entries()) {
  for (const key of IDENTITY_KEYS) {
    const a = JSON.stringify(first.config[key]);
    const b = JSON.stringify(shard.config[key]);
    if (a !== b) {
      throw new Error(
        `shard ${shardPaths[index + 1]} disagrees on ${key}: ${a} vs ${b} — ` +
          `these are different experiments, not shards of one`,
      );
    }
  }
}

const expectedGames = Number(first.config.gamesPerMatch);
const byLabel = new Map<string, ShardMatch[]>();
for (const shard of shards) {
  for (const match of shard.matches) {
    const bucket = byLabel.get(match.label) ?? [];
    bucket.push(match);
    byLabel.set(match.label, bucket);
  }
}

const merged = [...byLabel.entries()].map(([label, parts]) => {
  const records = parts.flatMap((part) => part.games).sort((a, b) => a.game - b.game);

  const seen = new Set<number>();
  for (const record of records) {
    if (seen.has(record.game)) {
      throw new Error(`${label}: game ${record.game} appears in more than one shard`);
    }
    seen.add(record.game);
  }
  if (records.length !== expectedGames) {
    const missing: number[] = [];
    for (let game = 1; game <= expectedGames; game += 1) if (!seen.has(game)) missing.push(game);
    throw new Error(
      `${label}: merged ${records.length} of ${expectedGames} games; ` +
        `missing ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", ..." : ""} — ` +
        `a shard is absent or failed`,
    );
  }

  return {
    label,
    engines: parts[0].engines,
    timeBudgetMs: parts[0].timeBudgetMs,
    games: records,
    aggregate: aggregateRecords(records),
  };
});

const output = {
  ...first,
  generatedAt: new Date().toISOString(),
  mergedFromShards: shardPaths.length,
  matches: merged,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

for (const match of merged) {
  const margin = match.aggregate.primaryMetric.summary;
  const counted = match.aggregate.primaryMetric.byFinishReason.TERRITORY;
  console.log(
    `${match.label}: ${match.aggregate.games} games from ${shardPaths.length} shards\n` +
      `  territory margin ${margin.mean} cells (95% CI [${margin.confidence95.low}, ` +
      `${margin.confidence95.high}])\n` +
      `  counted games only: ${counted.mean} cells over ${counted.count}\n` +
      `  territory decisions ${match.aggregate.outcomes.territoryDecisionRatePercent}%`,
  );
}
console.log(`wrote ${outPath}`);
