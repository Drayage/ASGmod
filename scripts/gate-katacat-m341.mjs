import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function args() {
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

function rate(stats) {
  return stats.unverifiedFallbacks / Math.max(1, stats.decisions);
}

const options = args();
const phase = options.phase ?? "smoke";
if (!options.training || !options.regression || !options.arena || !options.output) {
  throw new Error("--training, --regression, --arena and --output are required");
}
const training = readJson(options.training);
const regression = readJson(options.regression);
const arena = readJson(options.arena);
const development = options.development ? readJson(options.development) : null;

const h2h = arena.comparisons.CANDIDATE_IMPROVED_VS_PARENT_IMPROVED;
const vsCurrent = arena.comparisons.CANDIDATE_IMPROVED_VS_CURRENT;
if (!h2h || !vsCurrent) throw new Error(`Missing required comparisons for ${phase}`);

const generalNotWorse = Number(training.best_validation_loss)
  <= Number(training.parent_validation_loss) + 1e-9;
const tacticalFailures = Number(
  training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0,
) + Number(regression.failures ?? 0);
const technical = Boolean(training.acceptance?.passed)
  && Boolean(regression.passed)
  && Boolean(arena.acceptance?.passed)
  && generalNotWorse
  && tacticalFailures === 0;

const candidateOldRate = arena.agents.CANDIDATE_OLD ? rate(arena.agents.CANDIDATE_OLD) : null;
const candidateImprovedRate = arena.agents.CANDIDATE_IMPROVED
  ? rate(arena.agents.CANDIDATE_IMPROVED)
  : null;
const fallbackNotWorse = candidateOldRate === null
  || candidateImprovedRate <= candidateOldRate + 1e-12;

let passed = false;
const reasons = [];
if (!technical) reasons.push("technical_or_validation_gate_failed");

if (phase === "smoke") {
  const parentPointNotWorse = h2h.winRate >= 0.5;
  if (!parentPointNotWorse) reasons.push("candidate_improved_point_estimate_below_parent");
  if (!fallbackNotWorse) reasons.push("improved_fallback_rate_worse_than_old_fallback");
  passed = technical && parentPointNotWorse && fallbackNotWorse;
} else if (phase === "development") {
  const parentLowerAboveHalf = h2h.wilson95.low > 0.5;
  if (!parentLowerAboveHalf) reasons.push("parent_wilson_lower_not_above_50_percent");
  passed = technical && parentLowerAboveHalf;
} else if (phase === "promotion") {
  const enoughGames = h2h.games >= 400 && vsCurrent.games >= 400;
  const parentLowerAboveHalf = h2h.wilson95.low > 0.5;
  const parentPointThreshold = h2h.winRate >= 0.525;
  const currentPointThreshold = vsCurrent.winRate >= 0.55;
  let captureNonRegression = true;
  if (development?.comparisons?.PARENT_IMPROVED_VS_CURRENT) {
    const parentCapture = development.comparisons.PARENT_IMPROVED_VS_CURRENT.captureLossRate;
    captureNonRegression = vsCurrent.captureLossRate <= parentCapture + 0.02;
  }
  if (!enoughGames) reasons.push("minimum_400_games_not_met");
  if (!parentLowerAboveHalf) reasons.push("parent_wilson_lower_not_above_50_percent");
  if (!parentPointThreshold) reasons.push("parent_point_threshold_not_met");
  if (!currentPointThreshold) reasons.push("current_55_percent_threshold_not_met");
  if (!captureNonRegression) reasons.push("capture_loss_regression");
  passed = technical
    && enoughGames
    && parentLowerAboveHalf
    && parentPointThreshold
    && currentPointThreshold
    && captureNonRegression;
} else {
  throw new Error(`Unknown phase ${phase}`);
}

const summary = {
  schemaVersion: 1,
  stage: `M3.4.1_${phase.toUpperCase()}_GATE`,
  phase,
  passed,
  reasons,
  technical,
  generalValidation: {
    parent: training.parent_validation_loss,
    selected: training.best_validation_loss,
    notWorse: generalNotWorse,
    selectedEpoch: training.selected_epoch,
    improvedOverParent: training.improved_over_parent,
  },
  tacticalRegressionFailures: tacticalFailures,
  parentHeadToHead: h2h,
  currentVeryHard: vsCurrent,
  fallbackRates: {
    candidateOld: candidateOldRate,
    candidateImproved: candidateImprovedRate,
    improvedNotWorse: fallbackNotWorse,
  },
};
const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `passed=${passed ? "true" : "false"}\nreasons=${reasons.join(",")}\n`,
    { flag: "a" },
  );
}
console.log(JSON.stringify(summary));
