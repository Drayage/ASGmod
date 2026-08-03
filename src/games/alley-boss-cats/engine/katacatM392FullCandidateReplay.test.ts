// @ts-nocheck -- Opt-in offline diagnostic reads Actions artifacts from Node fs.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import type { AIAction } from "../ai";
import { createInitialState } from "../rules";
import type { GameState, Player } from "../types";
import { opponentCanForceCapture } from "./captureSearch";
import { kataCatStateHash } from "./katacatM0";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_M392 === "1";
const suite = enabled ? describe : describe.skip;
const EXPECTED_PARENT = "9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b";

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function readJsonl(path: string) {
  const text = readFileSync(resolve(path), "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function rankRootActions(rows) {
  return [...rows]
    .filter((row) => row.includedInPuctRoot)
    .sort((left, right) => {
      if ((right.visits ?? 0) !== (left.visits ?? 0)) return (right.visits ?? 0) - (left.visits ?? 0);
      if ((right.meanValue ?? 0) !== (left.meanValue ?? 0)) return (right.meanValue ?? 0) - (left.meanValue ?? 0);
      if ((right.prior ?? 0) !== (left.prior ?? 0)) return (right.prior ?? 0) - (left.prior ?? 0);
      return left.actionIndex - right.actionIndex;
    });
}

function priorAscending(rows) {
  return [...rows].sort((left, right) => {
    const difference = (left.prior ?? Number.POSITIVE_INFINITY)
      - (right.prior ?? Number.POSITIVE_INFINITY);
    return difference !== 0 ? difference : left.actionIndex - right.actionIndex;
  });
}

function uniqueRows(rows) {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.actionIndex)) return false;
    seen.add(row.actionIndex);
    return true;
  });
}

function realRefuted(
  state: GameState,
  player: Player,
  action: AIAction,
  depth: number,
  budgetMs: number,
): boolean {
  const next = applyAction(state, action);
  if (next.winner === player) return false;
  if (next.winner) return true;
  return opponentCanForceCapture(next, player, depth, budgetMs);
}

function inferredRescueAction(decision): number | null {
  const adaptiveChecks = decision.finalDecision?.adaptiveChecks ?? 0;
  const rescueBudgetEvents = decision.readerEvents.filter((event) => event.budgetMs === 50);
  return rescueBudgetEvents.length > adaptiveChecks
    ? rescueBudgetEvents[0].actionIndex
    : null;
}

function recordedSafeProof(decision) {
  return decision.readerEvents.find(
    (event) => event.actionIndex === decision.finalDecision.executedAction && event.refuted === false,
  );
}

