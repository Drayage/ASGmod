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
function readJson(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function collapseRate(agent) { return Number(agent?.allRootActionsRefuted ?? 0) / Math.max(1, Number(agent?.decisions ?? 0)); }

const options = parseArgs();
const required = ["phase", "training", "mining", "regression", "arena", "source-development", "output"];
for (const key of required) if (!options[key]) throw new Error(`--${key} is required`);
const phase = options.phase;
const training = readJson(options.training);
const mining = readJson(options.mining);
const regression = readJson(options.regression);
const arena = readJson(options.arena);
const sourceDevelopment = readJson(options["source-development"]);
const parent = arena.parentM341;
const current = arena.currentVeryHard;
if (!parent || !current) throw new Error(`Missing M3.4.3 comparisons for ${phase}`);

const selected = training.selected ?? {};
const technical = Boolean(training.acceptance?.passed)
  && Boolean(mining.acceptance?.passed)
  && Boolean(regression.passed)
  && Boolean(arena.acceptance?.passed)
  && Boolean(training.acceptance?.valueHeadOnlyTrainable)
  && Boolean(training.acceptance?.nonValueParameterHashUnchanged)
  && Boolean(training.acceptance?.policyScoreOwnershipOutputsUnchanged)
  && Number(selected.readerPairValidation?.rankingRegressionsVsParent ?? 0) === 0;

const candidateCollapseRate = collapseRate(arena.agents?.CANDIDATE);
const parentCollapseRate = collapseRate(arena.agents?.PARENT);
const collapseNotWorse = candidateCollapseRate <= parentCollapseRate + 0.02;
const sourceCapture = Number(
  sourceDevelopment.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT?.captureLossRate
  ?? sourceDevelopment.currentVeryHard?.captureLossRate
  ?? 1,
);
const captureNotWorse = Number(current.captureLossRate) <= sourceCapture + 0.02;
const reasons = [];
if (!technical) reasons.push("technical_or_validation_gate_failed");
if (!collapseNotWorse) reasons.push("all_root_refuted_rate_regression");
let passed = false;

if (phase === "smoke") {
  if (parent.winRate < 0.5) reasons.push("smoke_parent_point_estimate_below_50_percent");
  if (current.winRate < 0.45) reasons.push("smoke_current_point_estimate_below_45_percent");
  passed = technical && collapseNotWorse && parent.winRate >= 0.5 && current.winRate >= 0.45;
} else if (phase === "development") {
  if (parent.wilson95.low <= 0.5) reasons.push("parent_wilson_lower_not_above_50_percent");
  if (current.winRate < 0.55) reasons.push("current_55_percent_threshold_not_met");
  if (!captureNotWorse) reasons.push("capture_loss_regression");
  passed = technical && collapseNotWorse && parent.wilson95.low > 0.5
    && current.winRate >= 0.55 && captureNotWorse;
} else if (phase === "promotion") {
  const enoughGames = parent.games >= 400 && current.games >= 400;
  if (!enoughGames) reasons.push("minimum_400_games_not_met");
  if (parent.wilson95.low <= 0.5) reasons.push("parent_wilson_lower_not_above_50_percent");
  if (parent.winRate < 0.525) reasons.push("parent_52_5_percent_threshold_not_met");
  if (current.winRate < 0.55) reasons.push("current_55_percent_threshold_not_met");
  if (!captureNotWorse) reasons.push("capture_loss_regression");
  passed = technical && collapseNotWorse && enoughGames && parent.wilson95.low > 0.5
    && parent.winRate >= 0.525 && current.winRate >= 0.55 && captureNotWorse;
} else {
  throw new Error(`Unknown phase ${phase}`);
}

const summary = {
  schemaVersion: 1,
  stage: `M3.4.3_${phase.toUpperCase()}_GATE`,
  phase,
  passed,
  reasons,
  technical,
  checkpointSelection: {
    selectedEpoch: training.selected_epoch,
    improvedOverParent: training.improved_over_parent,
    trainableScope: training.trainableScope,
    parentGeneralValueLoss: training.parent?.generalValidation?.valueLoss,
    selectedGeneralValueLoss: selected.generalValidation?.valueLoss,
    parentBalancedValueLoss: training.parent?.balancedTerminalValidation?.valueLoss,
    selectedBalancedValueLoss: selected.balancedTerminalValidation?.valueLoss,
    parentPairMargin: training.parent?.readerPairValidation?.meanMargin,
    selectedPairMargin: selected.readerPairValidation?.meanMargin,
  },
  regressions: {
    fallback: Number(regression.failures ?? 0),
    readerPairRanking: Number(selected.readerPairValidation?.rankingRegressionsVsParent ?? 0),
    nonValueParametersChanged: !Boolean(training.acceptance?.nonValueParameterHashUnchanged),
  },
  collapseRate: {
    candidate: candidateCollapseRate,
    parent: parentCollapseRate,
    allowedMaximum: parentCollapseRate + 0.02,
    passed: collapseNotWorse,
  },
  captureRegression: {
    sourceM341CurrentRate: sourceCapture,
    candidateRate: current.captureLossRate,
    allowedMaximum: sourceCapture + 0.02,
    passed: captureNotWorse,
  },
  parentHeadToHead: parent,
  currentVeryHard: current,
};
const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `passed=${passed ? "true" : "false"}\nreasons=${reasons.join(",")}\n`, { flag: "a" });
}
console.log(JSON.stringify(summary));
