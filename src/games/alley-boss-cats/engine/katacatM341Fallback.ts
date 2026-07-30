import { applyAction } from "../ai";
import type { AIAction } from "../ai";
import type { GameState } from "../types";
import { opponentCanForceCapture } from "./captureSearch";
import {
  verifyKataCatRootChoice,
  type KataCatFinalGuardOptions,
  type KataCatFinalGuardReport,
  type KataCatRootRefutationReader,
  type KataCatTacticalRescueProvider,
} from "./katacatFinalGuard";
import {
  searchKataCatPuct,
  type KataCatNeuralEvaluator,
  type KataCatPuctOptions,
  type KataCatPuctResult,
  type KataCatVisitRecord,
} from "./katacatPuct";

export interface KataCatM341FallbackOptions {
  verificationDepth: number;
  verificationMs: number;
  verificationLimit: number;
}

export type KataCatM341Outcome =
  | KataCatFinalGuardReport["outcome"]
  | "VERIFIED_EXHAUSTIVE_FALLBACK";

export interface KataCatM341GuardReport extends Omit<KataCatFinalGuardReport, "outcome"> {
  outcome: KataCatM341Outcome;
  improvedFallbackAttempted: boolean;
  improvedFallbackChecks: number;
  improvedFallbackRefutations: number;
  improvedFallbackSelected: boolean;
  improvedFallbackExhaustedAllRoots: boolean;
  preventedUnverifiedFallback: boolean;
  originalFallbackOutcome: KataCatFinalGuardReport["outcome"];
}

export interface KataCatM341VerifiedPuctResult extends KataCatPuctResult {
  finalGuard: KataCatM341GuardReport;
}

const DEFAULT_IMPROVED_OPTIONS: KataCatM341FallbackOptions = {
  verificationDepth: 7,
  verificationMs: 50,
  verificationLimit: 82,
};

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function rankRootActions(records: KataCatVisitRecord[]): KataCatVisitRecord[] {
  return [...records].sort((left, right) => {
    if (right.visits !== left.visits) return right.visits - left.visits;
    if (right.meanValue !== left.meanValue) return right.meanValue - left.meanValue;
    if (right.prior !== left.prior) return right.prior - left.prior;
    return left.actionIndex - right.actionIndex;
  });
}

const defaultRefutationReader: KataCatRootRefutationReader = (
  state,
  player,
  action,
  depth,
  timeBudgetMs,
) => {
  const next = applyAction(state, action);
  if (next.winner === player) return false;
  if (next.winner) return true;
  return opponentCanForceCapture(next, player, depth, timeBudgetMs);
};

function withImprovedTelemetry(
  report: KataCatFinalGuardReport,
  extra: Partial<Pick<
    KataCatM341GuardReport,
    | "improvedFallbackAttempted"
    | "improvedFallbackChecks"
    | "improvedFallbackRefutations"
    | "improvedFallbackSelected"
    | "improvedFallbackExhaustedAllRoots"
    | "preventedUnverifiedFallback"
  >> = {},
): KataCatM341GuardReport {
  return {
    ...report,
    improvedFallbackAttempted: false,
    improvedFallbackChecks: 0,
    improvedFallbackRefutations: 0,
    improvedFallbackSelected: false,
    improvedFallbackExhaustedAllRoots: false,
    preventedUnverifiedFallback: false,
    originalFallbackOutcome: report.outcome,
    ...extra,
  };
}

/**
 * The existing guard remains the first decision layer. Only when it would
 * play an unchecked root does M3.4.1 continue the focused reader through the
 * remaining roots. Any checked, non-refuted root is preferred to a blind
 * rank-14/15 fallback. This experimental strategy is not wired into shipped AI.
 */