function replayPriorAscending(state: GameState, decision) {
  const ranked = rankRootActions(decision.rootActions);
  if (decision.search.reason !== "SEARCH") {
    return {
      actionIndex: decision.search.selectedPuctAction,
      outcome: "SKIPPED_TACTICAL",
      logicalReaderCalls: 0,
      uniqueReaderExecutions: 0,
      extraCandidateExecutions: 0,
      rawPuctCheckedFirst: true,
      unverifiedFallback: false,
      allRootActionsRefuted: false,
      events: [],
      proofCache: new Map(),
    };
  }
  if (ranked.length === 0) throw new Error(`${decision.decisionId}: no PUCT root records`);

  const puct = ranked.find((row) => row.actionIndex === decision.search.selectedPuctAction);
  if (!puct) throw new Error(`${decision.decisionId}: selected PUCT action missing from root`);

  const recordedProofKeys = new Set(
    decision.readerEvents.map((event) => `${event.actionIndex}:${event.depth}:${event.budgetMs}`),
  );
  const proofCache = new Map<number, boolean>();
  const events = [];
  let logicalReaderCalls = 0;
  let uniqueReaderExecutions = 0;
  let extraCandidateExecutions = 0;

  const check = (row, phase: string, depth: number, budgetMs: number) => {
    const cached = proofCache.get(row.actionIndex);
    if (cached !== undefined) return cached;
    logicalReaderCalls += 1;
    uniqueReaderExecutions += 1;
    if (!recordedProofKeys.has(`${row.actionIndex}:${depth}:${budgetMs}`)) {
      extraCandidateExecutions += 1;
    }
    const refuted = realRefuted(state, state.currentPlayer, row.action, depth, budgetMs);
    proofCache.set(row.actionIndex, refuted);
    events.push({
      phase,
      actionIndex: row.actionIndex,
      prior: row.prior ?? null,
      parentRank: row.parentRank,
      depth,
      budgetMs,
      refuted,
    });
    return refuted;
  };

  const safeResult = (row, outcome: string) => ({
    actionIndex: row.actionIndex,
    outcome,
    logicalReaderCalls,
    uniqueReaderExecutions,
    extraCandidateExecutions,
    rawPuctCheckedFirst: events[0]?.actionIndex === puct.actionIndex,
    unverifiedFallback: false,
    allRootActionsRefuted: false,
    events,
    proofCache,
  });

  const primaryCount = Math.min(5, ranked.length);
  const primary = uniqueRows([
    puct,
    ...priorAscending(ranked.slice(0, primaryCount).filter((row) => row.actionIndex !== puct.actionIndex)),
  ]);
  for (const row of primary) {
    if (!check(row, "PRIMARY", 7, 75)) return safeResult(row, "VERIFIED_SAFE");
  }

  const rescueIndex = inferredRescueAction(decision);
  if (rescueIndex !== null) {
    const rescue = ranked.find((row) => row.actionIndex === rescueIndex);
    if (!rescue) throw new Error(`${decision.decisionId}: inferred rescue action missing from root`);
    if (!check(rescue, "RESCUE", 7, 50)) return safeResult(rescue, "VERIFIED_RESCUE");
  }

  let adaptiveChecks = 0;
  const adaptive = priorAscending(ranked.filter((row) => !proofCache.has(row.actionIndex)));
  for (const row of adaptive) {
    if (adaptiveChecks >= 8) break;
    adaptiveChecks += 1;
    if (!check(row, "ADAPTIVE", 7, 50)) return safeResult(row, "VERIFIED_ADAPTIVE");
  }

  const firstUncheckedAfterGuard = ranked.find((row) => !proofCache.has(row.actionIndex));
  if (!firstUncheckedAfterGuard) {
    return {
      actionIndex: ranked[0].actionIndex,
      outcome: "ALL_ROOT_ACTIONS_REFUTED",
      logicalReaderCalls,
      uniqueReaderExecutions,
      extraCandidateExecutions,
      rawPuctCheckedFirst: events[0]?.actionIndex === puct.actionIndex,
      unverifiedFallback: false,
      allRootActionsRefuted: true,
      events,
      proofCache,
    };
  }

  let exhaustiveChecks = 0;
  const exhaustive = priorAscending(ranked.filter((row) => !proofCache.has(row.actionIndex)));
  for (const row of exhaustive) {
    if (exhaustiveChecks >= 82) break;
    exhaustiveChecks += 1;
    if (!check(row, "EXHAUSTIVE", 7, 25)) {
      return safeResult(row, "VERIFIED_EXHAUSTIVE_FALLBACK");
    }
  }

  const firstUnchecked = ranked.find((row) => !proofCache.has(row.actionIndex));
  if (firstUnchecked) {
    return {
      actionIndex: firstUnchecked.actionIndex,
      outcome: "UNVERIFIED_FALLBACK",
      logicalReaderCalls,
      uniqueReaderExecutions,
      extraCandidateExecutions,
      rawPuctCheckedFirst: events[0]?.actionIndex === puct.actionIndex,
      unverifiedFallback: true,
      allRootActionsRefuted: false,
      events,
      proofCache,
    };
  }

  return {
    actionIndex: ranked[0].actionIndex,
    outcome: "ALL_ROOT_ACTIONS_REFUTED",
    logicalReaderCalls,
    uniqueReaderExecutions,
    extraCandidateExecutions,
    rawPuctCheckedFirst: events[0]?.actionIndex === puct.actionIndex,
    unverifiedFallback: false,
    allRootActionsRefuted: true,
    events,
    proofCache,
  };
}

