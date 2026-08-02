import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs() {
  const result = {};
  for (const token of process.argv.slice(2)) {
    const match = token.match(/^--([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function coreComparison(comparison) {
  return {
    games: comparison.games,
    wins: comparison.wins,
    losses: comparison.losses,
    winRate: comparison.winRate,
    captureLosses: comparison.captureLosses,
    captureLossRate: comparison.captureLossRate,
    absoluteSeatWinRateGap: comparison.absoluteSeatWinRateGap,
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const options = parseArgs();
if (!options.build || !options["arena-root"] || !options.output) {
  throw new Error("--build, --arena-root and --output are required");
}
const build = readJson(options.build);
if (!build.acceptance?.passed || !Array.isArray(build.variants) || build.variants.length !== 4) {
  throw new Error("M3.8 build summary is not accepted or does not contain four variants");
}

const arenaRoot = resolve(options["arena-root"]);
const rows = [];
const controls = [];
for (const variant of build.variants) {
  const arena = readJson(`${arenaRoot}/${variant.name}/arena-summary.json`);
  if (!arena.acceptance?.passed) throw new Error(`${variant.name}: arena acceptance failed`);
  const parent = arena.comparisons?.CANDIDATE_IMPROVED_VS_PARENT_IMPROVED;
  const current = arena.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT;
  const parentCurrent = arena.comparisons?.PARENT_IMPROVED_VS_CURRENT;
  if (!parent || !current || !parentCurrent) {
    throw new Error(`${variant.name}: missing improved-mode comparisons`);
  }
  if (parent.games !== 32 || current.games !== 32 || parentCurrent.games !== 32) {
    throw new Error(`${variant.name}: expected 32 games per comparison`);
  }

  const parentCurrentCore = coreComparison(parentCurrent);
  controls.push({ name: variant.name, ...parentCurrentCore });
  const currentDelta = current.winRate - parentCurrent.winRate;
  const captureDelta = current.captureLossRate - parentCurrent.captureLossRate;
  const promising = parent.winRate >= 0.5
    && currentDelta >= 0
    && captureDelta <= 0.02;
  const clearRegression = parent.winRate < 0.45 || currentDelta <= -0.1;
  rows.push({
    name: variant.name,
    sourceEpoch: variant.sourceEpoch,
    copiedHeads: variant.copiedHeads,
    checkpointSha256: variant.checkpointSha256,
    parentHeadToHead: parent,
    currentVeryHard: current,
    parentVsCurrent: parentCurrent,
    currentWinRateDeltaVsPairedControl: currentDelta,
    captureLossRateDeltaVsPairedControl: captureDelta,
    status: promising
      ? "PROMISING_FOR_INDEPENDENT_128_DIAGNOSTIC"
      : clearRegression
        ? "CLEAR_REGRESSION"
        : "INCONCLUSIVE",
  });
}

rows.sort((left, right) => {
  if (right.parentHeadToHead.winRate !== left.parentHeadToHead.winRate) {
    return right.parentHeadToHead.winRate - left.parentHeadToHead.winRate;
  }
  if (right.currentWinRateDeltaVsPairedControl !== left.currentWinRateDeltaVsPairedControl) {
    return right.currentWinRateDeltaVsPairedControl - left.currentWinRateDeltaVsPairedControl;
  }
  if (left.sourceEpoch !== right.sourceEpoch) return left.sourceEpoch - right.sourceEpoch;
  return left.name.localeCompare(right.name);
});

const controlWinRates = controls.map((control) => control.winRate);
const controlDiagnostics = {
  perVariant: controls,
  meanWinRate: mean(controlWinRates),
  minWinRate: Math.min(...controlWinRates),
  maxWinRate: Math.max(...controlWinRates),
  spread: Math.max(...controlWinRates) - Math.min(...controlWinRates),
  identical: new Set(controls.map((control) => JSON.stringify(control))).size === 1,
  interpretation: "CURRENT is wall-clock-budgeted, so controls from separate runners may differ. Each candidate is normalized only against the control from its own job; direct candidate-vs-parent remains the primary comparison.",
};

const byHead = {};
for (const head of ["value_head", "score_head"]) {
  const selected = rows.filter((row) => row.copiedHeads.includes(head));
  byHead[head] = {
    variants: selected.map((row) => row.name),
    meanParentHeadToHeadWinRate:
      mean(selected.map((row) => row.parentHeadToHead.winRate)),
    meanCurrentWinRate:
      mean(selected.map((row) => row.currentVeryHard.winRate)),
    meanCurrentDeltaVsPairedControl:
      mean(selected.map((row) => row.currentWinRateDeltaVsPairedControl)),
    meanCaptureLossDeltaVsPairedControl:
      mean(selected.map((row) => row.captureLossRateDeltaVsPairedControl)),
  };
}

let likelyCulprit = "MIXED_OR_INCONCLUSIVE";
const valueDelta = byHead.value_head.meanCurrentDeltaVsPairedControl;
const scoreDelta = byHead.score_head.meanCurrentDeltaVsPairedControl;
if (valueDelta <= -0.05 && scoreDelta >= 0) likelyCulprit = "VALUE_HEAD";
else if (scoreDelta <= -0.05 && valueDelta >= 0) likelyCulprit = "SCORE_HEAD";
else if (valueDelta <= -0.05 && scoreDelta <= -0.05) {
  likelyCulprit = "BOTH_HEADS_OR_SHARED_TARGETS";
}

const promisingRows = rows.filter(
  (row) => row.status === "PROMISING_FOR_INDEPENDENT_128_DIAGNOSTIC",
);
const recommendation = promisingRows.length > 0
  ? `RUN_INDEPENDENT_128_${promisingRows[0].name.toUpperCase().replaceAll("-", "_")}`
  : "STOP_M38_ABLATION_AND_REDESIGN_SEARCH_ALIGNED_TARGETS";
const summary = {
  schemaVersion: 2,
  stage: "M3.8_HEAD_ABLATION_DIAGNOSTIC",
  sourceBuild: {
    commitSha: build.commitSha,
    parentCheckpointSha256: build.parent?.checkpointSha256,
  },
  gamesPerComparison: 32,
  controlDiagnostics,
  variants: rows,
  aggregateByHead: byHead,
  likelyCulprit,
  recommendation,
  interpretationLimits: [
    "This is a diagnostic multiple-comparison screen, not an official smoke/development/promotion gate.",
    "CURRENT uses a wall-clock budget; cross-runner control equality is not a valid deterministic contract.",
    "Direct candidate-vs-parent is primary; candidate-vs-CURRENT is interpreted as a within-job delta from its paired control.",
    "No variant may be merged or promoted from 32-game evidence.",
    "A favorable variant requires an independent 128-game diagnostic before any fresh official pipeline.",
  ],
  acceptance: {
    buildAccepted: true,
    fourVariantsPresent: rows.length === 4,
    allArenaContractsPassed: true,
    pairedControlRecordedPerVariant: controls.length === 4,
    controlVarianceExplicitlyReported: Number.isFinite(controlDiagnostics.spread),
    noTrainingOrCheckpointMutationDuringArena: true,
    passed: rows.length === 4 && controls.length === 4,
  },
};
const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ recommendation, likelyCulprit, controlSpread: controlDiagnostics.spread, variants: rows.map((row) => ({
  name: row.name,
  parent: row.parentHeadToHead.winRate,
  current: row.currentVeryHard.winRate,
  currentDelta: row.currentWinRateDeltaVsPairedControl,
  status: row.status,
})) }));
