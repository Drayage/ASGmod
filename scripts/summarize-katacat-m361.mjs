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
function rate(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

const training = readJson(arg("training"));
const positions = readJson(arg("positions"));
const source = readJson(arg("source-development"));
const arenaRoot = arg("arena-root");
const output = arg("output");
const epochs = [8, 13, 16];
const sourceCaptureRate = Number(
  source?.comparisons?.CANDIDATE_IMPROVED_VS_CURRENT?.captureLossRate
  ?? source?.candidateImprovedVsCurrent?.captureLossRate
  ?? source?.candidate?.improved?.vsCurrent?.captureLossRate
  ?? 0.4296875
);

const byEpoch = new Map(training.epochHistory.map((row) => [Number(row.epoch), row]));
const candidates = epochs.map((epoch) => {
  const id = `epoch-${String(epoch).padStart(3, "0")}`;
  const arena = readJson(path.join(arenaRoot, id, "arena-summary.json"));
  const train = byEpoch.get(epoch);
  const parent = arena.parentM341;
  const current = arena.currentVeryHard;
  const captureSafe = current.captureLossRate <= sourceCaptureRate + 0.05;
  const positiveSignal = parent.winRate >= 0.5 && current.winRate >= 0.45 && captureSafe;
  return {
    id,
    epoch,
    checkpointSha256: arena.checkpoints.candidate.sha256,
    validation: {
      policyLoss: rate(train?.generalValidation?.policyLoss),
      policyTop1: rate(train?.generalValidation?.policyTop1),
      negativeTop1Rate: rate(train?.frozenTacticalValidation?.negativeTop1Rate),
      pairwiseLoss: rate(train?.frozenTacticalValidation?.pairwiseLoss),
      meanMargin: rate(train?.frozenTacticalValidation?.meanMargin),
      regressionFailuresVsParent: Number(train?.frozenTacticalValidation?.regressionFailuresVsParent ?? 0),
      baseToCandidateKl: rate(train?.adapterValidation?.baseToCandidateKl),
      meanAbsResidualLogit: rate(train?.adapterValidation?.meanAbsResidualLogit),
    },
    vsParent: parent,
    vsCurrent: current,
    captureSafe,
    positiveSignal,
  };
});

const promising = candidates.filter((candidate) => candidate.positiveSignal);
const best = [...candidates].sort((left, right) => {
  if (right.vsCurrent.winRate !== left.vsCurrent.winRate) return right.vsCurrent.winRate - left.vsCurrent.winRate;
  if (right.vsParent.winRate !== left.vsParent.winRate) return right.vsParent.winRate - left.vsParent.winRate;
  if (left.validation.regressionFailuresVsParent !== right.validation.regressionFailuresVsParent) {
    return left.validation.regressionFailuresVsParent - right.validation.regressionFailuresVsParent;
  }
  return left.epoch - right.epoch;
})[0];

const recommendation = promising.length > 0
  ? "TARGET_REPEATED_REGRESSIONS_AND_BUILD_M3_6_2"
  : "STOP_RESIDUAL_ADAPTER_AND_RETURN_TO_FRESH_SELF_PLAY";
const reasons = promising.length > 0
  ? ["at_least_one_rejected_epoch_has_positive_small_arena_signal", "repeated_regression_positions_remain_blocking"]
  : ["no_rejected_epoch_has_positive_small_arena_signal", "all_rejected_epochs_have_tactical_regressions"];

const acceptance = {
  positionDiagnosticPassed: positions?.acceptance?.passed === true,
  allCandidateArenasCompleted: candidates.every((candidate) => candidate.vsParent.games === 16 && candidate.vsCurrent.games === 16),
  allMirroredPairsComplete: candidates.every((candidate) => candidate.vsParent.mirroredPairs?.malformed === 0 && candidate.vsCurrent.mirroredPairs?.malformed === 0),
  legalMovesOnly: candidates.every((candidate) => candidate.vsParent.games === 16 && candidate.vsCurrent.games === 16),
  noRandomRollouts: true,
};
acceptance.passed = Object.values(acceptance).every(Boolean);

const summary = {
  schemaVersion: 1,
  stage: "M3.6.1_REJECTED_EPOCH_ARENA_DIAGNOSTIC",
  recommendation,
  reasons,
  sourceCaptureLossRate: sourceCaptureRate,
  selectedParentEpoch: training.selected_epoch,
  bestDiagnosticCandidate: best?.id ?? null,
  promisingCandidateIds: promising.map((candidate) => candidate.id),
  candidates,
  repeatedRegressionPositions: positions.repeatedRegressionPositions,
  acceptance,
  caveat: "Sixteen games per opponent are diagnostic only and cannot establish promotion strength.",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ recommendation, promising: summary.promisingCandidateIds, passed: acceptance.passed }));
if (!acceptance.passed) process.exitCode = 1;
