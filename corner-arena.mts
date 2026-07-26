/**
 * Corner-opening hypothesis arena.
 *
 * Every game is BASELINE VERY_HARD vs a policy-wrapped VERY_HARD (see
 * corner-policy.mts) -- same search, same evaluation, same time budget on
 * both sides, the only difference being which move the policy substitutes
 * during a bounded opening window before any local fight has started at the
 * corner it acts on.
 *
 * Reproducibility note: the opening-point shuffle and any tie-breaking this
 * script itself does are seeded (mulberry32), so those parts are exactly
 * repeatable given the same seed. findBestMoveVeryHard's own iterative
 * deepening is wall-clock budgeted (Date.now() deadlines throughout
 * minimax.ts), so the search itself is not bit-for-bit reproducible between
 * runs even at a fixed seed -- that is a property of the shipped engine,
 * not something this script can control without changing it, which the
 * brief asked not to do.
 */
import {
  CORNERS,
  DEFAULT_POLICY_WINDOW_PLIES,
  PolicyState,
  cornerStats,
  decideWithPolicy,
  hasNarrowSafePool,
} from "./corner-policy.mts";
import type { PolicyMode, PolicyName } from "./corner-policy.mts";
import {
  applyMove,
  createInitialState,
  isLegalMove,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import type { AIAction } from "./src/games/alley-boss-cats/ai";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.SEED ?? 20260726);
const rng = mulberry32(SEED);
const shuffle = <T>(xs: readonly T[]): T[] => {
  const arr = [...xs];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const BUDGET_MS = Number(process.env.BUDGET_MS ?? 500);
const GAMES_PER_MATCHUP = Number(process.env.GAMES ?? 10);
const WINDOW_PLIES = Number(process.env.WINDOW_PLIES ?? DEFAULT_POLICY_WINDOW_PLIES);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 160);
const RANDOM_OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 2);

/** Same third-line/star points ai-arena.mts uses, for the same reason: a
 * uniformly random opening seeds weak, scattered cats and turns every game
 * into a capture race before either engine has said anything interesting. */
const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6],
  [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5],
  [2, 3], [3, 2], [5, 6], [6, 5],
];

const FORCED_FOLLOW_CAP = 6;

interface PolicySideSpec {
  policy: PolicyName;
  mode: PolicyMode;
}

interface GameOutcome {
  winner: Player;
  winReason: string;
  policySide: Player;
  baselineSide: Player;
  policyWon: boolean;
  territoryPolicy: number;
  territoryBaseline: number;
  capturedSide: "POLICY" | "BASELINE" | null;
  primaryCorner: string | null;
  cornerTerritoryPolicy: number;
  cornerStonesPolicy: number;
  cornerStonesBaseline: number;
  fireCount: number;
  deviatedCount: number;
  forcedFollowPlies: number;
  plies: number;
}

function playGame(policySide: Player, spec: PolicySideSpec): GameOutcome {
  const baselineSide: Player = policySide === "A" ? "B" : "A";
  let state = createInitialState();
  const states: GameState[] = [state];
  const policyState = new PolicyState();

  const openings = shuffle(OPENING_POINTS);
  for (let i = 0, taken = 0; i < openings.length && taken < RANDOM_OPENING_PLIES; i++) {
    const [row, col] = openings[i];
    if (!isLegalMove(state, row, col, state.currentPlayer)) continue;
    state = applyMove(state, row, col);
    states.push(state);
    taken += 1;
  }

  let firstCornerFirePly: number | null = null;

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    if (state.winner) break;
    const player = state.currentPlayer;
    const isPolicyTurn = player === policySide;

    const action: AIAction = isPolicyTurn
      ? decideWithPolicy(state, player, spec.policy, spec.mode, policyState, BUDGET_MS, WINDOW_PLIES)
      : decideWithPolicy(state, player, "BASELINE", "FORCE", policyState, BUDGET_MS, WINDOW_PLIES);

    if (isPolicyTurn && firstCornerFirePly === null && policyState.primaryCorner !== null) {
      firstCornerFirePly = states.length; // ply index right after this move lands
    }

    state = action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
    states.push(state);
  }

  const territoryPolicy = state.territories[policySide].length;
  const territoryBaseline = state.territories[baselineSide].length;
  const capturedSide: GameOutcome["capturedSide"] =
    state.winReason === "CAPTURE" ? (state.winner === policySide ? "BASELINE" : "POLICY") : null;

  const cs = policyState.primaryCorner
    ? cornerStats(state, policyState.primaryCorner, policySide)
    : { stonesPlaced: 0, territoryCells: 0 };
  const csBaseline = policyState.primaryCorner
    ? cornerStats(state, policyState.primaryCorner, baselineSide)
    : { stonesPlaced: 0, territoryCells: 0 };

  // Forced-follow-plies: starting right after the policy's first successful
  // placement, count consecutive policy-side turns whose move both (a)
  // lands in the same corner zone and (b) was taken while getSafeActions
  // had already narrowed to a handful of options -- a proxy for "this
  // follow-through wasn't really optional".
  let forcedFollowPlies = 0;
  if (firstCornerFirePly !== null) {
    for (let i = firstCornerFirePly; i < states.length && forcedFollowPlies < FORCED_FOLLOW_CAP; i++) {
      const beforeState = states[i - 1];
      if (beforeState.currentPlayer !== policySide) continue;
      const afterState = states[i];
      const move = afterState.moveHistory[afterState.moveHistory.length - 1];
      if (!move || move.type !== "PLACE") break;
      if (!isMoveInCorner(move.row, move.col, policyState.primaryCorner!)) break;
      if (!hasNarrowSafePool(beforeState, policySide)) break;
      forcedFollowPlies += 1;
    }
  }

  return {
    winner: state.winner!,
    winReason: state.winReason ?? "PLY_CAP",
    policySide,
    baselineSide,
    policyWon: state.winner === policySide,
    territoryPolicy,
    territoryBaseline,
    capturedSide,
    primaryCorner: policyState.primaryCorner,
    cornerTerritoryPolicy: cs.territoryCells,
    cornerStonesPolicy: cs.stonesPlaced,
    cornerStonesBaseline: csBaseline.stonesPlaced,
    fireCount: policyState.fireLog.length,
    deviatedCount: policyState.fireLog.filter((f) => f.deviated).length,
    forcedFollowPlies,
    plies: state.moveHistory.length,
  };
}

