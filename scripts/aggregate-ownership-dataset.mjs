#!/usr/bin/env node
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    else out.push(path);
  }
  return out;
}

const inputDir = resolve(arg("input-dir", "ownership-shards"));
const outputDir = resolve(arg("output-dir", "ownership-pilot"));
const expectedTrainGames = Number(arg("expected-train-games", "200"));
const expectedValidationGames = Number(arg("expected-validation-games", "20"));
const expectedTrainShards = Number(arg("expected-train-shards", "8"));

const files = filesUnder(inputDir);
const metas = files
  .filter((file) => file.endsWith("-meta.json"))
  .map((file) => ({ file, data: JSON.parse(readFileSync(file, "utf8")) }));
const trainMetas = metas.filter(({ data }) => data.split === "TRAIN");
const validationMetas = metas.filter(({ data }) => data.split === "HUMAN_VALIDATION_ONLY");

if (trainMetas.length !== expectedTrainShards) {
  throw new Error(`Expected ${expectedTrainShards} train shard metadata files, found ${trainMetas.length}`);
}
if (validationMetas.length !== 1) {
  throw new Error(`Expected one human validation metadata file, found ${validationMetas.length}`);
}

const trainGames = trainMetas.reduce((sum, item) => sum + item.data.games, 0);
const validationGames = validationMetas[0].data.games;
if (trainGames !== expectedTrainGames) {
  throw new Error(`Expected ${expectedTrainGames} train games, found ${trainGames}`);
}
if (validationGames !== expectedValidationGames) {
  throw new Error(`Expected ${expectedValidationGames} validation games, found ${validationGames}`);
}

const trainIds = new Set();
for (const { data } of trainMetas) {
  for (const game of data.gamesDetail) {
    if (trainIds.has(game.gameId)) throw new Error(`Duplicate train game ${game.gameId}`);
    trainIds.add(game.gameId);
  }
}
const validationIds = new Set();
for (const game of validationMetas[0].data.gamesDetail) {
  if (validationIds.has(game.gameId)) throw new Error(`Duplicate validation game ${game.gameId}`);
  if (trainIds.has(game.gameId)) throw new Error(`Train/validation game leakage: ${game.gameId}`);
  validationIds.add(game.gameId);
}

function sumSamples(items, field) {
  return items.reduce((sum, item) => sum + item.data[field], 0);
}

function sumDistribution(items) {
  const counts = { neutral: 0, A: 0, B: 0 };
  for (const { data } of items) {
    counts.neutral += data.labelDistribution.counts.neutral;
    counts.A += data.labelDistribution.counts.A;
    counts.B += data.labelDistribution.counts.B;
  }
  const total = counts.neutral + counts.A + counts.B;
  return {
    counts,
    percent: {
      neutral: (counts.neutral / total) * 100,
      A: (counts.A / total) * 100,
      B: (counts.B / total) * 100,
    },
  };
}

function aggregateBaselines(items) {
  const names = ["influenceCountSignal", "nearestStoneOwner", "alwaysNeutral"];
  // Pooled from raw counts, never by averaging the shards' rates: a short shard
  // and a long one would otherwise carry the same weight.
  const sum = (field) => (name) =>
    items.reduce((total, item) => total + (item.data.baselines[name][field] ?? 0), 0);

  return Object.fromEntries(names.map((name) => {
    const correct = sum("correct")(name);
    const total = sum("total")(name);
    const openCorrect = sum("openCorrect")(name);
    const openTotal = sum("openTotal")(name);
    const claimed = sum("claimedOpenCells")(name);
    const held = sum("heldOpenCells")(name);
    const claimedAndHeld = sum("claimedAndHeldOpenCells")(name);

    return [name, {
      correct,
      total,
      accuracy: total === 0 ? null : correct / total,
      // Whole-board accuracy is mostly free credit — about five in six points
      // end up nobody's — so it ranks a predictor that claims nothing above the
      // signal the engine actually uses. These three are the discriminating
      // numbers, and the ones a model has to be judged on.
      openCorrect,
      openTotal,
      openAccuracy: openTotal === 0 ? null : openCorrect / openTotal,
      claimedOpenCells: claimed,
      heldOpenCells: held,
      claimedAndHeldOpenCells: claimedAndHeld,
      territoryRecall: held === 0 ? null : claimedAndHeld / held,
      territoryPrecision: claimed === 0 ? null : claimedAndHeld / claimed,
    }];
  }));
}

