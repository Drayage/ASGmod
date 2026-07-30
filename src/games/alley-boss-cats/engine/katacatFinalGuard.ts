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
  /** Number of visit-ranked root candidates to prove safe before falling back. */
  finalVerificationLimit: number;
  /** Dedicated life-and-death budget for each candidate, not shared across candidates. */
  finalVerificationMs: number;
  finalVerificationDepth: number;
}

export type KataCatFinalGuardOutcome =
  | "SKIPPED_TACTICAL"
  | "VERIFIED_SAFE"
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

const DEFAULT_FINAL_GUARD: KataCatFinalGuardOptions = {
  finalVerificationLimit: 5,
  finalVerificationMs: 75,
  finalVerificationDepth: 7,
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
    outcome: "SKIPPED_TACTICAL",
    elapsedMs: Date.now() - started,
  };
}

/**
 * Rechecks only the moves PUCT is actually likely to play. A move is rejected
 * only when the existing focused reader proves that the opponent can force a
 * capture. Unchecked moves remain unknown rather than being labelled unsafe.
 *
 * M3.2.1 keeps zero-visit root edges in the fallback ordering. Therefore a
 * proved losing visited move is never selected again while any unverified root
 * action remains. If every root action is explicitly proved losing, the reader
 * has established an unavoidable forced loss; that exceptional fallback is
 * reported separately instead of being confused with an ordinary choice.
 */
export function verifyKataCatRootChoice(
  state: GameState,
  result: KataCatPuctResult,
  requested: Partial<KataCatFinalGuardOptions> = {},
  reader: KataCatRootRefutationReader = defaultRefutationReader,
): { action: AIAction; report: KataCatFinalGuardReport } {
  const started = Date.now();
  const options = { ...DEFAULT_FINAL_GUARD, ...requested };
  options.finalVerificationLimit = Math.max(1, Math.floor(options.finalVerificationLimit));
  options.finalVerificationMs = Math.max(1, Math.floor(options.finalVerificationMs));
  options.finalVerificationDepth = Math.max(1, Math.floor(options.finalVerificationDepth));

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
  const checkCount = Math.min(options.finalVerificationLimit, ranked.length);
  const refutedKeys = new Set<string>();
  let checks = 0;
  let refutations = 0;

  for (let index = 0; index < checkCount; index += 1) {
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
    return {
      action: record.action,
      report: {
        enabled: true,
        checks,
        refutations,
        selectedActionRejected: actionKey(record.action) !== originalKey,
        selectedActionWasRefuted: refutedKeys.has(originalKey),
        selectedRank: originalRank,
        chosenRank: index + 1,
        chosenVisits: record.visits,
        fallbackToUnverified: false,
        fallbackToZeroVisit: false,
        allCheckedRefuted: false,
        allRootActionsRefuted: false,
        provenLosingFallback: false,
        uncheckedActionsRemaining: ranked.length - checks,
        outcome: "VERIFIED_SAFE",
        elapsedMs: Date.now() - started,
      },
    };
  }

  const firstUnchecked = ranked[checkCount];
  if (firstUnchecked) {
    const zeroVisit = firstUnchecked.visits === 0;
    return {
      action: firstUnchecked.action,
      report: {
        enabled: true,
        checks,
        refutations,
        selectedActionRejected: actionKey(firstUnchecked.action) !== originalKey,
        selectedActionWasRefuted: refutedKeys.has(originalKey),
        selectedRank: originalRank,
        chosenRank: checkCount + 1,
        chosenVisits: firstUnchecked.visits,
        fallbackToUnverified: true,
        fallbackToZeroVisit: zeroVisit,
        allCheckedRefuted: checks > 0 && refutations === checks,
        allRootActionsRefuted: false,
        provenLosingFallback: false,
        uncheckedActionsRemaining: ranked.length - checkCount - 1,
        outcome: zeroVisit ? "UNVERIFIED_ZERO_VISIT" : "UNVERIFIED_VISITED",
        elapsedMs: Date.now() - started,
      },
    };
  }

  // Every legal root edge was checked and proved losing. There is no unknown or
  // verified-safe move to choose. Returning the deterministic top-ranked edge is
  // unavoidable, and is explicitly distinguished from the M3.2 bug where an
  // unvisited alternative existed but had been filtered out.
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
): Promise<KataCatVerifiedPuctResult> {
  const result = await searchKataCatPuct(state, evaluator, puctOptions);
  const verified = verifyKataCatRootChoice(state, result, finalGuardOptions);
  return { ...result, action: verified.action, finalGuard: verified.report };
}
