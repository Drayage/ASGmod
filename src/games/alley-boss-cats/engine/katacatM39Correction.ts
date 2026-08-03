export type KataCatM39VerificationStatus = "VERIFIED_SAFE" | "REFUTED" | "UNVERIFIED";

export interface KataCatM39RankedAction {
  actionIndex: number;
  parentRank: number;
  verificationStatus: KataCatM39VerificationStatus;
  selectedByParent: boolean;
  selectionOutcome?: string | null;
  visits?: number | null;
  meanValue?: number | null;
  prior?: number | null;
  childRawValue?: number | null;
  childScoreEstimate?: number | null;
  provenCaptureLoss?: boolean;
}

export interface KataCatM39CorrectionResult {
  actionIndex: number;
  parentActionIndex: number;
  changed: boolean;
  safetyLocked: boolean;
  allActionsRefuted: boolean;
  reason:
    | "PARENT_VERIFIED_SAFE_LOCK"
    | "TOP_NON_REFUTED_PARENT_RANK"
    | "ALL_ACTIONS_REFUTED_KEEP_PARENT";
}

export interface KataCatM39PairwiseExample {
  positiveAction: number;
  negativeAction: number;
  pairType:
    | "VERIFIED_SAFE_OVER_REFUTED"
    | "VERIFIED_RESCUE_OVER_REFUTED"
    | "VERIFIED_ADAPTIVE_OVER_REFUTED"
    | "VERIFIED_EXHAUSTIVE_OVER_REFUTED"
    | "SAFE_SELECTION_OVER_HIGHER_Q_REFUTED"
    | "SAFE_SELECTION_OVER_HIGHER_RAW_VALUE_REFUTED";
  positiveParentRank: number;
  negativeParentRank: number;
  positiveVisits: number | null;
  negativeVisits: number | null;
  positiveMeanValue: number | null;
  negativeMeanValue: number | null;
  positiveChildRawValue: number | null;
  negativeChildRawValue: number | null;
}

function parentOrder(actions: KataCatM39RankedAction[]): KataCatM39RankedAction[] {
  return [...actions].sort((left, right) => {
    if (left.parentRank !== right.parentRank) return left.parentRank - right.parentRank;
    return left.actionIndex - right.actionIndex;
  });
}

/**
 * Conservative deterministic correction contract for M3.9 diagnostics.
 *
 * - A parent action already proved safe is immutable.
 * - A proved-refuted action is never promoted over an unrefuted action.
 * - If every action is proved losing, the parent choice is preserved.
 *
 * This helper is diagnostic-only and is not wired into shipped HARD/VERY_HARD play.
 */
export function applyKataCatM39DeterministicCorrection(
  actions: KataCatM39RankedAction[],
): KataCatM39CorrectionResult {
  if (actions.length === 0) throw new Error("KataCat M3.9 correction received no root actions");
  const ordered = parentOrder(actions);
  const parent = ordered.find((action) => action.selectedByParent);
  if (!parent) throw new Error("KataCat M3.9 correction could not find the parent selection");

  if (parent.verificationStatus === "VERIFIED_SAFE") {
    return {
      actionIndex: parent.actionIndex,
      parentActionIndex: parent.actionIndex,
      changed: false,
      safetyLocked: true,
      allActionsRefuted: false,
      reason: "PARENT_VERIFIED_SAFE_LOCK",
    };
  }

  const nonRefuted = ordered.find((action) => action.verificationStatus !== "REFUTED");
  if (nonRefuted) {
    return {
      actionIndex: nonRefuted.actionIndex,
      parentActionIndex: parent.actionIndex,
      changed: nonRefuted.actionIndex !== parent.actionIndex,
      safetyLocked: false,
      allActionsRefuted: false,
      reason: "TOP_NON_REFUTED_PARENT_RANK",
    };
  }

  return {
    actionIndex: parent.actionIndex,
    parentActionIndex: parent.actionIndex,
    changed: false,
    safetyLocked: false,
    allActionsRefuted: true,
    reason: "ALL_ACTIONS_REFUTED_KEEP_PARENT",
  };
}

function outcomePairType(outcome?: string | null): KataCatM39PairwiseExample["pairType"] {
  if (outcome === "VERIFIED_RESCUE") return "VERIFIED_RESCUE_OVER_REFUTED";
  if (outcome === "VERIFIED_ADAPTIVE") return "VERIFIED_ADAPTIVE_OVER_REFUTED";
  if (outcome === "VERIFIED_EXHAUSTIVE_FALLBACK") {
    return "VERIFIED_EXHAUSTIVE_OVER_REFUTED";
  }
  return "VERIFIED_SAFE_OVER_REFUTED";
}

/** Build bounded same-root ranking pairs without treating unverified actions as negatives. */
export function buildKataCatM39PairwiseExamples(
  actions: KataCatM39RankedAction[],
  maximumNegatives = 8,
): KataCatM39PairwiseExample[] {
  const ordered = parentOrder(actions);
  const positive = ordered.find(
    (action) => action.selectedByParent && action.verificationStatus === "VERIFIED_SAFE",
  );
  if (!positive) return [];

  const negatives = ordered
    .filter((action) => action.verificationStatus === "REFUTED")
    .slice(0, Math.max(0, Math.floor(maximumNegatives)));

  return negatives.map((negative) => {
    let pairType = outcomePairType(positive.selectionOutcome);
    if (
      negative.meanValue !== null
      && negative.meanValue !== undefined
      && positive.meanValue !== null
      && positive.meanValue !== undefined
      && negative.meanValue > positive.meanValue
    ) {
      pairType = "SAFE_SELECTION_OVER_HIGHER_Q_REFUTED";
    }
    if (
      negative.childRawValue !== null
      && negative.childRawValue !== undefined
      && positive.childRawValue !== null
      && positive.childRawValue !== undefined
      && negative.childRawValue > positive.childRawValue
    ) {
      pairType = "SAFE_SELECTION_OVER_HIGHER_RAW_VALUE_REFUTED";
    }
    return {
      positiveAction: positive.actionIndex,
      negativeAction: negative.actionIndex,
      pairType,
      positiveParentRank: positive.parentRank,
      negativeParentRank: negative.parentRank,
      positiveVisits: positive.visits ?? null,
      negativeVisits: negative.visits ?? null,
      positiveMeanValue: positive.meanValue ?? null,
      negativeMeanValue: negative.meanValue ?? null,
      positiveChildRawValue: positive.childRawValue ?? null,
      negativeChildRawValue: negative.childRawValue ?? null,
    };
  });
}