export function verifyKataCatRootChoiceM341(
  state: GameState,
  result: KataCatPuctResult,
  finalGuardOptions: Partial<KataCatFinalGuardOptions> = {},
  improvedOptions: Partial<KataCatM341FallbackOptions> = {},
  reader: KataCatRootRefutationReader = defaultRefutationReader,
  rescueProvider?: KataCatTacticalRescueProvider,
): { action: AIAction; report: KataCatM341GuardReport } {
  const cache = new Map<string, boolean>();
  const cachedReader: KataCatRootRefutationReader = (
    readState,
    player,
    action,
    depth,
    timeBudgetMs,
  ) => {
    const key = actionKey(action);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = reader(readState, player, action, depth, timeBudgetMs);
    cache.set(key, value);
    return value;
  };

  const original = verifyKataCatRootChoice(
    state,
    result,
    finalGuardOptions,
    cachedReader,
    rescueProvider,
  );
  if (!original.report.fallbackToUnverified || result.reason !== "SEARCH") {
    return { action: original.action, report: withImprovedTelemetry(original.report) };
  }

  const options = { ...DEFAULT_IMPROVED_OPTIONS, ...improvedOptions };
  options.verificationDepth = Math.max(1, Math.floor(options.verificationDepth));
  options.verificationMs = Math.max(1, Math.floor(options.verificationMs));
  options.verificationLimit = Math.max(1, Math.floor(options.verificationLimit));

  const ranked = rankRootActions(result.visitDistribution);
  const originalSelectedKey = actionKey(result.action);
  let checks = 0;
  let refutations = 0;
  let attemptedRoots = 0;

  for (const record of ranked) {
    if (attemptedRoots >= options.verificationLimit) break;
    const key = actionKey(record.action);
    const cached = cache.get(key);
    if (cached === true) continue;
    if (cached === false) {
      return {
        action: record.action,
        report: {
          ...withImprovedTelemetry(original.report),
          outcome: "VERIFIED_EXHAUSTIVE_FALLBACK",
          chosenRank: ranked.indexOf(record) + 1,
          chosenVisits: record.visits,
          selectedActionRejected: key !== originalSelectedKey,
          selectedActionWasRefuted: cache.get(originalSelectedKey) === true,
          fallbackToUnverified: false,
          fallbackToZeroVisit: false,
          allCheckedRefuted: false,
          allRootActionsRefuted: false,
          provenLosingFallback: false,
          uncheckedActionsRemaining: ranked.filter(
            (candidate) => !cache.has(actionKey(candidate.action)),
          ).length,
          improvedFallbackAttempted: true,
          improvedFallbackChecks: checks,
          improvedFallbackRefutations: refutations,
          improvedFallbackSelected: true,
          improvedFallbackExhaustedAllRoots: false,
          preventedUnverifiedFallback: true,
        },
      };
    }

    attemptedRoots += 1;
    checks += 1;
    const refuted = cachedReader(
      state,
      state.currentPlayer,
      record.action,
      options.verificationDepth,
      options.verificationMs,
    );
    if (refuted) {
      refutations += 1;
      continue;
    }
    return {
      action: record.action,
      report: {
        ...withImprovedTelemetry(original.report),
        outcome: "VERIFIED_EXHAUSTIVE_FALLBACK",
        chosenRank: ranked.indexOf(record) + 1,
        chosenVisits: record.visits,
        selectedActionRejected: key !== originalSelectedKey,
        selectedActionWasRefuted: cache.get(originalSelectedKey) === true,
        fallbackToUnverified: false,
        fallbackToZeroVisit: false,
        allCheckedRefuted: false,
        allRootActionsRefuted: false,
        provenLosingFallback: false,
        uncheckedActionsRemaining: ranked.filter(
          (candidate) => !cache.has(actionKey(candidate.action)),
        ).length,
        improvedFallbackAttempted: true,
        improvedFallbackChecks: checks,
        improvedFallbackRefutations: refutations,
        improvedFallbackSelected: true,
        improvedFallbackExhaustedAllRoots: false,
        preventedUnverifiedFallback: true,
      },
    };
  }

  const unchecked = ranked.filter((record) => !cache.has(actionKey(record.action)));
  if (unchecked.length > 0) {
    return {
      action: original.action,
      report: withImprovedTelemetry(original.report, {
        improvedFallbackAttempted: true,
        improvedFallbackChecks: checks,
        improvedFallbackRefutations: refutations,
      }),
    };
  }

  const unavoidable = ranked[0];
  return {
    action: unavoidable.action,
    report: {
      ...withImprovedTelemetry(original.report),
      outcome: "ALL_ROOT_ACTIONS_REFUTED",
      chosenRank: 1,
      chosenVisits: unavoidable.visits,
      selectedActionRejected: actionKey(unavoidable.action) !== originalSelectedKey,
      selectedActionWasRefuted: cache.get(originalSelectedKey) === true,
      fallbackToUnverified: false,
      fallbackToZeroVisit: false,
      allCheckedRefuted: true,
      allRootActionsRefuted: true,
      provenLosingFallback: true,
      uncheckedActionsRemaining: 0,
      improvedFallbackAttempted: true,
      improvedFallbackChecks: checks,
      improvedFallbackRefutations: refutations,
      improvedFallbackSelected: false,
      improvedFallbackExhaustedAllRoots: true,
      preventedUnverifiedFallback: true,
    },
  };
}

export async function searchKataCatPuctWithM341Fallback(
  state: GameState,
  evaluator: KataCatNeuralEvaluator,
  puctOptions: Partial<KataCatPuctOptions> = {},
  finalGuardOptions: Partial<KataCatFinalGuardOptions> = {},
  improvedOptions: Partial<KataCatM341FallbackOptions> = {},
  rescueProvider?: KataCatTacticalRescueProvider,
): Promise<KataCatM341VerifiedPuctResult> {
  const result = await searchKataCatPuct(state, evaluator, puctOptions);
  const verified = verifyKataCatRootChoiceM341(
    state,
    result,
    finalGuardOptions,
    improvedOptions,
    defaultRefutationReader,
    rescueProvider,
  );
  return { ...result, action: verified.action, finalGuard: verified.report };
}
