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

function readJsonl(path) {
  const text = readFileSync(resolve(path), "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = String(row[key] ?? "UNKNOWN");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

const options = parseArgs();
if (!options.trace || !options.output) {
  throw new Error("--trace and --output are required");
}

const traceDir = resolve(options.trace);
const source = readJson(resolve(traceDir, "summary.json"));
const decisions = readJsonl(resolve(traceDir, "decision-traces.jsonl"));
const pairs = readJsonl(resolve(traceDir, "pairwise-examples.jsonl"));

const exactParent = source.parentCheckpoint?.sha256
  === "9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b";
const safeLockViolations = decisions.filter((decision) => {
  const parent = decision.rootActions?.find((action) => action.selectedByParent);
  return parent?.verificationStatus === "VERIFIED_SAFE"
    && decision.correctionAudit?.actionIndex !== parent.actionIndex;
});
const guardCorrectedRefutedPuct = decisions.filter((decision) => {
  const puct = decision.rootActions?.find((action) => action.selectedByPuct);
  const parent = decision.rootActions?.find((action) => action.selectedByParent);
  return puct
    && parent
    && puct.actionIndex !== parent.actionIndex
    && puct.verificationStatus === "REFUTED"
    && parent.verificationStatus === "VERIFIED_SAFE";
});
const actionablePairs = pairs.filter((pair) =>
  pair.negativeSelectedByPuct
  || pair.negativeRankedAbovePositive
  || pair.pairType === "SAFE_SELECTION_OVER_HIGHER_Q_REFUTED"
  || pair.pairType === "SAFE_SELECTION_OVER_HIGHER_RAW_VALUE_REFUTED"
);
const higherRankPairs = pairs.filter((pair) => pair.negativeRankedAbovePositive);
const higherQPairs = pairs.filter(
  (pair) => pair.pairType === "SAFE_SELECTION_OVER_HIGHER_Q_REFUTED",
);
const higherRawValuePairs = pairs.filter(
  (pair) => pair.pairType === "SAFE_SELECTION_OVER_HIGHER_RAW_VALUE_REFUTED",
);
const rawPuctNegativePairs = pairs.filter((pair) => pair.negativeSelectedByPuct);
const unverifiedFallbacks = decisions.filter(
  (decision) => decision.finalDecision?.fallbackToUnverified,
);
const allRootActionsRefuted = decisions.filter(
  (decision) => decision.finalDecision?.allRootActionsRefuted,
);
const correctionChangedFromPuct = decisions.filter(
  (decision) => decision.correctionAudit?.changedFromPuct,
);
const correctionChangedFromParent = decisions.filter(
  (decision) => decision.correctionAudit?.changed,
);
const correctionMatchesParent = decisions.filter(
  (decision) => decision.correctionAudit?.matchesParent,
);

let recommendation;
if (!source.acceptance?.passed || !exactParent || decisions.length === 0) {
  recommendation = "INVALID_TRACE_DO_NOT_CONTINUE";
} else if (safeLockViolations.length > 0 || correctionChangedFromParent.length > 0) {
  recommendation = "STOP_M39_SAFETY_CONTRACT_FAILED";
} else if (actionablePairs.length === 0) {
  recommendation = "INSUFFICIENT_SEARCH_MISALIGNMENT_PAIRS_COLLECT_MORE_TRACE";
} else {
  recommendation = "RUN_DETERMINISTIC_OFFLINE_REPLAY_BEFORE_NEURAL_HEAD";
}

const acceptance = {
  sourceTracePassed: Boolean(source.acceptance?.passed),
  exactM341Parent: exactParent,
  decisionsPresent: decisions.length > 0,
  rootActionsPresent: decisions.every(
    (decision) => Array.isArray(decision.rootActions) && decision.rootActions.length > 0,
  ),
  pairProofContractValid: pairs.every((pair) => {
    const decision = decisions.find(
      (row) => row.gameId === pair.gameId && row.ply === pair.ply,
    );
    const positive = decision?.rootActions?.find(
      (action) => action.actionIndex === pair.positiveAction,
    );
    const negative = decision?.rootActions?.find(
      (action) => action.actionIndex === pair.negativeAction,
    );
    return positive?.selectedByParent === true
      && positive?.verificationStatus === "VERIFIED_SAFE"
      && negative?.verificationStatus === "REFUTED";
  }),
  parentVerifiedSafeNeverDisplaced: safeLockViolations.length === 0,
  correctionNeverChangesParentAction: correctionChangedFromParent.length === 0,
  diagnosticOnly: source.diagnosticOnly === true && source.changesPromotionState === false,
  noTrainingPerformed: source.acceptance?.noTrainingPerformed === true,
  passed: false,
};
acceptance.passed = Object.entries(acceptance)
  .filter(([key]) => key !== "passed")
  .every(([, value]) => value === true);

const summary = {
  schemaVersion: 1,
  stage: "M3.9_SEARCH_ALIGNED_DIAGNOSTIC_SUMMARY",
  diagnosticOnly: true,
  changesPromotionState: false,
  recommendation,
  parentCheckpoint: source.parentCheckpoint,
  sourceTraceStage: source.stage,
  sourceTraceRecommendation: source.recommendation,
  counts: {
    decisions: decisions.length,
    pairs: pairs.length,
    actionablePairs: actionablePairs.length,
    guardCorrectedRefutedPuct: guardCorrectedRefutedPuct.length,
    correctionChangedFromPuct: correctionChangedFromPuct.length,
    correctionChangedFromParent: correctionChangedFromParent.length,
    correctionMatchesParent: correctionMatchesParent.length,
    safeLockViolations: safeLockViolations.length,
    unverifiedFallbacks: unverifiedFallbacks.length,
    allRootActionsRefuted: allRootActionsRefuted.length,
  },
  pairEvidence: {
    byType: countBy(pairs, "pairType"),
    higherParentRankRefuted: higherRankPairs.length,
    higherQRefuted: higherQPairs.length,
    higherRawValueRefuted: higherRawValuePairs.length,
    rawPuctSelectionRefuted: rawPuctNegativePairs.length,
    actionablePairShare: actionablePairs.length / Math.max(1, pairs.length),
  },
  deterministicAssessment: {
    observedSearchErrorsCorrectedByExistingReader: guardCorrectedRefutedPuct.length,
    offlineCorrectionReproducedParentActions: correctionMatchesParent.length,
    offlineCorrectionChangedParentActions: correctionChangedFromParent.length,
    parentVerifiedSafeLockHeld: safeLockViolations.length === 0,
    conclusion: actionablePairs.length > 0
      ? "Observed safe-over-refuted search errors should first be replayed with deterministic proof-based correction. The trace does not justify a neural correction head yet."
      : "The trace did not contain enough actionable safe-over-refuted search errors to justify either a deterministic gameplay change or a neural correction head.",
  },
  nextGate: {
    allowed: recommendation === "RUN_DETERMINISTIC_OFFLINE_REPLAY_BEFORE_NEURAL_HEAD",
    scope: "OFFLINE_REPLAY_ONLY",
    requirements: [
      "Use the exact M3.4.1 checkpoint and recorded root traces.",
      "Never displace a parent VERIFIED_SAFE action.",
      "Never treat an UNVERIFIED action as a negative label.",
      "Measure corrected raw-PUCT agreement with the parent final action and reader calls saved.",
      "Do not run Arena, train a neural head, or change promotion state in this step.",
    ],
  },
  interpretationLimits: [
    "A final game result labels only the executed action; unchosen actions have no counterfactual win label.",
    "Reader-proved capture refutations are valid local negatives, but they do not prove that the selected safe action is globally optimal.",
    "Pairs already resolved by the current final guard do not by themselves justify changing shipped gameplay.",
    "A neural correction head requires unresolved repeated decision errors after deterministic replay, not merely a nonzero pair count.",
  ],
  acceptance,
};

const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (!acceptance.passed) {
  throw new Error(`M3.9 diagnostic summary acceptance failed: ${JSON.stringify(acceptance)}`);
}
