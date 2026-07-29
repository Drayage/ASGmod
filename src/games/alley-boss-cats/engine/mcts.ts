import { applyAction, evaluateState, getSafeActions, rankByStaticEval } from "../ai";
import type { AIAction } from "../ai";
import type { GameState, Player } from "../types";
import { opponentCanForceCapture } from "./captureSearch";

const DEFAULT_EXPLORATION = Math.SQRT2;
const DEFAULT_PLAYOUT_DEPTH = 24;
const DEFAULT_ROOT_SCREEN_LIMIT = 18;
const DEFAULT_ROOT_SCREEN_MS = 45;

export interface MCTSOptions {
  /** Fixed iteration budget. Prefer this in tests and arenas for reproducibility. */
  simulations?: number;
  /** Optional wall-clock budget for actual play. */
  timeLimitMs?: number;
  /** Deterministic seed used for expansion and playout tie-breaking. */
  seed?: number;
  exploration?: number;
  playoutDepth?: number;
  rootScreenLimit?: number;
  rootScreenMs?: number;
}

export interface MCTSRootStat {
  action: AIAction;
  visits: number;
  meanValue: number;
}

export interface MCTSResult {
  action: AIAction;
  simulations: number;
  rootStats: MCTSRootStat[];
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
  if (state.winner === rootPlayer) return 1;
  return -1;
}

function boundedLeafValue(state: GameState, rootPlayer: Player): number {
  const terminal = terminalValue(state, rootPlayer);
  if (terminal !== null) return terminal;
  // Existing evaluation has intentionally huge tactical constants. tanh keeps
  // MCTS backup values in a stable [-1, 1] range while preserving ordering.
  return Math.tanh(evaluateState(state, rootPlayer) / 350);
}

function makeNode(state: GameState, parent: Node | null, action: AIAction | null): Node {
  const safe = getSafeActions(state, state.currentPlayer);
  const actions = safe.winningMove ? [safe.winningMove] : rankByStaticEval(state, state.currentPlayer, safe.pool);
  return {
    state,
    parent,
    action,
    playerToMove: state.currentPlayer,
    children: [],
    untriedActions: actions,
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
  // Static ordering supplies the strategic prior. A small random window avoids
  // deterministically starving nearby candidates with almost identical scores.
  const window = Math.min(4, node.untriedActions.length);
  const index = Math.floor(random() * window);
  const [action] = node.untriedActions.splice(index, 1);
  const child = makeNode(applyAction(node.state, action), node, action);
  node.children.push(child);
  return child;
}

function choosePlayoutAction(state: GameState, random: () => number): AIAction {
  const { winningMove, pool } = getSafeActions(state, state.currentPlayer);
  if (winningMove) return winningMove;

  const ranked = rankByStaticEval(state, state.currentPlayer, pool);
  // Mostly follow the current fast policy, but leave enough exploration for
  // quiet territorial alternatives to reach actual end results.
  const top = Math.min(5, ranked.length);
  const roll = random();
  const index = roll < 0.72 ? 0 : Math.floor(random() * top);
  return ranked[index] ?? { type: "PASS" };
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

function screenRootActions(
  state: GameState,
  player: Player,
  actions: AIAction[],
  limit: number,
  perMoveMs: number,
): AIAction[] {
  const survivors: AIAction[] = [];
  const ranked = rankByStaticEval(state, player, actions);

  for (let i = 0; i < ranked.length; i += 1) {
    const action = ranked[i];
    if (i >= limit) {
      survivors.push(action);
      continue;
    }
    const next = applyAction(state, action);
    if (next.winner === player) return [action];
    if (next.winner) continue;
    if (!opponentCanForceCapture(next, player, 7, perMoveMs)) survivors.push(action);
  }

  // A timeout or a genuinely lost position must still return something legal.
  return survivors.length > 0 ? survivors : ranked;
}

/**
 * Experimental strategy search. Existing capture readers keep the tactical
 * floor; MCTS is only asked to compare the surviving moves over longer,
 * policy-guided continuations.
 */
export function findBestMoveHybridMCTS(
  rootState: GameState,
  rootPlayer: Player,
  options: MCTSOptions = {},
): MCTSResult {
  if (rootState.currentPlayer !== rootPlayer) {
    throw new Error("Hybrid MCTS must search for the state's current player");
  }

  const safe = getSafeActions(rootState, rootPlayer);
  if (safe.winningMove) {
    return { action: safe.winningMove, simulations: 0, rootStats: [] };
  }

  const rootActions = screenRootActions(
    rootState,
    rootPlayer,
    safe.pool,
    options.rootScreenLimit ?? DEFAULT_ROOT_SCREEN_LIMIT,
    options.rootScreenMs ?? DEFAULT_ROOT_SCREEN_MS,
  );
  if (rootActions.length <= 1) {
    return { action: rootActions[0] ?? { type: "PASS" }, simulations: 0, rootStats: [] };
  }

  const random = mulberry32(options.seed ?? 1);
  const exploration = options.exploration ?? DEFAULT_EXPLORATION;
  const playoutDepth = options.playoutDepth ?? DEFAULT_PLAYOUT_DEPTH;
  const simulationLimit = Math.max(1, options.simulations ?? 2_000);
  const deadline = options.timeLimitMs ? Date.now() + options.timeLimitMs : Number.POSITIVE_INFINITY;

  const root = makeNode(rootState, null, null);
  root.untriedActions = root.untriedActions.filter((candidate) =>
    rootActions.some((allowed) => sameAction(candidate, allowed)),
  );

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

  return {
    action: rootStats[0]?.action ?? rootActions[0],
    simulations: completed,
    rootStats,
  };
}
