import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function args() {
  const parsed = {};
  for (const token of process.argv.slice(2)) {
    const match = token.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const options = args();
if (!options.training || !options.determinism || !options.regression || !options.root || !options.output) {
  throw new Error("--training, --determinism, --regression, --root and --output are required");
}

const training = readJson(options.training);
const determinism = readJson(options.determinism);
const regression = readJson(options.regression);
const root = resolve(options.root);
const candidates = [];
for (const candidate of training.diagnostic_candidates ?? []) {
  const arenaPath = resolve(root, candidate.id, "arena-summary.json");
  const arena = readJson(arenaPath);
  const sameAsParent = candidate.sha256 === training.parent_checkpoint_sha256;
  candidates.push({
    id: candidate.id,
    epoch: candidate.epoch,
    roles: candidate.roles ?? [],
    checkpointPath: candidate.path,
    checkpointSha256: candidate.sha256,
    sameAsParent,
    validation: {
      generalValueLoss: candidate.generalValueLoss,
      balancedValueLoss: candidate.balancedValueLoss,
      readerPairMargin: candidate.readerPairMargin,
      readerPairAccuracy: candidate.readerPairAccuracy ?? null,
      eligible: candidate.eligible,
    },
    vsParent: arena.parentM341,
    vsCurrent: arena.currentVeryHard,
    agent: arena.agents?.CANDIDATE ?? null,
    lossReplayCount: arena.lossReplayCount,
    arenaAcceptance: arena.acceptance,
  });
}

const parent = candidates.find((candidate) => candidate.sameAsParent && candidate.epoch === 0) ?? null;
const trained = candidates.filter((candidate) => candidate.epoch > 0);
const promising = trained.filter((candidate) =>
  candidate.vsParent.winRate > 0.5
  && candidate.vsCurrent.winRate >= 0.45
  && candidate.vsParent.captureLossRate <= 0.5
);

const technical = Boolean(training.acceptance?.passed)
  && Boolean(determinism.acceptance?.passed)
  && Boolean(regression.passed)
  && candidates.length >= 2
  && candidates.every((candidate) => candidate.arenaAcceptance?.passed === true);

const recommendation = promising.length > 0
  ? "CONTINUE_VALUE_HEAD_ONLY_WITH_PROMISING_REJECTED_EPOCH"
  : "STOP_VALUE_HEAD_ONLY_AND_RETURN_TO_POLICY_TRUNK_TRAINING";
const reasons = [];
if (!technical) reasons.push("technical_diagnostic_failure");
if (promising.length === 0) reasons.push("no_rejected_epoch_has_positive_diagnostic_signal");
if (training.selected_epoch === 0) reasons.push("strict_selection_retained_parent_epoch_zero");

const summary = {
  schemaVersion: 1,
  stage: "M3.4.3.1_DIAGNOSTIC_SUMMARY",
  commit_sha: training.commit_sha,
  technical,
  diagnosticPassed: technical,
  recommendation,
  reasons,
  checkpointSelection: {
    selectedEpoch: training.selected_epoch,
    improvedOverParent: training.improved_over_parent,
    bestGeneralEpoch: training.best_general_epoch,
    bestBalancedEpoch: training.best_balanced_epoch,
    bestReaderEpoch: training.best_reader_epoch,
    finalEpoch: training.final_epoch,
  },
  deterministicCore: {
    passed: determinism.acceptance?.passed === true,
    fixedPositions: determinism.fixedPositions,
    neuralMaxAbsDelta: determinism.neuralMaxAbsDelta,
    actionMismatches: determinism.actionMismatches,
    visitMismatches: determinism.visitMismatches,
    decisionSuiteHash: determinism.decisionSuiteHash,
    caveat: "The exact audit excludes the wall-clock-bounded tactical reader. Live candidate/parent collapse rates are not treated as paired-state regressions.",
  },
  fallbackRegression: {
    cases: regression.cases,
    failures: regression.failures,
    passed: regression.passed,
  },
  parentReference: parent,
  candidates,
  promisingCandidates: promising.map((candidate) => candidate.id),
  interpretation: {
    sameShaHeadToHeadIsSanityOnly: true,
    unmatchedLiveCollapseRatesAreNotRegressionEvidence: true,
    sixteenGameResultsAreDiagnosticNotPromotionEvidence: true,
    noRandomRollouts: true,
  },
};

const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (!technical) process.exitCode = 1;
