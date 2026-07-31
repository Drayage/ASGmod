import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function argsMap(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    result[key] = rest.join("=");
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const args = argsMap(process.argv.slice(2));
const phase = args.phase ?? "smoke";
const training = readJson(args.training);
const mining = readJson(args.mining);
const regression = readJson(args.regression);
const arena = readJson(args.arena);
const sourceDevelopment = args["source-development"] ? readJson(args["source-development"]) : null;
const output = resolve(args.output ?? `katacat-m342-gates/${phase}.json`);

const parent = arena.parentM341;
const current = arena.currentVeryHard;
const generalNotWorse = training.best_validation_loss <= training.parent_validation_loss + 1e-9;
const tacticalRegressions = Number(
  training.selected?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0,
);
const precollapseRegressions = Number(
  training.selected?.frozenPrecollapseValidation?.valueSignRegressionsVsParent ?? 0,
);
const technical = Boolean(
  training.acceptance?.passed
  && mining.acceptance?.passed
  && regression.passed
  && regression.failures === 0
  && arena.acceptance?.passed
  && generalNotWorse
  && tacticalRegressions === 0
  && precollapseRegressions === 0,
);
const sourceParentCurrent = sourceDevelopment?.comparisons?.PARENT_IMPROVED_VS_CURRENT ?? null;
const captureRegressionLimit = sourceParentCurrent
  ? Number(sourceParentCurrent.captureLossRate) + 0.05
  : 1;
const captureRegressionFree = Number(current.captureLossRate) <= captureRegressionLimit;

const reasons = [];
let passed = technical;
if (!technical) reasons.push("technical-or-regression-contract-failed");

if (phase === "smoke") {
  if (parent.winRate < 0.5) {
    passed = false;
    reasons.push("smoke-parent-point-estimate-below-50-percent");
  }
  if (current.winRate < 0.45) {
    passed = false;
    reasons.push("smoke-current-point-estimate-below-45-percent");
  }
} else if (phase === "development") {
  if (parent.wilson95.low <= 0.5) {
    passed = false;
    reasons.push("development-parent-wilson-lower-bound-not-above-50-percent");
  }
  if (current.winRate < 0.55) {
    passed = false;
    reasons.push("development-current-point-estimate-below-55-percent");
  }
  if (!captureRegressionFree) {
    passed = false;
    reasons.push("development-current-capture-loss-regression");
  }
} else if (phase === "promotion") {
  if (parent.games < 400 || current.games < 400) {
    passed = false;
    reasons.push("promotion-needs-400-games-per-opponent");
  }
  if (parent.wilson95.low <= 0.5) {
    passed = false;
    reasons.push("promotion-parent-wilson-lower-bound-not-above-50-percent");
  }
  if (parent.winRate < 0.525) {
    passed = false;
    reasons.push("promotion-parent-point-estimate-below-52.5-percent");
  }
  if (current.winRate < 0.55) {
    passed = false;
    reasons.push("promotion-current-point-estimate-below-55-percent");
  }
  if (!captureRegressionFree) {
    passed = false;
    reasons.push("promotion-current-capture-loss-regression");
  }
} else {
  throw new Error(`Unsupported M3.4.2 gate phase: ${phase}`);
}

const report = {
  schemaVersion: 1,
  stage: `M3.4.2_${phase.toUpperCase()}_GATE`,
  phase,
  passed,
  reasons,
  technical,
  checkpointSelection: {
    parentValidationLoss: training.parent_validation_loss,
    selectedValidationLoss: training.best_validation_loss,
    selectedEpoch: training.selected_epoch,
    improvedOverParent: training.improved_over_parent,
    parentPrecollapseValueLoss: training.parent_precollapse_value_loss,
    selectedPrecollapseValueLoss: training.best_precollapse_value_loss,
  },
  regressions: {
    fallback: regression.failures,
    tactical: tacticalRegressions,
    precollapseValueSign: precollapseRegressions,
  },
  parentHeadToHead: parent,
  currentVeryHard: current,
  captureRegression: {
    sourceParentImprovedRate: sourceParentCurrent?.captureLossRate ?? null,
    allowedMaximum: captureRegressionLimit,
    candidateRate: current.captureLossRate,
    passed: captureRegressionFree,
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `passed=${passed ? "true" : "false"}\n`);
}
console.log(JSON.stringify(report, null, 2));
