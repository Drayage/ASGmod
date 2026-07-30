import { applyAction } from "../ai";
import type { AIAction } from "../ai";
import type { GameState, Player } from "../types";
import { opponentCanForceCapture } from "./captureSearch";
import {
  searchKataCatPuct,
  type KataCatNeuralEvaluator,
  type KataCatPuctOptions,
  type KataCatPuctResult,
  type KataCatVisitRecord,
} from "./katacatPuct";

export interface KataCatFinalGuardOptions {
  /** Number of visit-ranked root candidates checked before rescue mode starts. */
  finalVerificationLimit: number;
  /** Dedicated life-and-death budget for each primary candidate. */
  finalVerificationMs: number;
  finalVerificationDepth: number;
  /** Additional ranked candidates checked after the tactical rescue suggestion. */
  rescueVerificationLimit: number;
  /** Dedicated life-and-death budget for each rescue/tail candidate. */
  rescueVerificationMs: number;
  /** Total wall-clock budget for rescue suggestion plus adaptive tail checks. */
  rescueTotalMs: number;
}

export type KataCatFinalGuardOutcome =
  | "SKIPPED_TACTICAL"
  | "VERIFIED_SAFE"
  | "VERIFIED_RESCUE"
  | "VERIFIED_ADAPTIVE"
  | "UNVERIFIED_VISITED"
  | "UNVERIFIED_ZERO_VISIT"
  | "ALL_ROOT_ACTIONS_REFUTED";

export interface KataCatFinalGuardReport {
  enabled: boolean;
  checks: number;
  refutations: number;
  selectedActionRejected: boolean;
  selectedActionWasRefuted: boolean;
  selectedRank: number;
  chosenRank: number;
  chosenVisits: number;
  fallbackToUnverified: boolean;
  fallbackToZeroVisit: boolean;
  allCheckedRefuted: boolean;
  allRootActionsRefuted: boolean;
  provenLosingFallback: boolean;
  uncheckedActionsRemaining: number;
  rescueRequested: boolean;
  rescueSuggested: boolean;
  rescueCandidateInRoot: boolean;
  rescueCandidateAlreadyRefuted: boolean;
  rescueCandidateChecked: boolean;
  rescueCandidateRefuted: boolean;
  rescueCandidateSelected: boolean;
  rescueProviderElapsedMs: number;
  adaptiveChecks: number;
  adaptiveRefutations: number;
  adaptiveBudgetExhausted: boolean;
  outcome: KataCatFinalGuardOutcome;
  elapsedMs: number;
}

export interface KataCatVerifiedPuctResult extends KataCatPuctResult {
  finalGuard: KataCatFinalGuardReport;
}

export type KataCatRootRefutationReader = (
  state: GameState,
  player: Player,
  action: AIAction,
  depth: number,
  timeBudgetMs: number,
) => boolean;

export type KataCatTacticalRescueProvider = (
  state: GameState,
  player: Player,
) => AIAction | null;

const DEFAULT_FINAL_GUARD: KataCatFinalGuardOptions = {
  finalVerificationLimit: 5,
  finalVerificationMs: 75,
  finalVerificationDepth: 7,
  rescueVerificationLimit: 0,
  rescueVerificationMs: 50,
  rescueTotalMs: 0,
};

/**
 * Rank every root edge, including zero-visit edges. Positive visits still sort
 * first, but an unvisited legal root action remains available as an unknown
 * fallback when every searched candidate is proved losing.
 */
