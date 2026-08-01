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
const phase = options.phase ?? "smoke";
if (!options.training || !options.regression || !options.arena || !options.output) {
  throw new Error("--training, --regression, --arena and --output are required");
}
const training = readJson(options.training);
const regression = readJson(options.regression);
const arena = readJson(options.arena);
const development = options.development ? readJson(options.development) : null;

const parent = arena.comparisons?.CANDIDATE_IMPROVED_VS_PARENT_IMPROVED;
const current = arena.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT;
const parentVsCurrent = arena.comparisons?.PARENT_IMPROVED_VS_CURRENT ?? null;
if (!parent || !current) throw new Error(`Missing required M3.7 arena comparisons for ${phase}`);

const selectedEpoch = Number(training.selected_epoch ?? 0);
const improved = Boolean(training.improved_over_parent) && selectedEpoch > 0;
const leagueParent = Number(training.parent?.freshLeagueValidation?.loss);
const leagueSelected = Number(training.selected?.freshLeagueValidation?.loss);
const leagueImproved = Number.isFinite(leagueParent)
  && Number.isFinite(leagueSelected)
  && leagueSelected < leagueParent;
const tacticalFailures = Number(
  training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0,
) + Number(regression.failures ?? 0);
const technical = Boolean(training.acceptance?.passed)
  && Boolean(regression.passed)
  && Boolean(arena.acceptance?.passed)
  && improved
  && leagueImproved
  && tacticalFailures === 0;

const reasons = [];
if (!training.acceptance?.passed) reasons.push("training_contract_failed");
if (!regression.passed) reasons.push("fallback_regression_failed");
if (!arena.acceptance?.passed) reasons.push("arena_contract_failed");
if (!improved) reasons.push("selector_retained_m341_parent");
if (!leagueImproved) reasons.push("fresh_league_validation_not_improved");
if (tacticalFailures !== 0) reasons.push("tactical_regression_detected");

let passed = false;
let captureNonRegression = true;
const baselineCapture = parentVsCurrent?.captureLossRate
  ?? development?.comparisons?.PARENT_IMPROVED_VS_CURRENT?.captureLossRate
  ?? null;
if (baselineCapture !== null) {
  captureNonRegression = current.captureLossRate <= baselineCapture + 0.05;
}

if (phase === "smoke") {
  const parentPoint = parent.winRate >= 0.5;
  const currentFloor = current.winRate >= 0.45;
  if (!parentPoint) reasons.push("candidate_point_estimate_below_parent");
  if (!currentFloor) reasons.push("current_smoke_floor_not_met");
  if (!captureNonRegression) reasons.push("capture_loss_regression");
  passed = technical && parentPoint && currentFloor && captureNonRegression;
} else if (phase === "development") {
  const enoughGames = parent.games >= 128 && current.games >= 128;
  const parentLower = parent.wilson95.low > 0.5;
  const currentFloor = current.winRate >= 0.5;
  if (!enoughGames) reasons.push("minimum_128_games_not_met");
  if (!parentLower) reasons.push("parent_wilson_lower_not_above_50_percent");
  if (!currentFloor) reasons.push("current_development_floor_not_met");
  if (!captureNonRegression) reasons.push("capture_loss_regression");
  passed = technical && enoughGames && parentLower && currentFloor && captureNonRegression;
} else if (phase === "promotion") {
  const enoughGames = parent.games >= 400 && current.games >= 400;
  const parentLower = parent.wilson95.low > 0.5;
  const parentPoint = parent.winRate >= 0.525;
  const currentPoint = current.winRate >= 0.55;
  const strictCapture = baselineCapture === null
    || current.captureLossRate <= baselineCapture + 0.02;
  if (!enoughGames) reasons.push("minimum_400_games_not_met");
  if (!parentLower) reasons.push("parent_wilson_lower_not_above_50_percent");
  if (!parentPoint) reasons.push("parent_52_5_percent_threshold_not_met");
  if (!currentPoint) reasons.push("current_55_percent_threshold_not_met");
  if (!strictCapture) reasons.push("capture_loss_regression");
  passed = technical && enoughGames && parentLower && parentPoint && currentPoint && strictCapture;
  captureNonRegression = strictCapture;
} else {
  throw new Error(`Unknown M3.7 phase ${phase}`);
}

const summary = {
  schemaVersion: 1,
  stage: `M3.7_${phase.toUpperCase()}_GATE`,
  phase,
  passed,
  reasons,
  technical,
  checkpointSelection: {
    selectedEpoch,
    improvedOverParent: improved,
    behaviorEquivalentToParent: Boolean(training.behaviorEquivalentToParent),
    trainableScope: training.trainableScope,
    parentFreshLeagueLoss: leagueParent,
    selectedFreshLeagueLoss: leagueSelected,
    freshLeagueImproved: leagueImproved,
  },
  regressions: {
    fallback: Number(regression.failures ?? 0),
    frozenTactical: Number(
      training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0,
    ),
    total: tacticalFailures,
  },
  parentHeadToHead: parent,
  currentVeryHard: current,
  parentVsCurrent,
  captureRegression: {
    baseline: baselineCapture,
    candidate: current.captureLossRate,
    passed: captureNonRegression,
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
