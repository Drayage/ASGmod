import {
  applyAction,
  evaluateState,
  getSafeActions,
  opponentHasImmediateWin,
  rankByStaticEval,
} from "../ai";
import type { AIAction } from "../ai";
import type { GameState, Player } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";
import { findBestMoveMinimax } from "./minimax";
import { orderedCandidates } from "./moveOrdering";
import { planTerritory } from "./territoryPlanner";

const DEFAULT_EXPLORATION = Math.SQRT2;
const DEFAULT_PLAYOUT_DEPTH = 12;
const DEFAULT_ROOT_SCREEN_LIMIT = 8;
const DEFAULT_ROOT_SCREEN_MS = 45;
const DEFAULT_TREE_BRANCH_LIMIT = 8;
const DEFAULT_PLAYOUT_BRANCH_LIMIT = 5;
const CAPTURE_READ_DEPTH = 7;

export interface MCTSOptions {
  /** Fixed iteration budget. Prefer this in tests and arenas for reproducibility. */
  simulations?: number;
  /** Optional wall-clock budget for actual play, including root tactical work. */
  timeLimitMs?: number;
  /** Deterministic seed used for expansion and playout tie-breaking. */
  seed?: number;
  exploration?: number;
  playoutDepth?: number;
  /** Number of promising root moves to prove safe before MCTS. Zero skips the deep reader in fast tests. */
  rootScreenLimit?: number;
  /** Maximum capture-reader time per root candidate. */
  rootScreenMs?: number;
  /** Optional explicit alpha-beta baseline budget. Mainly useful for deterministic tests. */
  baselineSearchMs?: number;
  /** MCTS must complete at least this many simulations before it may override the baseline. */
  minimumSimulationsToOverride?: number;
}

export interface MCTSRootStat {
  action: AIAction;
  visits: number;
  meanValue: number;
}

export type MCTSSelection =
  | "IMMEDIATE_WIN"
  | "FORCED_CAPTURE"
  | "ONLY_ROOT_ACTION"
  | "BASELINE"
  | "MCTS";

export interface MCTSResult {
  action: AIAction;
  simulations: number;
  rootStats: MCTSRootStat[];
  selection: MCTSSelection;
  baselineAction?: AIAction;
}

