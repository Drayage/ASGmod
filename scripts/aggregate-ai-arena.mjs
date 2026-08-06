#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function filesUnder(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (entry.endsWith(".json")) out.push(path);
  }
  return out;
}

const rounded = (value) => Number(value.toFixed(6));
function summarize(values) {
  if (values.length === 0) {
    return {
      count: 0,
      mean: null,
      standardDeviation: null,
      standardError: null,
      confidence95: { low: null, high: null, halfWidth: null },
    };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.length > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (values.length - 1)
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

function marginBreakdown(games) {
  const by = (reason) =>
    summarize(
      games
        .filter((game) => game.winReason === reason)
        .map((game) => game.finalTerritoryMargin),
    );
  return {
    all: summarize(games.map((game) => game.finalTerritoryMargin)),
    territoryOnly: by("TERRITORY"),
    captureOnly: by("CAPTURE"),
    plyCapOnly: by("PLY_CAP"),
  };
}

const inputDir = resolve(arg("input-dir", "arena-shards"));
const output = resolve(arg("output", "arena-summary.json"));
const expectedGames = Number(arg("expected-games", "32"));
const expectedShards = Number(arg("expected-shards", "8"));
const mode = arg("mode", expectedGames === 32 ? "SCREEN" : "FINAL");

const documents = filesUnder(inputDir).map((file) => ({
  file,
  payload: JSON.parse(readFileSync(file, "utf8")),
}));
if (documents.length === 0) throw new Error(`No shard JSON files under ${inputDir}`);
if (documents.length !== expectedShards) {
  throw new Error(`Expected ${expectedShards} shard files, found ${documents.length}`);
}

const games = [];
const ids = new Set();
const seeds = new Set();
for (const { file, payload } of documents) {
  const seed = payload.config?.arenaSeed;
  const match = payload.matches?.[0];
  if (!Number.isInteger(seed) || !match || !Array.isArray(match.games)) {
    throw new Error(`Malformed arena shard ${file}`);
  }
  if (seeds.has(seed)) throw new Error(`Duplicate arena seed ${seed}`);
  seeds.add(seed);
  for (const game of match.games) {
    const id = `${seed}:${game.game}`;
    if (ids.has(id)) throw new Error(`Duplicate game ${id}`);
    ids.add(id);
    games.push({ ...game, shardSeed: seed, shardGameId: id });
  }
}

if (games.length !== expectedGames) {
  throw new Error(`Expected ${expectedGames} games, found ${games.length}`);
}
games.sort((a, b) => a.shardSeed - b.shardSeed || a.game - b.game);

const reasons = { CAPTURE: 0, TERRITORY: 0, PLY_CAP: 0 };
for (const game of games) {
  if (!(game.winReason in reasons)) throw new Error(`Unknown finish reason ${game.winReason}`);
  reasons[game.winReason] += 1;
}
const margins = marginBreakdown(games);
const territoryDecisionRatePercent = rounded(
  (reasons.TERRITORY / games.length) * 100,
);
const captureDecisionRatePercent = rounded(
  (reasons.CAPTURE / games.length) * 100,
);
const xWins = games.filter((game) => game.winnerEngine === "X").length;

const summary = {
  schemaVersion: 2,
  stage: "PHASE_1_ARENA_AGGREGATE",
  generatedAt: new Date().toISOString(),
  mode,
  expectedGames,
  shards: documents.length,
  seeds: [...seeds].sort((a, b) => a - b),
  config: {
    mirroredWithinShard: true,
    maxPlies: documents[0].payload.config.maxPlies,
    hardMs: documents[0].payload.config.hardMs,
    veryHardMs: documents[0].payload.config.veryHardMs,
  },
  gateMetrics: {
    finalTerritoryMarginByReason: margins,
    territoryDecisionRatePercent,
    interpretation:
      "A clear territory improvement raises both territory-only margin and territory-decision rate. A one-sided increase requires diagnosis.",
  },
  referenceMetrics: {
    outcomes: {
      reasons,
      territoryDecisionRatePercent,
      captureDecisionRatePercent,
      wins: { X: xWins, Y: games.length - xWins },
      winRatePercent: {
        X: rounded((xWins / games.length) * 100),
        Y: rounded(((games.length - xWins) / games.length) * 100),
      },
    },
    plies: summarize(games.map((game) => game.plies)),
  },
  games,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `Arena ${mode}: ${games.length} games, territory ${reasons.TERRITORY}/${games.length} ` +
    `(${territoryDecisionRatePercent}%), territory-only margin ${margins.territoryOnly.mean}, ` +
    `capture-only margin ${margins.captureOnly.mean}`,
);
