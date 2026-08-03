import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EXPECTED_PARENT = "9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b";

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

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function negativeHasHigherQ(pair) {
  return finite(pair.negativeMeanValue)
    && finite(pair.positiveMeanValue)
    && pair.negativeMeanValue > pair.positiveMeanValue;
}

function negativeHasHigherRawValue(pair) {
  return finite(pair.negativeChildRawValue)
    && finite(pair.positiveChildRawValue)
    && pair.negativeChildRawValue > pair.positiveChildRawValue;
}

function compareFeature(left, right, field, ascending) {
  const leftValue = left.root[field];
  const rightValue = right.root[field];
  const leftMissing = !finite(leftValue);
  const rightMissing = !finite(rightValue);
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
  if (!leftMissing && leftValue !== rightValue) {
    return ascending ? leftValue - rightValue : rightValue - leftValue;
  }
  return left.event.actionIndex - right.event.actionIndex;
}

function groupConsecutivePhases(rows) {
  const groups = [];
  let current = [];
  let previousKey = null;
  for (const row of rows) {
    const key = `${row.event.depth}:${row.event.budgetMs}`;
    if (previousKey !== null && key !== previousKey) {
      groups.push(current);
      current = [];
    }
    current.push(row);
    previousKey = key;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function replayDecision(decision, strategy) {
  const rootByAction = new Map(
    decision.rootActions.map((action) => [action.actionIndex, action]),
  );
  const rows = decision.readerEvents.map((event, index) => ({
    index,
    event,
    root: rootByAction.get(event.actionIndex),
  }));
  if (rows.length === 0) {
    return { calls: 0, selectedAction: null, featureValuesPresent: 0, featureValuesTotal: 0 };
  }

  const first = rows[0];
  const tail = rows.slice(1);
  let orderedTail;
  if (strategy.mode === "RECORDED") {
    orderedTail = tail;
  } else if (strategy.mode === "GLOBAL") {
    orderedTail = [...tail].sort((left, right) =>
      compareFeature(left, right, strategy.field, strategy.ascending));
  } else if (strategy.mode === "PHASE") {
    orderedTail = groupConsecutivePhases(tail).flatMap((group) =>
      [...group].sort((left, right) =>
        compareFeature(left, right, strategy.field, strategy.ascending)));
  } else {
    throw new Error(`Unknown replay mode: ${strategy.mode}`);
  }

  const ordered = [first, ...orderedTail];
  let calls = 0;
  let selectedAction = null;
  for (const row of ordered) {
    calls += 1;
    if (row.event.refuted === false) {
      selectedAction = row.event.actionIndex;
      break;
    }
  }
  const featureRows = strategy.field ? tail : [];
  return {
    calls,
    selectedAction,
    featureValuesPresent: featureRows.filter((row) => finite(row.root?.[strategy.field])).length,
    featureValuesTotal: featureRows.length,
  };
}

function summarizeStrategy(decisions, strategy, baselineCalls) {
  let calls = 0;
  let selectedSafeDecisions = 0;
  let parentAgreement = 0;
  let featureValuesPresent = 0;
  let featureValuesTotal = 0;
  let correctedDecisionCalls = 0;
  let correctedDecisionBaselineCalls = 0;

  for (const decision of decisions) {
    const result = replayDecision(decision, strategy);
    calls += result.calls;
    featureValuesPresent += result.featureValuesPresent;
    featureValuesTotal += result.featureValuesTotal;
    if (result.selectedAction !== null) {
      selectedSafeDecisions += 1;
      if (result.selectedAction === decision.finalDecision.executedAction) {
        parentAgreement += 1;
      }
    }
    if (decision.search.selectedPuctAction !== decision.finalDecision.executedAction) {
      correctedDecisionCalls += result.calls;
      correctedDecisionBaselineCalls += decision.readerEvents.length;
    }
  }

  return {
    name: strategy.name,
    mode: strategy.mode,
    field: strategy.field ?? null,
    ascending: strategy.ascending ?? null,
    recordedReaderCalls: baselineCalls,
    replayReaderCalls: calls,
    readerCallsSaved: baselineCalls - calls,
    readerCallSavingsShare: (baselineCalls - calls) / Math.max(1, baselineCalls),
    correctedDecisionRecordedCalls: correctedDecisionBaselineCalls,
    correctedDecisionReplayCalls: correctedDecisionCalls,
    correctedDecisionCallsSaved: correctedDecisionBaselineCalls - correctedDecisionCalls,
    selectedSafeDecisions,
    parentAgreement,
    parentAgreementShare: parentAgreement / Math.max(1, selectedSafeDecisions),
    featureCoverage: featureValuesPresent / Math.max(1, featureValuesTotal),
    featureValuesPresent,
    featureValuesTotal,
    eligibleForNextReplay: strategy.eligibleForNextReplay === true,
    interpretation: strategy.interpretation,
  };
}

const options = parseArgs();
if (!options.trace || !options.output) {
  throw new Error("--trace and --output are required");
}

const traceDir = resolve(options.trace);
const source = readJson(resolve(traceDir, "summary.json"));
const diagnostic = readJson(resolve(traceDir, "diagnostic-summary.json"));
const decisions = readJsonl(resolve(traceDir, "decision-traces.jsonl"));
const pairs = readJsonl(resolve(traceDir, "pairwise-examples.jsonl"));

const proofJoinFailures = [];
const proofStatusFailures = [];
const puctFirstFailures = [];
const safeProofFailures = [];
let readerCalls = 0;
let readerDecisions = 0;
let safeProofDecisions = 0;
let allRefutedProofDecisions = 0;

for (const decision of decisions) {
  const rootByAction = new Map(
    decision.rootActions.map((action) => [action.actionIndex, action]),
  );
  const events = decision.readerEvents ?? [];
  readerCalls += events.length;
  if (events.length > 0) {
    readerDecisions += 1;
    if (events[0].actionIndex !== decision.search.selectedPuctAction) {
      puctFirstFailures.push(decision.decisionId);
    }
  }
  const safeEvents = events.filter((event) => event.refuted === false);
  if (safeEvents.length > 0) {
    safeProofDecisions += 1;
    if (safeEvents.length !== 1
      || safeEvents[0].actionIndex !== decision.finalDecision.executedAction) {
      safeProofFailures.push(decision.decisionId);
    }
  } else if (events.length > 0 && events.every((event) => event.refuted === true)) {
    allRefutedProofDecisions += 1;
  }
  for (const event of events) {
    const root = rootByAction.get(event.actionIndex);
    if (!root) {
      proofJoinFailures.push(`${decision.decisionId}:${event.actionIndex}`);
      continue;
    }
    const expectedStatus = event.refuted ? "REFUTED" : "VERIFIED_SAFE";
    if (root.verificationStatus !== expectedStatus) {
      proofStatusFailures.push(`${decision.decisionId}:${event.actionIndex}`);
    }
  }
}

const strategies = [
  {
    name: "RECORDED_ORDER",
    mode: "RECORDED",
    eligibleForNextReplay: false,
    interpretation: "Exact recorded reader order baseline.",
  },
  {
    name: "PHASE_MEAN_Q_ASC",
    mode: "PHASE",
    field: "meanValue",
    ascending: true,
    eligibleForNextReplay: true,
    interpretation: "Keep the raw PUCT proof first, preserve reader budget phases, then verify lower-Q candidates first within each recorded phase.",
  },
  {
    name: "PHASE_PRIOR_ASC",
    mode: "PHASE",
    field: "prior",
    ascending: true,
    eligibleForNextReplay: true,
    interpretation: "Keep the raw PUCT proof first, preserve reader budget phases, then verify lower-prior candidates first within each recorded phase.",
  },
  {
    name: "PHASE_VISITS_ASC",
    mode: "PHASE",
    field: "visits",
    ascending: true,
    eligibleForNextReplay: true,
    interpretation: "Keep the raw PUCT proof first, preserve reader budget phases, then verify lower-visit candidates first within each recorded phase.",
  },
  {
    name: "PHASE_CHILD_RAW_ASC_INCOMPLETE",
    mode: "PHASE",
    field: "childRawValue",
    ascending: true,
    eligibleForNextReplay: false,
    interpretation: "Search-aligned upper bound using the partially sampled child raw value; incomplete feature coverage prevents selection as the next gate.",
  },
  {
    name: "GLOBAL_PRIOR_ASC_OPTIMISTIC",
    mode: "GLOBAL",
    field: "prior",
    ascending: true,
    eligibleForNextReplay: false,
    interpretation: "Optimistic upper bound that reorders across reader phases and therefore is not a safe gameplay candidate.",
  },
  {
    name: "GLOBAL_CHILD_RAW_ASC_OPTIMISTIC",
    mode: "GLOBAL",
    field: "childRawValue",
    ascending: true,
    eligibleForNextReplay: false,
    interpretation: "Optimistic upper bound with cross-phase reordering and incomplete child-value coverage.",
  },
];

const replay = strategies.map((strategy) =>
  summarizeStrategy(decisions, strategy, readerCalls));
const eligible = replay
  .filter((row) => row.eligibleForNextReplay
    && row.parentAgreement === row.selectedSafeDecisions
    && row.featureCoverage === 1)
  .sort((left, right) => {
    if (right.readerCallsSaved !== left.readerCallsSaved) {
      return right.readerCallsSaved - left.readerCallsSaved;
    }
    return left.name.localeCompare(right.name);
  });
const selectedStrategy = eligible[0] ?? null;

const higherRankPairs = pairs.filter((pair) => pair.negativeRankedAbovePositive === true);
const higherQPairs = pairs.filter(negativeHasHigherQ);
const higherRawPairs = pairs.filter(negativeHasHigherRawValue);
const rawPuctNegativePairs = pairs.filter((pair) => pair.negativeSelectedByPuct === true);
const actionablePairs = pairs.filter((pair) =>
  pair.negativeSelectedByPuct === true
  || pair.negativeRankedAbovePositive === true
  || negativeHasHigherQ(pair)
  || negativeHasHigherRawValue(pair));

const acceptance = {
  sourceTracePassed: source.acceptance?.passed === true,
  sourceDiagnosticPassed: diagnostic.acceptance?.passed === true,
  exactM341Parent: source.parentCheckpoint?.sha256 === EXPECTED_PARENT,
  decisionsPresent: decisions.length > 0,
  proofEventsJoinRootActions: proofJoinFailures.length === 0,
  proofStatusesMatchEvents: proofStatusFailures.length === 0,
  rawPuctAlwaysCheckedFirst: puctFirstFailures.length === 0,
  safeProofUniquelyMatchesParent: safeProofFailures.length === 0,
  noUnverifiedActionUsedAsNegative: pairs.every((pair) => {
    const decision = decisions.find(
      (row) => row.gameId === pair.gameId && row.ply === pair.ply,
    );
    const negative = decision?.rootActions.find(
      (action) => action.actionIndex === pair.negativeAction,
    );
    return negative?.verificationStatus === "REFUTED";
  }),
  allEligibleStrategiesPreserveParentProofChoice: eligible.every(
    (row) => row.parentAgreement === row.selectedSafeDecisions,
  ),
  selectedStrategyHasCompleteFeatureCoverage: selectedStrategy?.featureCoverage === 1,
  diagnosticOnly: source.diagnosticOnly === true
    && source.changesPromotionState === false
    && diagnostic.diagnosticOnly === true
    && diagnostic.changesPromotionState === false,
  noTrainingPerformed: source.acceptance?.noTrainingPerformed === true,
  passed: false,
};
acceptance.passed = Object.entries(acceptance)
  .filter(([key]) => key !== "passed")
  .every(([, value]) => value === true);

let recommendation;
if (!acceptance.passed) {
  recommendation = "INVALID_M391_REPLAY_DO_NOT_CONTINUE";
} else if (!selectedStrategy || selectedStrategy.readerCallsSaved <= 0) {
  recommendation = "STOP_M391_NO_DETERMINISTIC_READER_ORDER_GAIN";
} else {
  recommendation = "RUN_FULL_CANDIDATE_OFFLINE_READER_ORDER_REPLAY";
}

const output = {
  schemaVersion: 1,
  stage: "M3.9.1_RECORDED_PROOF_ORDER_REPLAY",
  diagnosticOnly: true,
  changesPromotionState: false,
  recommendation,
  parentCheckpoint: source.parentCheckpoint,
  source: {
    traceStage: source.stage,
    traceRecommendation: source.recommendation,
    diagnosticStage: diagnostic.stage,
    diagnosticRecommendation: diagnostic.recommendation,
  },
  counts: {
    decisions: decisions.length,
    readerDecisions,
    safeProofDecisions,
    allRefutedProofDecisions,
    recordedReaderCalls: readerCalls,
    correctedRawPuctDecisions: decisions.filter(
      (decision) => decision.search.selectedPuctAction
        !== decision.finalDecision.executedAction,
    ).length,
  },
  correctedPairEvidence: {
    pairs: pairs.length,
    actionablePairs: actionablePairs.length,
    higherParentRankRefuted: higherRankPairs.length,
    higherQRefuted: higherQPairs.length,
    higherRawValueRefuted: higherRawPairs.length,
    rawPuctSelectionRefuted: rawPuctNegativePairs.length,
    qAndRawValueBothHigher: pairs.filter(
      (pair) => negativeHasHigherQ(pair) && negativeHasHigherRawValue(pair),
    ).length,
  },
  replay,
  selectedStrategy,
  interpretation: {
    conclusion: selectedStrategy
      ? `${selectedStrategy.name} is the strongest complete-coverage, phase-preserving ordering on the recorded proof set. It saves ${selectedStrategy.readerCallsSaved} of ${readerCalls} recorded reader calls while keeping the raw PUCT proof first and reproducing every recorded parent safe choice.`
      : "No complete-coverage deterministic ordering improved the recorded proof-set reader schedule.",
    limits: [
      "This replay reorders only actions that the parent actually sent to the reader. It does not know the proof result of unverified actions that were never checked.",
      "A recorded proof-set gain is retrospective and optimistic: a full candidate phase may contain additional actions that could be moved ahead of the parent safe action.",
      "The next replay must reconstruct complete phase candidate lists and execute the real capture reader offline before any gameplay change.",
      "The result does not justify Arena, training a neural correction head, editing the checkpoint, or changing promotion state.",
    ],
  },
  nextGate: {
    allowed: recommendation === "RUN_FULL_CANDIDATE_OFFLINE_READER_ORDER_REPLAY",
    scope: "FULL_CANDIDATE_OFFLINE_READER_REPLAY_ONLY",
    candidateStrategy: selectedStrategy?.name ?? null,
    requirements: [
      "Use the exact M3.4.1 checkpoint and the same deterministic positions.",
      "Check the raw PUCT action first and retain it whenever the reader proves it safe.",
      "Reconstruct every candidate in each reader phase; do not filter to recorded proof events.",
      "Execute the real capture reader and require exact parent-action agreement on all parent VERIFIED_SAFE decisions.",
      "Do not run Arena, train a neural head, modify shipped play, or change promotion state.",
    ],
  },
  failures: {
    proofJoinFailures,
    proofStatusFailures,
    puctFirstFailures,
    safeProofFailures,
  },
  acceptance,
};

const outputPath = resolve(options.output);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output));
if (!acceptance.passed) {
  throw new Error(`M3.9.1 replay acceptance failed: ${JSON.stringify(acceptance)}`);
}