function isMoveInCorner(row: number, col: number, cornerName: string): boolean {
  const frame = CORNERS.find((f) => f.name === cornerName)!;
  const i = frame.sr === 1 ? row - frame.corner.row : frame.corner.row - row;
  const j = frame.sc === 1 ? col - frame.corner.col : frame.corner.col - col;
  return i >= 0 && i <= 3 && j >= 0 && j <= 3;
}

function mean(xs: number[]): string {
  return xs.length === 0 ? "-" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
}

function runMatchup(spec: PolicySideSpec, games: number) {
  const outcomes: GameOutcome[] = [];
  for (let i = 0; i < games; i++) {
    const policySide: Player = i % 2 === 0 ? "A" : "B";
    outcomes.push(playGame(policySide, spec));
  }

  const wins = outcomes.filter((o) => o.policyWon).length;
  const captured = { POLICY: 0, BASELINE: 0, none: 0 };
  for (const o of outcomes) {
    if (o.capturedSide === "POLICY") captured.POLICY += 1;
    else if (o.capturedSide === "BASELINE") captured.BASELINE += 1;
    else captured.none += 1;
  }
  const fired = outcomes.filter((o) => o.primaryCorner !== null);

  const report = {
    policy: spec.policy,
    mode: spec.mode,
    games,
    wins,
    winRatePct: Math.round((wins / games) * 100),
    firedInGames: fired.length,
    avgFireCount: mean(outcomes.map((o) => o.fireCount)),
    avgDeviatedCount: mean(outcomes.map((o) => o.deviatedCount)),
    avgCornerTerritoryPolicy: mean(fired.map((o) => o.cornerTerritoryPolicy)),
    avgCornerStonesPolicy: mean(fired.map((o) => o.cornerStonesPolicy)),
    avgCornerStonesBaseline: mean(fired.map((o) => o.cornerStonesBaseline)),
    avgTerritoryDiff: mean(outcomes.map((o) => o.territoryPolicy - o.territoryBaseline)),
    avgPlies: mean(outcomes.map((o) => o.plies)),
    capturedPolicySide: captured.POLICY,
    capturedBaselineSide: captured.BASELINE,
    noCaptureGames: captured.none,
    avgForcedFollowPlies: mean(fired.map((o) => o.forcedFollowPlies)),
  };

  console.log(JSON.stringify(report));
  return report;
}

const policiesEnv = process.env.POLICIES;
const modesEnv = process.env.MODES;
const allPolicies: PolicyName[] = policiesEnv
  ? (policiesEnv.split(",") as PolicyName[])
  : [
      "CORNER_11",
      "CORNER_22",
      "RESPOND_22_WITH_11",
      "RESPOND_22_WITH_EDGE",
      "RESPOND_11_WITH_EDGE",
    ];
const allModes: PolicyMode[] = modesEnv ? (modesEnv.split(",") as PolicyMode[]) : ["FORCE", "BOOST"];

console.error(
  `seed=${SEED} budget=${BUDGET_MS}ms games/matchup=${GAMES_PER_MATCHUP} window=${WINDOW_PLIES}ply ` +
    `policies=${allPolicies.join(",")} modes=${allModes.join(",")}`,
);

for (const policy of allPolicies) {
  for (const mode of allModes) {
    runMatchup({ policy, mode }, GAMES_PER_MATCHUP);
  }
}
