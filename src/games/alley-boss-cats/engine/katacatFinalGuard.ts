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

export interface KataCatFinalGuardReport {
  enabled: boolean;
  checks: number;
  refutations: number;
  selectedActionRejected: boolean;
  selectedRank: number;
  chosenRank: number;
  fallbackToUnverified: boolean;
  allCheckedRefuted: boolean;
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

function rankVisits(records: KataCatVisitRecord[]): KataCatVisitRecord[] {
  return [...records]
    .filter((record) => record.visits > 0)
    .sort((left, right) => {
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

/**
 * Rechecks only the moves PUCT is actually likely to play. A move is rejected
 * only when the existing focused reader proves that the opponent can force a
 * capture. Unchecked moves remain unknown rather than being labelled unsafe.
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
    return {
      action: result.action,
      report: {
        enabled: true,
        checks: 0,
        refutations: 0,
        selectedActionRejected: false,
        selectedRank: 1,
        chosenRank: 1,
        fallbackToUnverified: false,
        allCheckedRefuted: false,
        elapsedMs: Date.now() - started,
      },
    };
  }

  const ranked = rankVisits(result.visitDistribution);
  if (ranked.length === 0) throw new Error("KataCat final guard received no visited root actions");

  const originalKey = actionKey(result.action);
  const originalRank = Math.max(1, ranked.findIndex((record) => actionKey(record.action) === originalKey) + 1);
  const checked = ranked.slice(0, Math.min(options.finalVerificationLimit, ranked.length));
  let checks = 0;
  let refutations = 0;

  for (let index = 0; index < checked.length; index += 1) {
    const record = checked[index];
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
      continue;
    }
    return {
      action: record.action,
      report: {
        enabled: true,
        checks,
        refutations,
        selectedActionRejected: actionKey(record.action) !== originalKey,
        selectedRank: originalRank,
        chosenRank: index + 1,
        fallbackToUnverified: false,
        allCheckedRefuted: false,
        elapsedMs: Date.now() - started,
      },
    };
  }

  const firstUnchecked = ranked[checked.length];
  if (firstUnchecked) {
    return {
      action: firstUnchecked.action,
      report: {
        enabled: true,
        checks,
        refutations,
        selectedActionRejected: actionKey(firstUnchecked.action) !== originalKey,
        selectedRank: originalRank,
        chosenRank: checked.length + 1,
        fallbackToUnverified: true,
        allCheckedRefuted: false,
        elapsedMs: Date.now() - started,
      },
    };
  }

  return {
    action: result.action,
    report: {
      enabled: true,
      checks,
      refutations,
      selectedActionRejected: false,
      selectedRank: originalRank,
      chosenRank: originalRank,
      fallbackToUnverified: false,
      allCheckedRefuted: true,
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
