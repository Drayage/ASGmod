import { describe, expect, it } from "vitest";
import { AI_VARIANTS, RETIRED_VARIANTS, applyAIVariant, variantLabel } from "./aiVariant";
import type { AIVariant } from "./aiVariant";

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
    expect(AI_VARIANTS).toHaveLength(3);
    expect(AI_VARIANTS[0].value).toBe("EYE_FRAME_TIGHT");
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