function concatJsonl(sourceFiles, destination) {
  writeFileSync(destination, "");
  for (const file of sourceFiles.sort()) appendFileSync(destination, readFileSync(file));
}

mkdirSync(outputDir, { recursive: true });
const trainBaseFiles = files.filter((file) => /selfplay-shard-\d+-base\.jsonl$/.test(file));
const trainAugmentedFiles = files.filter((file) => /selfplay-shard-\d+-augmented\.jsonl$/.test(file));
const validationBaseFiles = files.filter((file) => file.endsWith("human-validation-base.jsonl"));
const validationAugmentedFiles = files.filter((file) => file.endsWith("human-validation-augmented.jsonl"));
if (trainBaseFiles.length !== expectedTrainShards || trainAugmentedFiles.length !== expectedTrainShards) {
  throw new Error("Missing self-play JSONL shard files");
}
if (validationBaseFiles.length !== 1 || validationAugmentedFiles.length !== 1) {
  throw new Error("Missing human validation JSONL files");
}

concatJsonl(trainBaseFiles, join(outputDir, "ownership-pilot-train-base.jsonl"));
concatJsonl(trainAugmentedFiles, join(outputDir, "ownership-pilot-train-augmented.jsonl"));
concatJsonl(validationBaseFiles, join(outputDir, "ownership-human-validation-base.jsonl"));
concatJsonl(validationAugmentedFiles, join(outputDir, "ownership-human-validation-augmented.jsonl"));

const trainBefore = sumSamples(trainMetas, "samplesBeforeAugmentation");
const trainAfter = sumSamples(trainMetas, "samplesAfterAugmentation");
const validationBefore = sumSamples(validationMetas, "samplesBeforeAugmentation");
const validationAfter = sumSamples(validationMetas, "samplesAfterAugmentation");
if (trainAfter !== trainBefore * 8 || validationAfter !== validationBefore * 8) {
  throw new Error("D4 augmentation is not exactly 8x");
}

const trainSeconds = trainMetas.map((item) => item.data.generationSeconds);
const validationSeconds = validationMetas.map((item) => item.data.generationSeconds);
const summary = {
  schemaVersion: 1,
  stage: "PHASE_1_OWNERSHIP_PILOT_AGGREGATE",
  generatedAt: new Date().toISOString(),
  acceptance: {
    trainGames: trainGames === expectedTrainGames,
    humanValidationGames: validationGames === expectedValidationGames,
    gameLevelSplitDisjoint: [...validationIds].every((id) => !trainIds.has(id)),
    augmentationExactly8x: trainAfter === trainBefore * 8 && validationAfter === validationBefore * 8,
    noModelTraining: true,
    passed: true,
  },
  train: {
    games: trainGames,
    shards: trainMetas.length,
    samplesBeforeAugmentation: trainBefore,
    samplesAfterAugmentation: trainAfter,
    labelDistribution: sumDistribution(trainMetas),
    baselines: aggregateBaselines(trainMetas),
    generationTime: {
      maxShardSecondsApproxWallClock: Math.max(...trainSeconds),
      sumShardComputeSeconds: trainSeconds.reduce((a, b) => a + b, 0),
    },
  },
  humanValidation: {
    games: validationGames,
    sourceFiles: validationMetas[0].data.sourceFiles,
    samplesBeforeAugmentation: validationBefore,
    samplesAfterAugmentation: validationAfter,
    labelDistribution: sumDistribution(validationMetas),
    baselines: aggregateBaselines(validationMetas),
    generationSeconds: validationSeconds[0],
    trainingUseForbidden: true,
  },
  labelContract: validationMetas[0].data.labelContract,
};

writeFileSync(join(outputDir, "ownership-pilot-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
