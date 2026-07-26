/**
 * Local best-play comparison: from identical starting positions, compare
 * (2,2)->(1,1) vs (2,2)->edge-attach vs (1,1)->edge-attach directly, by
 * letting BOTH sides play plain, unmodified findBestMoveVeryHard from each
 * branch point to game end, repeated to average out the engine's own
 * wall-clock search jitter. This does not go through corner-arena.mts's
 * self-play win-rate loop at all -- it is a narrower, more exact comparison
 * of the three specific replies the conversation asked about, from one fixed
 * position each.
 *
 * Setup: A opens with a neutral, unrelated developing move (BR corner's 1,1
 * point) so the position isn't a bare empty board, then B plays the TL
 * corner's 2,2 (or 1,1) point. It is then A's turn -- exactly the decision
 * point being compared.
 */
import { betterByEval, CORNERS, cornerPoints, cornerStats } from "./corner-policy.mts";
import { applyMove, createInitialState, passTurn } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import type { GameState } from "./src/games/alley-boss-cats/types";

const BUDGET_MS = Number(process.env.BUDGET_MS ?? 600);
const REPEATS = Number(process.env.REPEATS ?? 12);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 160);

const TL = CORNERS[0];
const BR = CORNERS[3];
const tlPts = cornerPoints(TL);
const brPts = cornerPoints(BR);

function baseSetup(trigger: "p22" | "p11"): GameState {
  let state = createInitialState();
  state = applyMove(state, brPts.p11.row, brPts.p11.col); // A: neutral developing move
  const target = trigger === "p22" ? tlPts.p22 : tlPts.p11;
  state = applyMove(state, target.row, target.col); // B: the corner trigger
  return state;
}

function playOut(state: GameState): GameState {
  for (let ply = 0; ply < MAX_PLIES; ply++) {
    if (state.winner) break;
    const player = state.currentPlayer;
    const action = findBestMoveVeryHard(state, player, BUDGET_MS);
    state = action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
  }
  return state;
}

interface BranchResult {
  label: string;
  aWins: number;
  /** A won this repeat by capturing one of B's groups outright. */
  aCapturedOpponent: number;
  /** B won this repeat by capturing one of A's groups outright. */
  aWasCaptured: number;
  territoryDiffs: number[]; // A - B
  cornerTerritoryA: number[];
  totalPlies: number[];
}

function runBranch(label: string, makeStartingState: () => GameState): BranchResult {
  const result: BranchResult = {
    label,
    aWins: 0,
    aCapturedOpponent: 0,
    aWasCaptured: 0,
    territoryDiffs: [],
    cornerTerritoryA: [],
    totalPlies: [],
  };

  for (let i = 0; i < REPEATS; i++) {
    const start = makeStartingState();
    const final = playOut(start);
    if (final.winner === "A") result.aWins += 1;
    if (final.winReason === "CAPTURE") {
      if (final.winner === "A") result.aCapturedOpponent += 1;
      else result.aWasCaptured += 1;
    }
    result.territoryDiffs.push(final.territories.A.length - final.territories.B.length);
    result.cornerTerritoryA.push(cornerStats(final, "TL", "A").territoryCells);
    result.totalPlies.push(final.moveHistory.length);
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  return result;
}

function mean(xs: number[]): string {
  return xs.length === 0 ? "-" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
}

function report(r: BranchResult) {
  console.log(
    JSON.stringify({
      label: r.label,
      repeats: REPEATS,
      aWinRatePct: Math.round((r.aWins / REPEATS) * 100),
      aCapturedTheOpponent: r.aCapturedOpponent,
      aWasCaptured: r.aWasCaptured,
      avgTerritoryDiffAminusB: mean(r.territoryDiffs),
      avgCornerTerritoryA: mean(r.cornerTerritoryA),
      avgPlies: mean(r.totalPlies),
    }),
  );
}

console.error(`budget=${BUDGET_MS}ms repeats=${REPEATS}`);

// Branch 1: opponent (B) plays (2,2); A replies (1,1).
const branch1 = runBranch("(2,2) -> (1,1)", () => {
  let state = baseSetup("p22");
  state = applyMove(state, tlPts.p11.row, tlPts.p11.col);
  return state;
});
report(branch1);

// Branch 2: opponent (B) plays (2,2); A replies with the better-scoring arm.
const branch2 = runBranch("(2,2) -> edge-attach", () => {
  let state = baseSetup("p22");
  const pick = betterByEval(state, "A", tlPts.armR, tlPts.armC)!;
  state = applyMove(state, pick.row, pick.col);
  return state;
});
report(branch2);

// Branch 3: opponent (B) plays (1,1); A replies with the better-scoring arm.
const branch3 = runBranch("(1,1) -> edge-attach", () => {
  let state = baseSetup("p11");
  const pick = betterByEval(state, "A", tlPts.armR, tlPts.armC)!;
  state = applyMove(state, pick.row, pick.col);
  return state;
});
report(branch3);
