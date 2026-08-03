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

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const options = parseArgs();
if (!options.source || !options.build || !options.arena || !options.output) {
  throw new Error("--source, --build, --arena and --output are required");
}

const source = readJson(options.source);
const build = readJson(options.build);
const arena = readJson(options.arena);
const sourceVariant = source.variants?.find((variant) => variant.name === "e1-score-only");
const buildVariant = build.variants?.find((variant) => variant.name === "e1-score-only");
const parent = arena.comparisons?.CANDIDATE_IMPROVED_VS_PARENT_IMPROVED;
const current = arena.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT;
const parentVsCurrent = arena.comparisons?.PARENT_IMPROVED_VS_CURRENT;

if (!sourceVariant || !buildVariant) {
  throw new Error("Missing e1-score-only source variant");
}
if (!parent || !current || !parentVsCurrent) {
  throw new Error("Missing required improved-mode comparisons in M3.8.1 arena");
}

const sourceScreenAccepted = Boolean(source.acceptance?.passed)
  && source.recommendation === "RUN_INDEPENDENT_128_E1_SCORE_ONLY"
  && source.likelyCulprit === "VALUE_HEAD"
  && sourceVariant.status === "PROMISING_FOR_INDEPENDENT_128_DIAGNOSTIC"
  && sourceVariant.sourceEpoch === 1
  && sameArray(sourceVariant.copiedHeads, ["score_head"]);
const buildAccepted = Boolean(build.acceptance?.passed)
  && Boolean(buildVariant.acceptance?.passed)
  && buildVariant.sourceEpoch === 1
  && sameArray(buildVariant.copiedHeads, ["score_head"])
  && buildVariant.changedKeyCount === 7
  && buildVariant.changedKeys?.every((key) => key.startsWith("score_head."))
  && buildVariant.checkpointSha256 === sourceVariant.checkpointSha256
  && build.parent?.checkpointSha256 === source.sourceBuild?.parentCheckpointSha256;
const sourceAccepted = sourceScreenAccepted && buildAccepted;
const enoughGames = parent.games >= 128 && current.games >= 128 && parentVsCurrent.games >= 128;
const parentPointAtLeastEven = parent.winRate >= 0.5;
const parentWilsonAboveHalf = parent.wilson95?.low > 0.5;
const currentAtLeastHalf = current.winRate >= 0.5;
const currentDeltaVsPairedControl = current.winRate - parentVsCurrent.winRate;
const currentNonRegression = currentDeltaVsPairedControl >= -0.05;
const captureDeltaVsPairedControl = current.captureLossRate - parentVsCurrent.captureLossRate;
const captureNonRegression = captureDeltaVsPairedControl <= 0.05;
const wouldJustifyFreshOfficialPipeline = sourceAccepted
  && enoughGames
  && parentWilsonAboveHalf
  && currentAtLeastHalf
  && currentNonRegression
  && captureNonRegression;

let recommendation;
if (wouldJustifyFreshOfficialPipeline) {
  recommendation = "PROMISING_DIAGNOSTIC_ONLY_RERUN_FRESH_OFFICIAL_SCORE_ONLY_PIPELINE";
} else if (
  !sourceAccepted
  || !enoughGames
  || parent.winRate < 0.5
  || currentDeltaVsPairedControl < -0.05
  || !captureNonRegression
) {
  recommendation = "STOP_M381_SCORE_ONLY";
} else {
  recommendation = "INCONCLUSIVE_KEEP_UNMERGED";
}

const summary = {
  schemaVersion: 1,
  stage: "M3.8.1_E1_SCORE_ONLY_128_GAME_DIAGNOSTIC",
  diagnosticOnly: true,
  changesPromotionState: false,
  recommendation,
  source: {
    sourceRecommendation: source.recommendation,
    sourceLikelyCulprit: source.likelyCulprit,
    sourceVariantStatus: sourceVariant.status,
    sourceEpoch: buildVariant.sourceEpoch,
    copiedHeads: buildVariant.copiedHeads,
    changedKeyCount: buildVariant.changedKeyCount,
    candidateCheckpointSha256: buildVariant.checkpointSha256,
    parentCheckpointSha256: build.parent?.checkpointSha256,
    sourceScreenAccepted,
    buildAccepted,
    sourceAccepted,
  },
  checks: {
    enoughGames,
    parentPointAtLeastEven,
    parentWilsonAboveHalf,
    currentAtLeastHalf,
    currentNonRegression,
    captureNonRegression,
    wouldJustifyFreshOfficialPipeline,
  },
  comparisons: {
    candidateVsParent: parent,
    candidateVsCurrent: current,
    parentVsCurrent,
  },
  deltas: {
    candidateCurrentWinRateMinusPairedParentCurrentWinRate: currentDeltaVsPairedControl,
    candidateCurrentCaptureLossRateMinusPairedParentCurrentCaptureLossRate:
      captureDeltaVsPairedControl,
    candidateCurrentSeatGapMinusPairedParentCurrentSeatGap:
      current.absoluteSeatWinRateGap - parentVsCurrent.absoluteSeatWinRateGap,
  },
  sourceScreen: {
    candidateVsParent: sourceVariant.parentHeadToHead,
    candidateVsCurrent: sourceVariant.currentVeryHard,
    parentVsCurrent: sourceVariant.parentVsCurrent,
  },
  interpretationLimits: [
    "This is an independent diagnostic of one fixed checkpoint, not an official smoke/development/promotion gate.",
    "The checkpoint is not retrained, interpolated, or modified during this run.",
    "A favorable result authorizes only a fresh official score-only pipeline; it does not authorize promotion or merge.",
    "An unfavorable result stops the M3.8 score-only continuation and leaves M3.4.1 shipped.",
  ],
};

const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
