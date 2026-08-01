import fs from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

const phase = arg("phase", "smoke");
const training = readJson(arg("training"));
const regression = readJson(arg("regression"));
const arena = readJson(arg("arena"));
const source = readJson(arg("source-development"));
const output = arg("output");
const parent = arena.parentM341;
const current = arena.currentVeryHard;
const reasons = [];
const parentBehavior = training?.behaviorEquivalentToParent === true;
const sourceCaptureRate = Number(
  source?.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT?.captureLossRate
  ?? source?.candidateImprovedVsCurrent?.captureLossRate
  ?? source?.candidate?.improved?.vsCurrent?.captureLossRate
  ?? 0.4296875
);
const captureAllowance = phase === "smoke" ? 0.05 : 0.02;
const allowedCaptureRate = sourceCaptureRate + captureAllowance;
const targeted = training?.selected?.targetedRegressionFixtures;
const untouched = training?.selected?.untouchedTacticalValidation;
const targetedPassed = targeted?.passed === true || parentBehavior;
const technical = training?.acceptance?.passed === true
  && regression?.passed === true
  && arena?.acceptance?.passed === true
  && training?.acceptance?.baseModelFrozen === true
  && training?.acceptance?.threeTargetedRegressionFixturesResolved === true
  && training?.acceptance?.guardGamesExcludedFromUntouchedValidation === true
  && untouched?.regressionFailuresVsParent === 0
  && targetedPassed;

if (!technical) reasons.push("technical_or_targeted_regression_failure");
if (!training?.improved_over_parent) reasons.push("selector_retained_zero_adapter_parent");

if (!parentBehavior) {
  if (phase === "smoke") {
    if (parent.games !== 32 || current.games !== 32) reasons.push("smoke_game_count");
    if (parent.winRate < 0.5) reasons.push("smoke_parent_point_estimate_below_50_percent");
    if (current.winRate < 0.45) reasons.push("smoke_current_point_estimate_below_45_percent");
    if (current.captureLossRate > allowedCaptureRate) reasons.push("smoke_capture_loss_regression");
  } else if (phase === "development") {
    if (parent.games !== 128 || current.games !== 128) reasons.push("development_game_count");
    if (parent.winRate < 0.525) reasons.push("development_parent_below_52_5_percent");
    if (parent.wilson95.low <= 0.5) reasons.push("development_parent_wilson_not_above_50_percent");
    if (current.winRate < 0.55) reasons.push("development_current_below_55_percent");
    if (current.captureLossRate > allowedCaptureRate) reasons.push("development_capture_loss_regression");
  } else if (phase === "promotion") {
    if (parent.games !== 400 || current.games !== 400) reasons.push("promotion_game_count");
    if (parent.winRate < 0.525) reasons.push("promotion_parent_below_52_5_percent");
    if (parent.wilson95.low <= 0.5) reasons.push("promotion_parent_wilson_not_above_50_percent");
    if (current.winRate < 0.55) reasons.push("promotion_current_below_55_percent");
    if (current.captureLossRate > allowedCaptureRate) reasons.push("promotion_capture_loss_regression");
  } else {
    reasons.push("unknown_phase");
  }
}

const passed = reasons.length === 0;
const summary = {
  schemaVersion: 1,
  stage: `M3.6.2_${phase.toUpperCase()}_GATE`,
  phase,
  passed,
  reasons,
  technical,
  parentBehavior,
  zeroAdapterArenaIsSanityOnly: parentBehavior,
  checkpointSelection: {
    selectedEpoch: training.selected_epoch,
    improvedOverParent: training.improved_over_parent,
    seedEpoch: 8,
    trainableScope: training.trainableScope,
    parentPolicyLoss: training?.parent?.adapterValidation?.policyLoss,
    selectedPolicyLoss: training?.selected?.adapterValidation?.policyLoss,
    parentPolicyTop1: training?.parent?.adapterValidation?.policyTop1,
    selectedPolicyTop1: training?.selected?.adapterValidation?.policyTop1,
    selectedKl: training?.selected?.adapterValidation?.baseToCandidateKl,
    selectedMeanResidual: training?.selected?.adapterValidation?.meanAbsResidualLogit,
  },
  targetedRegressionFixtures: targeted,
  untouchedTacticalValidation: untouched,
  regressions: {
    fallback: regression?.failures ?? null,
    untouchedTactical: untouched?.regressionFailuresVsParent ?? null,
    targeted: targeted?.regressionFailuresVsParent ?? null,
  },
  parentHeadToHead: parent,
  currentVeryHard: current,
  captureRegression: {
    evaluated: !parentBehavior,
    sourceM341CurrentRate: sourceCaptureRate,
    allowedMaximum: allowedCaptureRate,
    candidateRate: current.captureLossRate,
    passed: parentBehavior || current.captureLossRate <= allowedCaptureRate,
  },
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
writeOutput("passed", passed ? "true" : "false");
