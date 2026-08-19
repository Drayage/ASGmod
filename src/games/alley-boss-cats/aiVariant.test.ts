import { describe, expect, it } from "vitest";
import { AI_VARIANTS, RETIRED_VARIANTS, applyAIVariant, variantLabel } from "./aiVariant";
import type { AIVariant } from "./aiVariant";
import { cornerBookFollowEnabled } from "./engine/minimax";
import { sealedLibertyThreshold, tuning } from "./ai";
import { oneMoveSealedTrapGuardEnabled, selfInflictedSealedGuardEnabled } from "./engine/minimax";

/**
 * Retiring a variant is a change to the picker, not to the record. These pin the
 * two things that have to keep holding: every name a recorded game could carry
 * is still applicable, so resuming one plays the engine that started it, and
 * every name still has a label to show.
 */
const everyName: AIVariant[] = [
  ...AI_VARIANTS.map((v) => v.value),
  ...RETIRED_VARIANTS.map((v) => v.value),
];

describe("the variant list", () => {
  it("offers only live hypotheses, with the current engine first", () => {
    expect(AI_VARIANTS).toHaveLength(9);
    expect(AI_VARIANTS[0].value).toBe("EYE_FRAME_TIGHT");
  });

  it("puts the corner switches where the variant says", () => {
    // EYE_FOLLOW is the one live variant that differs from the default by a
    // single switch, so the switch is what the recorded games will be split by.
    applyAIVariant("EYE_FOLLOW");
    expect(cornerBookFollowEnabled).toBe(true);
    applyAIVariant("EYE_FRAME_TIGHT");
    expect(cornerBookFollowEnabled).toBe(false);
    // And every other name leaves it off, so no retired record replays with it.
    for (const name of everyName) {
      applyAIVariant(name);
      expect(cornerBookFollowEnabled).toBe(name === "EYE_FOLLOW");
    }
  });

  it("removes the walk-into-a-death-spot guard only for EYE_SEALWALK", () => {
    applyAIVariant("EYE_SEALWALK");
    expect(selfInflictedSealedGuardEnabled).toBe(true);
    for (const name of everyName) {
      applyAIVariant(name);
      expect(selfInflictedSealedGuardEnabled).toBe(name === "EYE_SEALWALK");
    }
  });

  it("removes the isolated-placement guard only for EYE_LONETRAP", () => {
    for (const name of everyName) {
      applyAIVariant(name);
      expect(oneMoveSealedTrapGuardEnabled).toBe(name === "EYE_LONETRAP");
    }
  });

  it("widens the sealed gate only for EYE_SEALGATE", () => {
    applyAIVariant("EYE_SEALGATE");
    expect(sealedLibertyThreshold).toBe(5);
    expect(tuning.sealedWeight).toBe(150);
    for (const name of everyName) {
      applyAIVariant(name);
      if (name === "EYE_SEALGATE") {
        expect(sealedLibertyThreshold).toBe(5);
        expect(tuning.sealedWeight).toBeGreaterThan(0);
      } else {
        expect(sealedLibertyThreshold).toBe(3);
        expect(tuning.sealedWeight).toBe(0);
      }
    }
  });

  it("never lists a name in both places", () => {
    const live = new Set(AI_VARIANTS.map((v) => v.value));
    for (const retired of RETIRED_VARIANTS) expect(live.has(retired.value)).toBe(false);
    expect(new Set(everyName).size).toBe(everyName.length);
  });

  it("still applies every name a record could carry", () => {
    for (const name of everyName) expect(() => applyAIVariant(name)).not.toThrow();
  });

  it("labels retired names as well as live ones", () => {
    for (const name of everyName) expect(variantLabel(name)).not.toBe("");
    expect(variantLabel(undefined)).toBe("기록 없음");
  });
});
