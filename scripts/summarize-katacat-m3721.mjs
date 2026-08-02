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

const options = parseArgs();
if (!options.training || !options.sourceSmoke || !options.arena || !options.output) {
  throw new Error("--training, --sourceSmoke, --arena and --output are required");
}

const training = readJson(options.training);
const sourceSmoke = readJson(options.sourceSmoke);
const arena = readJson(options.arena);
const parent = arena.comparisons?.CANDIDATE_IMPROVED_VS_PARENT_IMPROVED;
const current = arena.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT;
const parentVsCurrent = arena.comparisons?.PARENT_IMPROVED_VS_CURRENT;
if (!parent || !current || !parentVsCurrent) {
  throw new Error("Missing required improved-mode comparisons in diagnostic arena");
}

const sourceSelectedEpoch = Number(training.selected_epoch ?? 0);
const sourceTechnical = Boolean(training.acceptance?.passed)
  && sourceSelectedEpoch > 0
  && Boolean(training.improved_over_parent)
  && Number(training.selected?.maxPolicyLogitDelta ?? Infinity) === 0
  && Number(training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 1) === 0;
const enoughGames = parent.games >= 128 && current.games >= 128 && parentVsCurrent.games >= 128;
const parentPointAtLeastEven = parent.winRate >= 0.5;
const parentWilsonAboveHalf = parent.wilson95?.low > 0.5;
const currentAtLeastHalf = current.winRate >= 0.5;
const currentDeltaVsParentBaseline = current.winRate - parentVsCurrent.winRate;
const captureNonRegression = current.captureLossRate <= parentVsCurrent.captureLossRate + 0.05;
const wouldMeetDevelopmentMetrics = sourceTechnical
  && enoughGames
  && parentWilsonAboveHalf
  && currentAtLeastHalf
  && captureNonRegression;

let recommendation;
if (wouldMeetDevelopmentMetrics) {
  recommendation = "PROMISING_DIAGNOSTIC_ONLY_RERUN_FRESH_OFFICIAL_PIPELINE";
} else if (
  !sourceTechnical
  || !enoughGames
  || parent.winRate < 0.5
  || currentDeltaVsParentBaseline < -0.05
  || !captureNonRegression
) {
  recommendation = "STOP_M372";
} else {
  recommendation = "INCONCLUSIVE_KEEP_UNMERGED";
}

const summary = {
  schemaVersion: 1,
  stage: "M3.7.2.1_128_GAME_DIAGNOSTIC",
  diagnosticOnly: true,
  changesPromotionState: false,
  recommendation,
  source: {
    selectedEpoch: sourceSelectedEpoch,
    technical: sourceTechnical,
    sourceSmokePassed: Boolean(sourceSmoke.passed),
    sourceSmokeReasons: sourceSmoke.reasons ?? [],
    maxPolicyLogitDelta: Number(training.selected?.maxPolicyLogitDelta),
    frozenTacticalRegressions: Number(
      training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0,
    ),
  },
  checks: {
    enoughGames,
    parentPointAtLeastEven,
    parentWilsonAboveHalf,
    currentAtLeastHalf,
    captureNonRegression,
    wouldMeetDevelopmentMetrics,
  },
  comparisons: {
    candidateVsParent: parent,
    candidateVsCurrent: current,
    parentVsCurrent,
  },
  deltas: {
    candidateCurrentWinRateMinusParentCurrentWinRate: currentDeltaVsParentBaseline,
    candidateCurrentCaptureLossRateMinusParentCurrentCaptureLossRate:
      current.captureLossRate - parentVsCurrent.captureLossRate,
  },
  note: (
    "This is a post-smoke diagnostic using the already selected M3.7.2 checkpoint. "
    + "It does not override the failed smoke gate, promote a model, or authorize a merge."
  ),
};

const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