interface Node {
  state: GameState;
  parent: Node | null;
  action: AIAction | null;
  playerToMove: Player;
  children: Node[];
  untriedActions: AIAction[];
  visits: number;
  valueSum: number;
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function sameAction(a: AIAction, b: AIAction): boolean {
  return actionKey(a) === actionKey(b);
}

function uniqueActions(actions: AIAction[]): AIAction[] {
  const seen = new Set<string>();
  const result: AIAction[] = [];
  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function terminalValue(state: GameState, rootPlayer: Player): number | null {
  if (!state.winner) return null;
  return state.winner === rootPlayer ? 1 : -1;
}

function boundedLeafValue(state: GameState, rootPlayer: Player): number {
  const terminal = terminalValue(state, rootPlayer);
  if (terminal !== null) return terminal;
  // Existing evaluation has intentionally huge tactical constants. tanh keeps
  // MCTS backup values in a stable [-1, 1] range while preserving ordering.
  return Math.tanh(evaluateState(state, rootPlayer) / 350);
}

/**
 * Cheap tree policy. The first experiment called getSafeActions and then the
 * full-board evaluation for every child of every node. A 1-second move therefore
 * completed barely more simulations than a 300ms move. This version ranks only
 * a small local candidate set and performs the inexpensive one-ply safety test.
 */
function fastSafeActions(state: GameState, limit: number): AIAction[] {
  const player = state.currentPlayer;
  const candidates = orderedCandidates(state, player, limit);

  if (candidates.length === 0) return [{ type: "PASS" }];

  const safe: AIAction[] = [];
  for (const action of candidates) {
    const next = applyAction(state, action);
    if (next.winner === player) return [action];
    if (next.winner) continue;
    if (!opponentHasImmediateWin(next, player)) safe.push(action);
  }

  // In a position where every shortlisted move loses immediately, keep the best
  // legal try. The root reader is stricter; this fallback only keeps simulations
  // moving in already-bad rollout positions.
  return safe.length > 0 ? safe : candidates;
}

function makeNode(
  state: GameState,
  parent: Node | null,
  action: AIAction | null,
  rootActions?: AIAction[],
): Node {
  return {
    state,
    parent,
    action,
    playerToMove: state.currentPlayer,
    children: [],
    untriedActions: rootActions ?? fastSafeActions(state, DEFAULT_TREE_BRANCH_LIMIT),
    visits: 0,
    valueSum: 0,
  };
}

function selectChild(node: Node, rootPlayer: Player, exploration: number): Node {
  let best = node.children[0];
  let bestScore = -Infinity;
  const perspective = node.playerToMove === rootPlayer ? 1 : -1;

  for (const child of node.children) {
    if (child.visits === 0) return child;
    const mean = child.valueSum / child.visits;
    const explore = exploration * Math.sqrt(Math.log(Math.max(1, node.visits)) / child.visits);
    const score = perspective * mean + explore;
    if (score > bestScore) {
      best = child;
      bestScore = score;
    }
  }
  return best;
}

function expand(node: Node, random: () => number): Node {
  // At the root, actions are deliberately ordered with the alpha-beta baseline
  // first. Expanding it first guarantees the confidence gate has a comparison.
  // Deeper in the tree a small random window prevents near-equal moves from being
  // deterministically starved.
  const window = Math.min(3, node.untriedActions.length);
  const index = node.parent === null ? 0 : Math.floor(random() * window);
  const [action] = node.untriedActions.splice(index, 1);
  const child = makeNode(applyAction(node.state, action), node, action);
  node.children.push(child);
  return child;
}

function choosePlayoutAction(state: GameState, random: () => number): AIAction {
  const actions = fastSafeActions(state, DEFAULT_PLAYOUT_BRANCH_LIMIT);
  const top = Math.min(4, actions.length);
  const index = random() < 0.78 ? 0 : Math.floor(random() * top);
  return actions[index] ?? { type: "PASS" };
}

function playout(state: GameState, rootPlayer: Player, random: () => number, maxDepth: number): number {
  let current = state;
  for (let depth = 0; depth < maxDepth && !current.winner; depth += 1) {
    current = applyAction(current, choosePlayoutAction(current, random));
  }
  return boundedLeafValue(current, rootPlayer);
}

function backup(node: Node, value: number): void {
  let current: Node | null = node;
  while (current) {
    current.visits += 1;
    current.valueSum += value;
    current = current.parent;
  }
}

/**
 * Keep MCTS focused on moves the shipped engine already considers strategically
 * plausible. Full evaluation is paid once at the root, not at every tree node.
 * When a large enclosure is imminent, the territory planner's answers are
 * explicitly retained even if they sit outside the static top group.
 */
function strategicRootShortlist(
  state: GameState,
  player: Player,
  actions: AIAction[],
  limit: number,
  preferred?: AIAction,
): AIAction[] {
  const candidateLimit = Math.max(2, limit || DEFAULT_ROOT_SCREEN_LIMIT);
  const ranked = rankByStaticEval(state, player, actions);
  const chosen = preferred ? [preferred, ...ranked.slice(0, candidateLimit)] : ranked.slice(0, candidateLimit);
  const allowed = new Set(actions.map(actionKey));
  const plan = planTerritory(state, player);

  if (plan.imminent) {
    const territorial = [...plan.blockingMoves, ...plan.expansionMoves];
    for (const action of territorial) {
      if (!allowed.has(actionKey(action))) continue;
      chosen.push(action);
    }
  }

  // Two extra slots are reserved for urgent territory moves. Keeping the root
  // narrow makes it possible to prove every candidate safe instead of silently
  // admitting dozens of unexamined moves, which caused the original 0-12 record.
  return uniqueActions(chosen).slice(0, candidateLimit + 2);
}

function screenRootActions(
  state: GameState,
  player: Player,
  actions: AIAction[],
  screenEnabled: boolean,
  perMoveCapMs: number,
  deadline: number,
  totalBudgetMs?: number,
): AIAction[] {
  if (!screenEnabled) return actions;

  const survivors: AIAction[] = [];
  const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : actions.length * perMoveCapMs;
  const screenBudget = totalBudgetMs ? Math.min(remaining, totalBudgetMs * 0.42) : remaining;
  const perMoveMs = Math.max(5, Math.min(perMoveCapMs, screenBudget / Math.max(1, actions.length)));

  for (const action of actions) {
    if (Date.now() >= deadline) break;
    const next = applyAction(state, action);
    if (next.winner === player) return [action];
    if (next.winner) continue;
    if (!opponentCanForceCapture(next, player, CAPTURE_READ_DEPTH, perMoveMs)) survivors.push(action);
  }

  // Only proven survivors enter MCTS. If every candidate is refuted (or the
  // reader could not complete even one), return the best legal try rather than
  // widening back out to the untested tail.
  return survivors.length > 0 ? survivors : actions.slice(0, 1);
}

/**
 * Experimental strategy search. The existing life-and-death reader defines the
 * tactical floor. A short alpha-beta search supplies a stable baseline, and MCTS
 * may override it only after enough simulations and a meaningful value lead.
 */
export function findBestMoveHybridMCTS(
  rootState: GameState,
  rootPlayer: Player,
  options: MCTSOptions = {},
): MCTSResult {
  if (rootState.currentPlayer !== rootPlayer) {
    throw new Error("Hybrid MCTS must search for the state's current player");
  }

  const startedAt = Date.now();
  const totalBudgetMs = options.timeLimitMs;
  const deadline = totalBudgetMs ? startedAt + totalBudgetMs : Number.POSITIVE_INFINITY;
  const screenLimit = options.rootScreenLimit ?? DEFAULT_ROOT_SCREEN_LIMIT;
  const screenEnabled = screenLimit > 0;

  const safe = getSafeActions(rootState, rootPlayer);
  if (safe.winningMove) {
    return {
      action: safe.winningMove,
      simulations: 0,
      rootStats: [],
      selection: "IMMEDIATE_WIN",
    };
  }

  // Before comparing strategy, retain the shipped engine's first priority:
  // prove a forced kill. Fast fixed-simulation tests explicitly disable this by
  // setting rootScreenLimit to zero.
  if (screenEnabled) {
    const attackBudget = totalBudgetMs
      ? Math.max(10, Math.min(totalBudgetMs * 0.18, deadline - Date.now()))
      : Math.max(20, (options.rootScreenMs ?? DEFAULT_ROOT_SCREEN_MS) * 2);
    if (attackBudget > 0) {
      const kill = findForcedCapture(rootState, rootPlayer, CAPTURE_READ_DEPTH, attackBudget);
      if (kill) {
        return {
          action: kill.move,
          simulations: 0,
          rootStats: [],
          selection: "FORCED_CAPTURE",
        };
      }
    }
  }

  // The replay from the 0-8 run showed the decisive pattern: every game entered
  // a streak of zero-simulation moves before the final capture. The root reader
  // had collapsed to one static fallback and MCTS was no longer making the move.
  // A short alpha-beta answer is now computed inside the same total clock and is
  // used both as a root candidate and as the conservative fallback.
  let baselineAction: AIAction | undefined;
  const remainingBeforeBaseline = Math.max(0, deadline - Date.now());
  const baselineBudget = options.baselineSearchMs ??
    (totalBudgetMs ? Math.max(12, Math.min(180, remainingBeforeBaseline * 0.16)) : 0);
  if (baselineBudget > 0 && remainingBeforeBaseline > 0) {
    baselineAction = findBestMoveMinimax(
      rootState,
      rootPlayer,
      Math.min(baselineBudget, remainingBeforeBaseline),
    );
  }

  const shortlist = strategicRootShortlist(rootState, rootPlayer, safe.pool, screenLimit, baselineAction);
  const rootActions = screenRootActions(
    rootState,
    rootPlayer,
    shortlist,
    screenEnabled,
    options.rootScreenMs ?? DEFAULT_ROOT_SCREEN_MS,
    deadline,
    totalBudgetMs,
  );

  const baselineSurvived = baselineAction
    ? rootActions.some((action) => sameAction(action, baselineAction as AIAction))
    : false;
  const fallbackAction = baselineSurvived
    ? (baselineAction as AIAction)
    : rootActions[0] ?? { type: "PASS" as const };

  if (rootActions.length <= 1) {
    return {
      action: rootActions[0] ?? fallbackAction,
      simulations: 0,
      rootStats: [],
      selection: "ONLY_ROOT_ACTION",
      baselineAction,
    };
  }
  if (Date.now() >= deadline) {
    return {
      action: fallbackAction,
      simulations: 0,
      rootStats: [],
      selection: "BASELINE",
      baselineAction,
    };
  }

  const orderedRootActions = baselineSurvived
    ? [fallbackAction, ...rootActions.filter((action) => !sameAction(action, fallbackAction))]
    : rootActions;
  const random = mulberry32(options.seed ?? 1);
  const exploration = options.exploration ?? DEFAULT_EXPLORATION;
  const playoutDepth = options.playoutDepth ?? DEFAULT_PLAYOUT_DEPTH;
  const simulationLimit = Math.max(1, options.simulations ?? 2_000);
  const root = makeNode(rootState, null, null, orderedRootActions);

  let completed = 0;
  while (completed < simulationLimit && Date.now() < deadline) {
    let node = root;

    while (!node.state.winner && node.untriedActions.length === 0 && node.children.length > 0) {
      node = selectChild(node, rootPlayer, exploration);
    }

    if (!node.state.winner && node.untriedActions.length > 0) {
      node = expand(node, random);
    }

    const value = playout(node.state, rootPlayer, random, playoutDepth);
    backup(node, value);
    completed += 1;
  }

  const rootStats = root.children
    .map((child) => ({
      action: child.action ?? { type: "PASS" as const },
      visits: child.visits,
      meanValue: child.visits === 0 ? 0 : child.valueSum / child.visits,
    }))
    .sort((a, b) => b.visits - a.visits || b.meanValue - a.meanValue);

  const top = rootStats[0];
  if (!baselineSurvived || !baselineAction) {
    return {
      action: top?.action ?? fallbackAction,
      simulations: completed,
      rootStats,
      selection: "MCTS",
      baselineAction,
    };
  }

  const minimumSimulations = options.minimumSimulationsToOverride ?? Math.max(48, orderedRootActions.length * 10);
  const baselineStat = rootStats.find((stat) => sameAction(stat.action, baselineAction as AIAction));
  const minimumTopVisits = Math.max(8, Math.floor(completed / Math.max(1, orderedRootActions.length * 3)));
  const mctsHasConfidence = Boolean(
    top &&
      baselineStat &&
      completed >= minimumSimulations &&
      top.visits >= minimumTopVisits &&
      (sameAction(top.action, baselineAction) || top.meanValue >= baselineStat.meanValue + 0.08),
  );

  if (!mctsHasConfidence || !top || sameAction(top.action, baselineAction)) {
    return {
      action: baselineAction,
      simulations: completed,
      rootStats,
      selection: "BASELINE",
      baselineAction,
    };
  }

  return {
    action: top.action,
    simulations: completed,
    rootStats,
    selection: "MCTS",
    baselineAction,
  };
}