suite("KataCat M3.9.2 full-candidate reader replay", () => {
  it("executes the real reader over complete phase candidates without touching shipped play", () => {
    const traceDir = resolve(env.KATACAT_M392_TRACE_DIR ?? "source-m39/katacat-m39-search-trace");
    const outputDir = resolve(env.KATACAT_M392_OUTPUT_DIR ?? "katacat-m392-full-candidate-replay");
    const sourceSummary = readJson(resolve(traceDir, "summary.json"));
    const sourceDiagnostic = readJson(resolve(traceDir, "diagnostic-summary.json"));
    const games = readJsonl(resolve(traceDir, "games.jsonl"));
    const decisions = readJsonl(resolve(traceDir, "decision-traces.jsonl"));
    const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
    const results = [];
    const reconstructionFailures = [];
    const missingDecisions = [];

    for (const game of games) {
      let state = createInitialState();
      for (const action of game.openingActions) state = applyAction(state, action);

      for (const move of game.moves) {
        const actualStateHash = kataCatStateHash(state);
        if (actualStateHash !== move.preStateHash) {
          reconstructionFailures.push({
            gameId: game.gameId,
            ply: move.ply,
            expected: move.preStateHash,
            actual: actualStateHash,
          });
        }

        if (move.decisionId) {
          const decision = decisionById.get(move.decisionId);
          if (!decision) {
            missingDecisions.push(move.decisionId);
          } else {
            const replay = replayPriorAscending(state, decision);
            const parentAction = decision.finalDecision.executedAction;
            const parentRow = decision.rootActions.find((row) => row.actionIndex === parentAction);
            const safeProof = recordedSafeProof(decision);
            const parentProofStillSafe = safeProof
              ? !realRefuted(
                state,
                state.currentPlayer,
                parentRow.action,
                safeProof.depth,
                safeProof.budgetMs,
              )
              : null;
            results.push({
              schemaVersion: 1,
              decisionId: decision.decisionId,
              gameId: decision.gameId,
              ply: decision.ply,
              parentOutcome: decision.finalDecision.outcome,
              parentAction,
              candidateAction: replay.actionIndex,
              agreesWithParent: replay.actionIndex === parentAction,
              parentVerifiedSafe: parentRow?.verificationStatus === "VERIFIED_SAFE",
              parentProofStillSafe,
              recordedReaderCalls: decision.readerEvents.length,
              candidateReaderCalls: replay.logicalReaderCalls,
              readerCallsDelta: replay.logicalReaderCalls - decision.readerEvents.length,
              extraCandidateExecutions: replay.extraCandidateExecutions,
              candidateOutcome: replay.outcome,
              rawPuctCheckedFirst: replay.rawPuctCheckedFirst,
              unverifiedFallback: replay.unverifiedFallback,
              events: replay.events,
            });
          }
        }
        state = applyAction(state, move.action);
      }
    }

    const safeResults = results.filter((row) => row.parentVerifiedSafe);
    const safeDisagreements = safeResults.filter((row) => !row.agreesWithParent);
    const proofDrift = safeResults.filter((row) => row.parentProofStillSafe !== true);
    const allDisagreements = results.filter((row) => !row.agreesWithParent);
    const unverifiedFallbacks = results.filter((row) => row.unverifiedFallback);
    const candidateCalls = results.reduce((total, row) => total + row.candidateReaderCalls, 0);
    const recordedCalls = results.reduce((total, row) => total + row.recordedReaderCalls, 0);
    const extraCandidateExecutions = results.reduce(
      (total, row) => total + row.extraCandidateExecutions,
      0,
    );
    const rawPuctFirstFailures = results.filter((row) => !row.rawPuctCheckedFirst);

    const diagnosticAcceptance = {
      sourceTracePassed: sourceSummary.acceptance?.passed === true,
      sourceDiagnosticPassed: sourceDiagnostic.acceptance?.passed === true,
      exactM341Parent: sourceSummary.parentCheckpoint?.sha256 === EXPECTED_PARENT,
      allGamesLoaded: games.length === 32,
      allDecisionsReconstructed: results.length === decisions.length,
      stateHashesMatch: reconstructionFailures.length === 0,
      missingDecisionsZero: missingDecisions.length === 0,
      realReaderExecutedOnPreviouslyUnverifiedCandidates: extraCandidateExecutions > 0,
      rawPuctAlwaysCheckedFirst: rawPuctFirstFailures.length === 0,
      diagnosticOnly: true,
      noTrainingPerformed: true,
      shippedPlayUnchanged: true,
      passed: false,
    };
    diagnosticAcceptance.passed = Object.entries(diagnosticAcceptance)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    const candidateGate = {
      parentSafeProofsStable: proofDrift.length === 0,
      exactParentAgreementOnVerifiedSafe: safeDisagreements.length === 0,
      noUnverifiedFallback: unverifiedFallbacks.length === 0,
      readerCallsNotIncreased: candidateCalls <= recordedCalls,
      passed: false,
    };
    candidateGate.passed = Object.entries(candidateGate)
      .filter(([key]) => key !== "passed")
      .every(([, value]) => value === true);

    let recommendation;
    if (!diagnosticAcceptance.passed) {
      recommendation = "INVALID_FULL_CANDIDATE_REPLAY_DO_NOT_CONTINUE";
    } else if (proofDrift.length > 0) {
      recommendation = "STOP_M392_REAL_READER_PROOF_DRIFT";
    } else if (safeDisagreements.length > 0) {
      recommendation = "REJECT_PHASE_PRIOR_ASC_PARENT_ACTION_DRIFT";
    } else if (unverifiedFallbacks.length > 0) {
      recommendation = "REJECT_PHASE_PRIOR_ASC_UNVERIFIED_FALLBACK";
    } else if (candidateCalls >= recordedCalls) {
      recommendation = "KEEP_M341_ORDER_NO_FULL_CANDIDATE_SAVINGS";
    } else {
      recommendation = "PHASE_PRIOR_ASC_READY_FOR_TACTICAL_FIXTURE_GATE_ONLY";
    }

    const summary = {
      schemaVersion: 1,
      stage: "M3.9.2_FULL_CANDIDATE_REAL_READER_REPLAY",
      diagnosticOnly: true,
      changesPromotionState: false,
      recommendation,
      parentCheckpoint: sourceSummary.parentCheckpoint,
      source: {
        m39Stage: sourceSummary.stage,
        m39Recommendation: sourceSummary.recommendation,
        m391Recommendation: "RUN_FULL_CANDIDATE_OFFLINE_READER_ORDER_REPLAY",
        strategy: "PHASE_PRIOR_ASC",
      },
      counts: {
        games: games.length,
        decisions: results.length,
        parentVerifiedSafeDecisions: safeResults.length,
        recordedReaderCalls: recordedCalls,
        candidateReaderCalls: candidateCalls,
        readerCallsSaved: recordedCalls - candidateCalls,
        readerCallSavingsShare: (recordedCalls - candidateCalls) / Math.max(1, recordedCalls),
        extraCandidateReaderExecutions: extraCandidateExecutions,
        allParentActionDisagreements: allDisagreements.length,
        verifiedSafeParentActionDisagreements: safeDisagreements.length,
        parentSafeProofDrift: proofDrift.length,
        unverifiedFallbacks: unverifiedFallbacks.length,
      },
      disagreements: safeDisagreements.slice(0, 50).map((row) => ({
        decisionId: row.decisionId,
        parentOutcome: row.parentOutcome,
        parentAction: row.parentAction,
        candidateAction: row.candidateAction,
        recordedReaderCalls: row.recordedReaderCalls,
        candidateReaderCalls: row.candidateReaderCalls,
        candidateOutcome: row.candidateOutcome,
      })),
      proofDrift: proofDrift.slice(0, 50).map((row) => ({
        decisionId: row.decisionId,
        parentOutcome: row.parentOutcome,
        parentAction: row.parentAction,
      })),
      interpretation: {
        conclusion: candidateGate.passed
          ? "The full-candidate real-reader replay preserves every recorded verified-safe parent action and saves reader calls. The strategy may proceed only to tactical fixtures, not Arena or shipped play."
          : "The full-candidate replay did not satisfy the conservative parent-action contract. Keep the shipped M3.4.1 order and do not train or promote a correction head from this result.",
        limits: [
          "This is an offline replay over the 386 recorded M3.9 decisions, not a gameplay change.",
          "The real capture reader is executed on complete primary, adaptive, and exhaustive candidate phases; the rescue candidate is reconstructed from the recorded checked rescue event when present.",
          "Exact parent-action agreement is intentionally stricter than merely choosing another reader-safe action.",
          "Even a passing result permits tactical fixture work only; it does not permit Arena, checkpoint edits, neural training, merge, or promotion.",
        ],
      },
      nextGate: {
        allowed: candidateGate.passed,
        scope: candidateGate.passed ? "TACTICAL_FIXTURES_ONLY" : "NONE_KEEP_M341",
        requirements: candidateGate.passed
          ? [
            "Add deterministic tactical fixtures for every changed verification order.",
            "Keep the raw PUCT action first and immutable when proved safe.",
            "Do not change the checkpoint or train a correction head.",
            "Do not run Arena or modify promotion state in this step.",
          ]
          : [
            "Keep M3.4.1 shipped behavior unchanged.",
            "Do not train a neural correction head from safe-over-refuted pairs already handled by the reader.",
          ],
      },
      diagnosticAcceptance,
      candidateGate,
    };

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "decision-replay.jsonl"),
      results.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`KATACAT_M392_REPLAY:${JSON.stringify(summary)}`);
    expect(diagnosticAcceptance.passed).toBe(true);
  }, 1_800_000);
});