function rankRootActions(records: KataCatVisitRecord[]): KataCatVisitRecord[] {
  return [...records].sort((left, right) => {
    if (right.visits !== left.visits) return right.visits - left.visits;
    if (right.meanValue !== left.meanValue) return right.meanValue - left.meanValue;
    if (right.prior !== left.prior) return right.prior - left.prior;
    return left.actionIndex - right.actionIndex;
  });
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
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

interface RescueTelemetry {
  rescueRequested: boolean;
  rescueSuggested: boolean;
  rescueCandidateInRoot: boolean;
  rescueCandidateAlreadyRefuted: boolean;
  rescueCandidateChecked: boolean;
  rescueCandidateRefuted: boolean;
  rescueCandidateSelected: boolean;
  rescueProviderElapsedMs: number;
  adaptiveChecks: number;
  adaptiveRefutations: number;
  adaptiveBudgetExhausted: boolean;
}

function emptyRescueTelemetry(): RescueTelemetry {
  return {
    rescueRequested: false,
    rescueSuggested: false,
    rescueCandidateInRoot: false,
    rescueCandidateAlreadyRefuted: false,
    rescueCandidateChecked: false,
    rescueCandidateRefuted: false,
    rescueCandidateSelected: false,
    rescueProviderElapsedMs: 0,
    adaptiveChecks: 0,
    adaptiveRefutations: 0,
    adaptiveBudgetExhausted: false,
  };
}

function skippedReport(started: number): KataCatFinalGuardReport {
  return {
    enabled: true,
    checks: 0,
    refutations: 0,
    selectedActionRejected: false,
    selectedActionWasRefuted: false,
    selectedRank: 1,
    chosenRank: 1,
    chosenVisits: 1,
    fallbackToUnverified: false,
    fallbackToZeroVisit: false,
    allCheckedRefuted: false,
    allRootActionsRefuted: false,
    provenLosingFallback: false,
    uncheckedActionsRemaining: 0,
    ...emptyRescueTelemetry(),
    outcome: "SKIPPED_TACTICAL",
    elapsedMs: Date.now() - started,
  };
}

function remainingUnknown(
  ranked: KataCatVisitRecord[],
  refutedKeys: ReadonlySet<string>,
  chosen: AIAction,
): number {
  const chosenKey = actionKey(chosen);
  return ranked.filter((record) => {
    const key = actionKey(record.action);
    return key !== chosenKey && !refutedKeys.has(key);
  }).length;
}

/**
 * Rechecks only the moves PUCT is actually likely to play. A move is rejected
 * only when the existing focused reader proves that the opponent can force a
 * capture. Unchecked moves remain unknown rather than being labelled unsafe.
 *
 * M3.2.2 adds an emergency path after every primary candidate is refuted:
 * a tactical provider may suggest one rescue move, then a bounded adaptive scan
 * checks additional root moves. The provider never bypasses the root pool and
 * every suggested move is independently verified by the same focused reader.
 */
export function verifyKataCatRootChoice(
  state: GameState,
  result: KataCatPuctResult,
  requested: Partial<KataCatFinalGuardOptions> = {},
  reader: KataCatRootRefutationReader = defaultRefutationReader,
  rescueProvider?: KataCatTacticalRescueProvider,
): { action: AIAction; report: KataCatFinalGuardReport } {
  const started = Date.now();
  const options = { ...DEFAULT_FINAL_GUARD, ...requested };
  options.finalVerificationLimit = Math.max(1, Math.floor(options.finalVerificationLimit));
  options.finalVerificationMs = Math.max(1, Math.floor(options.finalVerificationMs));
  options.finalVerificationDepth = Math.max(1, Math.floor(options.finalVerificationDepth));
  options.rescueVerificationLimit = Math.max(0, Math.floor(options.rescueVerificationLimit));
  options.rescueVerificationMs = Math.max(1, Math.floor(options.rescueVerificationMs));
  options.rescueTotalMs = Math.max(0, Math.floor(options.rescueTotalMs));

  if (result.reason !== "SEARCH") {
    return { action: result.action, report: skippedReport(started) };
  }

  const ranked = rankRootActions(result.visitDistribution);
  if (ranked.length === 0) throw new Error("KataCat final guard received no root actions");

  const originalKey = actionKey(result.action);
  const locatedOriginalRank = ranked.findIndex((record) => actionKey(record.action) === originalKey);
  if (locatedOriginalRank < 0) {
    throw new Error("KataCat final guard could not find the selected action in the root distribution");
  }
  const originalRank = locatedOriginalRank + 1;
  const primaryCount = Math.min(options.finalVerificationLimit, ranked.length);
  const refutedKeys = new Set<string>();
  let checks = 0;
  let refutations = 0;
  const rescue = emptyRescueTelemetry();

  const checkedSafeResult = (
    record: KataCatVisitRecord,
    outcome: "VERIFIED_SAFE" | "VERIFIED_RESCUE" | "VERIFIED_ADAPTIVE",
  ) => ({
    action: record.action,
    report: {
      enabled: true,
      checks,
      refutations,
      selectedActionRejected: actionKey(record.action) !== originalKey,
      selectedActionWasRefuted: refutedKeys.has(originalKey),
      selectedRank: originalRank,
      chosenRank: ranked.findIndex((candidate) => actionKey(candidate.action) === actionKey(record.action)) + 1,
      chosenVisits: record.visits,
      fallbackToUnverified: false,
      fallbackToZeroVisit: false,
      allCheckedRefuted: false,
      allRootActionsRefuted: false,
      provenLosingFallback: false,
      uncheckedActionsRemaining: remainingUnknown(ranked, refutedKeys, record.action),
      ...rescue,
      outcome,
      elapsedMs: Date.now() - started,
    } satisfies KataCatFinalGuardReport,
  });

  for (let index = 0; index < primaryCount; index += 1) {
    const record = ranked[index];
    checks += 1;
    const refuted = reader(
      state,
      state.currentPlayer,
      record.action,
      options.finalVerificationDepth,
      options.finalVerificationMs,
    );
    if (refuted) {
      refutations += 1;
      refutedKeys.add(actionKey(record.action));
      continue;
    }
    return checkedSafeResult(record, "VERIFIED_SAFE");
  }

  const rescuePhaseEnabled =
    ranked.length > primaryCount &&
    options.rescueVerificationLimit > 0 &&
    options.rescueTotalMs > 0;
  const rescueStarted = Date.now();

  if (rescuePhaseEnabled && rescueProvider) {
    rescue.rescueRequested = true;
    const providerStarted = Date.now();
    const suggested = rescueProvider(state, state.currentPlayer);
    rescue.rescueProviderElapsedMs = Date.now() - providerStarted;
    rescue.rescueSuggested = suggested !== null;

    if (suggested) {
      const suggestedKey = actionKey(suggested);
      const rescueRecord = ranked.find((record) => actionKey(record.action) === suggestedKey);
      rescue.rescueCandidateInRoot = rescueRecord !== undefined;
      rescue.rescueCandidateAlreadyRefuted = refutedKeys.has(suggestedKey);

      if (rescueRecord && !rescue.rescueCandidateAlreadyRefuted) {
        rescue.rescueCandidateChecked = true;
        checks += 1;
        const refuted = reader(
          state,
          state.currentPlayer,
          rescueRecord.action,
          options.finalVerificationDepth,
          options.rescueVerificationMs,
        );
        if (refuted) {
          refutations += 1;
          refutedKeys.add(suggestedKey);
          rescue.rescueCandidateRefuted = true;
        } else {
          rescue.rescueCandidateSelected = true;
          return checkedSafeResult(rescueRecord, "VERIFIED_RESCUE");
        }
      }
    }
  }

  if (rescuePhaseEnabled) {
    for (const record of ranked) {
      if (rescue.adaptiveChecks >= options.rescueVerificationLimit) break;
      if (Date.now() - rescueStarted >= options.rescueTotalMs) break;
      const key = actionKey(record.action);
      if (refutedKeys.has(key)) continue;

      rescue.adaptiveChecks += 1;
      checks += 1;
      const refuted = reader(
        state,
        state.currentPlayer,
        record.action,
        options.finalVerificationDepth,
        options.rescueVerificationMs,
      );
      if (refuted) {
        rescue.adaptiveRefutations += 1;
        refutations += 1;
        refutedKeys.add(key);
        continue;
      }
      return checkedSafeResult(record, "VERIFIED_ADAPTIVE");
    }
  }

  const firstUnchecked = ranked.find((record) => !refutedKeys.has(actionKey(record.action)));
  if (firstUnchecked) {
    const zeroVisit = firstUnchecked.visits === 0;
    rescue.adaptiveBudgetExhausted = rescuePhaseEnabled;
    return {
      action: firstUnchecked.action,
      report: {
        enabled: true,
        checks,
        refutations,
        selectedActionRejected: actionKey(firstUnchecked.action) !== originalKey,
        selectedActionWasRefuted: refutedKeys.has(originalKey),
        selectedRank: originalRank,
        chosenRank:
          ranked.findIndex((record) => actionKey(record.action) === actionKey(firstUnchecked.action)) + 1,
        chosenVisits: firstUnchecked.visits,
        fallbackToUnverified: true,
        fallbackToZeroVisit: zeroVisit,
        allCheckedRefuted: checks > 0 && refutations === checks,
        allRootActionsRefuted: false,
        provenLosingFallback: false,
        uncheckedActionsRemaining: remainingUnknown(ranked, refutedKeys, firstUnchecked.action),
        ...rescue,
        outcome: zeroVisit ? "UNVERIFIED_ZERO_VISIT" : "UNVERIFIED_VISITED",
        elapsedMs: Date.now() - started,
      },
    };
  }

  // Every legal root edge was checked and proved losing. Returning the
  // deterministic top-ranked edge is unavoidable and explicitly reported.
  const unavoidable = ranked[0];
  return {
    action: unavoidable.action,
    report: {
      enabled: true,
      checks,
      refutations,
      selectedActionRejected: actionKey(unavoidable.action) !== originalKey,
      selectedActionWasRefuted: refutedKeys.has(originalKey),
      selectedRank: originalRank,
      chosenRank: 1,
      chosenVisits: unavoidable.visits,
      fallbackToUnverified: false,
      fallbackToZeroVisit: false,
      allCheckedRefuted: checks > 0 && refutations === checks,
      allRootActionsRefuted: true,
      provenLosingFallback: true,
      uncheckedActionsRemaining: 0,
      ...rescue,
      outcome: "ALL_ROOT_ACTIONS_REFUTED",
      elapsedMs: Date.now() - started,
    },
  };
}

export async function searchKataCatPuctWithFinalGuard(
  state: GameState,
  evaluator: KataCatNeuralEvaluator,
  puctOptions: Partial<KataCatPuctOptions> = {},
  finalGuardOptions: Partial<KataCatFinalGuardOptions> = {},
  rescueProvider?: KataCatTacticalRescueProvider,
): Promise<KataCatVerifiedPuctResult> {
  const result = await searchKataCatPuct(state, evaluator, puctOptions);
  const verified = verifyKataCatRootChoice(
    state,
    result,
    finalGuardOptions,
    defaultRefutationReader,
    rescueProvider,
  );
  return { ...result, action: verified.action, finalGuard: verified.report };
}
