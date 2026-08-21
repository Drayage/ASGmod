import { describe, expect, it } from "vitest";
import { AI_VARIANTS, RETIRED_VARIANTS, applyAIVariant } from "./aiVariant";
import type { AIVariant } from "./aiVariant";
import { sealedLibertyThreshold, tuning } from "./ai";
import * as frameworks from "./engine/frameworks";
import * as minimax from "./engine/minimax";
import * as moveOrdering from "./engine/moveOrdering";
import * as planner from "./engine/territoryPlanner";

/**
 * What every variant switches on, written down.
 *
 * `applyAIVariant` sets every switch on every call, so a variant is meant to be
 * a complete description of the engine rather than a diff against whatever ran
 * last. Nothing checked that, and adding a variant means touching a dozen
 * `variant === "..."` chains by hand — the exact edit where one gets missed and
 * a different variant quietly changes.
 *
 * The table is deliberately literal. It is not derived from `applyAIVariant`,
 * because a table derived from the code under test only proves the code equals
 * itself; it is the intended wiring, written out, so a change has to be made
 * twice on purpose.
 *
 * Retired variants are covered too. Forty-odd recorded games are labelled with
 * these names and a resumed game has to play as the engine that started it, so
 * their wiring is as much a contract as the live ones'.
 */

/** Every switch a variant is allowed to move, and how to read it now. */
const SWITCHES = {
  cornerBook: () => minimax.cornerBookEnabled,
  cornerBookFinish: () => minimax.cornerBookFinishEnabled,
  cornerBookSpread: () => minimax.cornerBookSpreadEnabled,
  cornerBookFollow: () => minimax.cornerBookFollowEnabled,
  cornerAnswerInside: () => minimax.cornerAnswerInsideEnabled,
  cornerBookLeaveContested: () => minimax.cornerBookLeaveContestedEnabled,
  frameworkInsideDenial: () => minimax.frameworkInsideDenialEnabled,
  eyeMakingDefence: () => minimax.eyeMakingDefenceEnabled,
  thinGroupGuard: () => minimax.thinGroupGuardEnabled,
  selfInflictedSealedGuard: () => minimax.selfInflictedSealedGuardEnabled,
  oneMoveSealedTrapGuard: () => minimax.oneMoveSealedTrapGuardEnabled,
  edgeStripFrames: () => frameworks.edgeStripFramesEnabled,
  edgeFraming: () => moveOrdering.edgeFramingEnabled,
  settledOutOfInfluence: () => planner.settledOutOfInfluenceEnabled,
} as const;

type Switch = keyof typeof SWITCHES;

/** Switches each variant turns ON. Everything absent must be off. */
const WIRING: Record<AIVariant, Switch[]> = {
  STANDARD: ["settledOutOfInfluence"],
  EYE: ["eyeMakingDefence", "settledOutOfInfluence"],
  THIN_GUARD: ["thinGroupGuard", "settledOutOfInfluence"],
  EYE_THIN: ["eyeMakingDefence", "thinGroupGuard", "settledOutOfInfluence"],
  EYE_EDGE: ["eyeMakingDefence", "edgeFraming", "settledOutOfInfluence"],
  EYE_SPACING: ["eyeMakingDefence", "settledOutOfInfluence"],
  EYE_CORNER: ["eyeMakingDefence", "cornerBook", "settledOutOfInfluence"],
  EYE_CORNER_DIAG: ["eyeMakingDefence", "cornerBook", "settledOutOfInfluence"],
  EYE_FRAME: ["eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread", "settledOutOfInfluence"],
  EYE_FRAME_TIGHT: ["eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread", "settledOutOfInfluence"],
  EYE_FOLLOW: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "cornerBookFollow", "settledOutOfInfluence",
  ],
  EYE_INSIDE: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "cornerAnswerInside", "cornerBookLeaveContested", "settledOutOfInfluence",
  ],
  EYE_PAIR: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "cornerBookLeaveContested", "settledOutOfInfluence",
  ],
  EYE_DENY: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "cornerAnswerInside", "cornerBookLeaveContested", "frameworkInsideDenial",
    "settledOutOfInfluence",
  ],
  EYE_STRIP: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "edgeStripFrames", "settledOutOfInfluence",
  ],
  EYE_SEALGATE: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "settledOutOfInfluence",
  ],
  EYE_SEALWALK: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "selfInflictedSealedGuard", "settledOutOfInfluence",
  ],
  EYE_LONETRAP: [
    "eyeMakingDefence", "cornerBook", "cornerBookFinish", "cornerBookSpread",
    "oneMoveSealedTrapGuard", "settledOutOfInfluence",
  ],
};

const everyName: AIVariant[] = [
  ...AI_VARIANTS.map((v) => v.value),
  ...RETIRED_VARIANTS.map((v) => v.value),
];

describe("variant wiring", () => {
  it("covers every name a record can carry", () => {
    for (const name of everyName) expect(WIRING[name], name).toBeDefined();
  });

  it.each(everyName)("%s switches on exactly what it claims", (variant) => {
    applyAIVariant(variant);
    const expected = new Set<Switch>(WIRING[variant]);
    for (const name of Object.keys(SWITCHES) as Switch[]) {
      expect(SWITCHES[name](), `${variant} / ${name}`).toBe(expected.has(name));
    }
  });

  /**
   * The numeric settings are separate: a variant that reaches them is naming a
   * value, not flipping a switch, and a wrong value is silent in a way a wrong
   * boolean is not.
   */
  it("sets the numeric knobs only where a variant asks for them", () => {
    applyAIVariant("EYE_SEALGATE");
    expect(sealedLibertyThreshold).toBe(5);
    expect(tuning.sealedWeight).toBe(150);

    applyAIVariant("EYE_INSIDE");
    expect(sealedLibertyThreshold).toBe(3);
    expect(tuning.sealedWeight).toBe(0);

    applyAIVariant("EYE_CORNER_DIAG");
    expect(moveOrdering.ownDiagonalBonus).toBeGreaterThan(0);
    applyAIVariant("EYE_FRAME_TIGHT");
    expect(moveOrdering.ownDiagonalBonus).toBe(0);

    applyAIVariant("EYE_SPACING");
    expect(moveOrdering.contactBias).toBe(0);
    applyAIVariant("EYE");
    expect(moveOrdering.contactBias).toBe(1);
  });

  /**
   * The guards that ship on in every variant. They are on by module default
   * rather than by any variant, so nothing in `applyAIVariant` mentions them —
   * which is exactly how one could be turned off and nobody would notice.
   */
  it("leaves the always-on guards alone", () => {
    for (const variant of everyName) {
      applyAIVariant(variant);
      expect(minimax.selfInflictedThinGuardEnabled, variant).toBe(true);
      expect(minimax.oneMoveTrapGuardEnabled, variant).toBe(true);
      expect(minimax.dominatedPocketGuardEnabled, variant).toBe(true);
      expect(minimax.existingGroupDangerRankingEnabled, variant).toBe(true);
      expect(minimax.pocketSealDangerGuardEnabled, variant).toBe(true);
      expect(minimax.pocketSealDenialFilterEnabled, variant).toBe(true);
      expect(minimax.frameworkGuardEnabled, variant).toBe(true);
      expect(minimax.opponentFrameworkGuardEnabled, variant).toBe(true);
      expect(minimax.largerEnclosureEnabled, variant).toBe(true);
      expect(minimax.ttScoresEnabled, variant).toBe(true);
      expect(moveOrdering.decisivePointsEnabled, variant).toBe(true);
    }
  });
});
