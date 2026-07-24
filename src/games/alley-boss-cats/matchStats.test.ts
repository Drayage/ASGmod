import { describe, expect, it } from "vitest";
import { computeMatchStats } from "./matchStats";
import { applyMove, createInitialState } from "./rules";

describe("computeMatchStats", () => {
  it("counts placements, territory, and threats from a capture-ending game", () => {
    // Games always start with A (createInitialState's default), so this
    // sequence — unlike the ad hoc "B goes first" setups in rules.test.ts —
    // must replay correctly through computeMatchStats's from-scratch replay.
    let state = createInitialState();
    state = applyMove(state, 0, 0); // A elsewhere
    state = applyMove(state, 3, 3); // B's lone cat
    state = applyMove(state, 2, 3); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 3, 2); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 3, 4); // A leaves B in atari
    state = applyMove(state, 5, 7); // B elsewhere
    state = applyMove(state, 4, 3); // A captures

    expect(state.winner).toBe("A");
    const stats = computeMatchStats(state, "A", Date.now() - 5000);
    expect(stats.totalPlacements).toBe(9);
    expect(stats.durationMs).toBeGreaterThanOrEqual(5000);
    // A's placements at (2,3), (3,2), (3,4) each closed in on B's lone cat —
    // the third of those (3,4) leaves B with exactly one liberty (atari).
    expect(stats.threatsCreated.A).toBeGreaterThanOrEqual(1);
  });

  it("computes the largest connected territory patch, not just the total count", () => {
    let state = createInitialState();
    // Two separate 1-cell corner pockets for A: (0,0) and (8,8).
    state = applyMove(state, 0, 1); // A
    state = applyMove(state, 5, 5); // B elsewhere
    state = applyMove(state, 1, 0); // A
    state = applyMove(state, 5, 6); // B elsewhere
    state = applyMove(state, 7, 8); // A
    state = applyMove(state, 5, 7); // B elsewhere
    state = applyMove(state, 8, 7); // A completes second pocket

    expect(state.territories.A).toHaveLength(2);
    const stats = computeMatchStats(state, "A", Date.now());
    expect(stats.winnerTerritory).toBe(2);
    expect(stats.largestTerritoryPatch).toBe(1);
  });
});
