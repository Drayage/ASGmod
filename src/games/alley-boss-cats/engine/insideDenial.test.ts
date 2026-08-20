import { beforeEach, describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import { applyAIVariant } from "../aiVariant";
import { createInitialState } from "../rules";
import { findBestMoveVeryHard, lastDecision } from "./minimax";
import type { GameState } from "../types";

const COLS = "ABCDEFGHI";
const point = (name: string) => ({ row: Number(name.slice(1)) - 1, col: COLS.indexOf(name[0]) });
const play = (names: string[]): GameState =>
  names.reduce<GameState>(
    (state, name) => applyAction(state, { type: "PLACE", ...point(name) }),
    createInitialState(),
  );

/**
 * The position that produced the change: game 1 of 2026-08-20, engine to play
 * move 13. The human's stones lean on the bottom and right rims and nine turns
 * later the region closes at twelve cells with a single stone.
 *
 * What the engine could see of it was one point, F9, on the modelled corner cut
 * — and F9 dies. So stage 1.87 named its reason, had it refuted, and widened to
 * an ordinary search, five turns running. This locks in that it no longer does.
 */
const TURN_13 = ["H3", "H7", "G2", "G8", "C2", "B3", "B7", "C8", "D1", "E8", "A6", "I6"];

/**
 * Stage 1.87 reads frameworks on a fixed 300ms wall-clock slice, so on a loaded
 * machine the read can come back empty and the ladder falls past the stage
 * entirely — which says nothing either way about what this file is testing. So
 * take the first attempt that got far enough to have an opinion, and only fail
 * if none of them did.
 */
function decideAt1_87(state: GameState) {
  let chosen = findBestMoveVeryHard(state, "A", 1200);
  for (let attempt = 0; attempt < 4 && !lastDecision.stage.startsWith("1.87"); attempt += 1) {
    chosen = findBestMoveVeryHard(state, "A", 1200);
  }
  expect(lastDecision.stage, "stage 1.87 never fired — framework read starved?").toContain("1.87");
  return { chosen, stage: lastDecision.stage };
}

describe("denying a framework from inside it", () => {
  beforeEach(() => {
    applyAIVariant("EYE_INSIDE");
  });

  it("gives the reason up when the wall is all that can be offered", () => {
    const { stage } = decideAt1_87(play(TURN_13));
    expect(stage).toContain("widened");
  });

  it("keeps the reason by playing inside the frame instead", () => {
    applyAIVariant("EYE_DENY");
    const { chosen, stage } = decideAt1_87(play(TURN_13));
    expect(stage).toContain("inside");
    expect(stage).not.toContain("widened");
    // Inside the shape it is denying, not somewhere else on the board: the
    // human's stones here sit on rows 7-9 and columns G-I.
    expect(chosen.type).toBe("PLACE");
    if (chosen.type !== "PLACE") return;
    expect(chosen.row).toBeGreaterThanOrEqual(5);
    expect(chosen.col).toBeGreaterThanOrEqual(4);
  });

  it("leaves every other variant on the old path", () => {
    const state = play(TURN_13);
    for (const variant of ["EYE_FRAME_TIGHT", "EYE_STRIP", "STANDARD"] as const) {
      applyAIVariant(variant);
      findBestMoveVeryHard(state, "A", 800);
      expect(lastDecision.stage, variant).not.toContain("inside");
    }
  });
});
