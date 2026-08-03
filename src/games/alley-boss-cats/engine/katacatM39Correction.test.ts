import { describe, expect, it } from "vitest";
import {
  applyKataCatM39DeterministicCorrection,
  buildKataCatM39PairwiseExamples,
  type KataCatM39RankedAction,
} from "./katacatM39Correction";

function action(
  actionIndex: number,
  parentRank: number,
  verificationStatus: KataCatM39RankedAction["verificationStatus"],
  selectedByParent = false,
  extra: Partial<KataCatM39RankedAction> = {},
): KataCatM39RankedAction {
  return { actionIndex, parentRank, verificationStatus, selectedByParent, ...extra };
}

describe("KataCat M3.9 deterministic correction contract", () => {
  it("never displaces a parent verified-safe action", () => {
    const result = applyKataCatM39DeterministicCorrection([
      action(4, 1, "REFUTED", false, { meanValue: 0.9 }),
      action(7, 2, "VERIFIED_SAFE", true, { meanValue: 0.1 }),
      action(9, 3, "UNVERIFIED"),
    ]);

    expect(result).toEqual({
      actionIndex: 7,
      parentActionIndex: 7,
      changed: false,
      safetyLocked: true,
      allActionsRefuted: false,
      reason: "PARENT_VERIFIED_SAFE_LOCK",
    });
  });

  it("removes proved-refuted choices without inventing safety", () => {
    const result = applyKataCatM39DeterministicCorrection([
      action(4, 1, "REFUTED", true),
      action(7, 2, "UNVERIFIED"),
      action(9, 3, "REFUTED"),
    ]);

    expect(result.actionIndex).toBe(7);
    expect(result.changed).toBe(true);
    expect(result.safetyLocked).toBe(false);
    expect(result.reason).toBe("TOP_NON_REFUTED_PARENT_RANK");
  });

  it("keeps the parent choice when every root is proved losing", () => {
    const result = applyKataCatM39DeterministicCorrection([
      action(4, 1, "REFUTED", true),
      action(7, 2, "REFUTED"),
    ]);

    expect(result.actionIndex).toBe(4);
    expect(result.changed).toBe(false);
    expect(result.allActionsRefuted).toBe(true);
    expect(result.reason).toBe("ALL_ACTIONS_REFUTED_KEEP_PARENT");
  });

  it("builds same-root safe-over-refuted pairs and flags search overvaluation", () => {
    const pairs = buildKataCatM39PairwiseExamples([
      action(7, 2, "VERIFIED_SAFE", true, {
        selectionOutcome: "VERIFIED_RESCUE",
        visits: 5,
        meanValue: 0.2,
        childRawValue: 0.1,
      }),
      action(4, 1, "REFUTED", false, {
        visits: 20,
        meanValue: 0.8,
        childRawValue: 0.7,
        provenCaptureLoss: true,
      }),
      action(9, 3, "UNVERIFIED"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      positiveAction: 7,
      negativeAction: 4,
      pairType: "SAFE_SELECTION_OVER_HIGHER_RAW_VALUE_REFUTED",
      positiveParentRank: 2,
      negativeParentRank: 1,
    });
  });

  it("does not use unverified actions as negative labels", () => {
    const pairs = buildKataCatM39PairwiseExamples([
      action(7, 1, "VERIFIED_SAFE", true),
      action(9, 2, "UNVERIFIED"),
    ]);
    expect(pairs).toEqual([]);
  });
});
