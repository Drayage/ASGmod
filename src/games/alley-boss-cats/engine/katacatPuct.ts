import { applyAction, getSafeActions } from "../ai";
import type { AIAction } from "../ai";
import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";

const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const KATACAT_POLICY_SIZE = BOARD_CELLS + 1;
export const KATACAT_PASS_INDEX = BOARD_CELLS;

export interface KataCatNeuralEvaluation {
  /** Unnormalised policy logits for 81 board points plus PASS. */
  policyLogits: number[];
  /** Win value in [-1, 1], from state.currentPlayer's perspective. */
  value: number;
  /** Normalised adjusted score margin in [-1, 1], from state.currentPlayer's perspective. */
  score: number;
  /** Optional flattened ownership logits/probabilities retained for analysis. */
  ownership?: number[];
}

export interface KataCatNeuralEvaluator {
  evaluate(state: GameState): Promise<KataCatNeuralEvaluation>;
}

export interface KataCatPuctOptions {
  simulations: number;
  cpuct: number;
  neuralPriorWeight: number;
  scoreValueWeight: number;
  /** Enables the focused root life-and-death reader. Internal nodes stay on the fast guard. */
  tacticalShell: boolean;
  captureReadDepth: number;
  captureAttackMs: number;
  captureDefenseMs: number;
  captureDefenseLimit: number;
}

export interface KataCatVisitRecord {
  action: AIAction;
  actionIndex: number;
  visits: number;
  prior: number;
  meanValue: number;
}

export interface KataCatTacticalReport {
  enabled: boolean;
  forcedCaptureFound: boolean;
  screenedActions: number;
  refutedActions: number;
  rootPoolBefore: number;
  rootPoolAfter: number;
  allRefutedFallback: boolean;
}

export interface KataCatPuctResult {
  action: AIAction;
  reason: "IMMEDIATE_WIN" | "FORCED_CAPTURE" | "SEARCH";
  simulations: number;
  visitDistribution: KataCatVisitRecord[];
  rootEvaluation?: KataCatNeuralEvaluation;
  tactical: KataCatTacticalReport;
}

interface SearchEdge {
  action: AIAction;
  actionIndex: number;
  prior: number;
  visits: number;
  valueSum: number;
  child?: SearchNode;
}

interface SearchNode {
  state: GameState;
  expanded: boolean;
  visits: number;
  edges: SearchEdge[];
}

const DEFAULT_OPTIONS: KataCatPuctOptions = {
  simulations: 64,
  cpuct: 1.35,
  neuralPriorWeight: 0.75,
  scoreValueWeight: 0.05,
  tacticalShell: false,
  captureReadDepth: 7,
  captureAttackMs: 25,
  captureDefenseMs: 50,
  captureDefenseLimit: 12,
};

export function encodeKataCatPuctAction(action: AIAction): number {
  return action.type === "PASS" ? KATACAT_PASS_INDEX : action.row * BOARD_SIZE + action.col;
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validateEvaluation(evaluation: KataCatNeuralEvaluation): void {
  if (evaluation.policyLogits.length !== KATACAT_POLICY_SIZE) {
    throw new Error(
      `KataCat evaluator returned ${evaluation.policyLogits.length} policy logits; expected ${KATACAT_POLICY_SIZE}`,
    );
  }
  if (!Number.isFinite(evaluation.value) || !Number.isFinite(evaluation.score)) {
    throw new Error("KataCat evaluator returned a non-finite value or score");
  }
  if (evaluation.policyLogits.some((value) => !Number.isFinite(value))) {
    throw new Error("KataCat evaluator returned a non-finite policy logit");
  }
  if (evaluation.ownership?.some((value) => !Number.isFinite(value))) {
    throw new Error("KataCat evaluator returned a non-finite ownership value");
  }
}

function terminalValue(state: GameState): number {
  if (!state.winner) throw new Error("terminalValue called for a non-terminal state");
  return state.winner === state.currentPlayer ? 1 : -1;
}

function leafValue(evaluation: KataCatNeuralEvaluation, scoreValueWeight: number): number {
  return clamp(
    clamp(evaluation.value, -1, 1) + scoreValueWeight * clamp(evaluation.score, -1, 1),
    -1,
    1,
  );
}

function softmaxPriors(logits: number[], actionIndices: number[]): number[] {
  const maximum = Math.max(...actionIndices.map((index) => logits[index]));
  const exponentials = actionIndices.map((index) => Math.exp(logits[index] - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return actionIndices.map(() => 1 / actionIndices.length);
  }
  return exponentials.map((value) => value / total);
}

function expandNode(
  node: SearchNode,
  evaluation: KataCatNeuralEvaluation,
  neuralPriorWeight: number,
  suppliedActions?: AIAction[],
): void {
  validateEvaluation(evaluation);
  const safe = suppliedActions ? null : getSafeActions(node.state, node.state.currentPlayer);
  const actions = suppliedActions ?? (safe?.winningMove ? [safe.winningMove] : safe?.pool ?? []);
  if (actions.length === 0) throw new Error("KataCat PUCT found no playable actions");

  const ordered = [...actions].sort(
    (left, right) => encodeKataCatPuctAction(left) - encodeKataCatPuctAction(right),
  );
  const actionIndices = ordered.map(encodeKataCatPuctAction);
  const neuralPriors = softmaxPriors(evaluation.policyLogits, actionIndices);
  const neuralWeight = clamp(neuralPriorWeight, 0, 1);
  const uniformPrior = 1 / ordered.length;

  node.edges = ordered.map((action, index) => ({
    action,
    actionIndex: actionIndices[index],
    prior: neuralWeight * neuralPriors[index] + (1 - neuralWeight) * uniformPrior,
    visits: 0,
    valueSum: 0,
  }));
  node.expanded = true;
}

function selectEdge(node: SearchNode, cpuct: number): SearchEdge {
  if (!node.expanded || node.edges.length === 0) {
    throw new Error("Cannot select from an unexpanded KataCat PUCT node");
  }
  const explorationScale = Math.sqrt(Math.max(1, node.visits));
  let best = node.edges[0];
  let bestScore = -Infinity;

  for (const edge of node.edges) {
    const meanValue = edge.visits > 0 ? edge.valueSum / edge.visits : 0;
    const exploration = (cpuct * edge.prior * explorationScale) / (1 + edge.visits);
    const score = meanValue + exploration;
    if (
      score > bestScore + 1e-12 ||
      (Math.abs(score - bestScore) <= 1e-12 && edge.actionIndex < best.actionIndex)
    ) {
      best = edge;
      bestScore = score;
    }
  }
  return best;
}

function chooseRootAction(edges: SearchEdge[]): SearchEdge {
  return [...edges].sort((left, right) => {
    if (right.visits !== left.visits) return right.visits - left.visits;
    const leftMean = left.visits > 0 ? left.valueSum / left.visits : -Infinity;
    const rightMean = right.visits > 0 ? right.valueSum / right.visits : -Infinity;
    if (rightMean !== leftMean) return rightMean - leftMean;
    if (right.prior !== left.prior) return right.prior - left.prior;
    return left.actionIndex - right.actionIndex;
  })[0];
}

function visitsFor(edges: SearchEdge[]): KataCatVisitRecord[] {
  return [...edges]
    .sort((left, right) => left.actionIndex - right.actionIndex)
    .map((edge) => ({
      action: edge.action,
      actionIndex: edge.actionIndex,
      visits: edge.visits,
      prior: edge.prior,
      meanValue: edge.visits > 0 ? edge.valueSum / edge.visits : 0,
    }));
}

function oneVisitResult(
  action: AIAction,
  reason: "IMMEDIATE_WIN" | "FORCED_CAPTURE",
  tactical: KataCatTacticalReport,
): KataCatPuctResult {
  return {
    action,
    reason,
    simulations: 0,
    visitDistribution: [
      {
        action,
        actionIndex: encodeKataCatPuctAction(action),
        visits: 1,
        prior: 1,
        meanValue: 1,
      },
    ],
    tactical,
  };
}

function rankByPolicy(actions: AIAction[], evaluation: KataCatNeuralEvaluation): AIAction[] {
  return [...actions].sort((left, right) => {
    const leftIndex = encodeKataCatPuctAction(left);
    const rightIndex = encodeKataCatPuctAction(right);
    const difference = evaluation.policyLogits[rightIndex] - evaluation.policyLogits[leftIndex];
    return difference !== 0 ? difference : leftIndex - rightIndex;
  });
}

function screenRootActions(
  state: GameState,
  actions: AIAction[],
  evaluation: KataCatNeuralEvaluation,
  options: KataCatPuctOptions,
): { actions: AIAction[]; screened: number; refuted: number; allRefutedFallback: boolean } {
  if (!options.tacticalShell || actions.length <= 1 || options.captureDefenseMs <= 0) {
    return { actions, screened: 0, refuted: 0, allRefutedFallback: false };
  }

  const ranked = rankByPolicy(actions, evaluation);
  const screened = ranked.slice(0, Math.min(options.captureDefenseLimit, ranked.length));
  const perMoveMs = Math.max(1, Math.floor(options.captureDefenseMs / Math.max(1, screened.length)));
  const refutedKeys = new Set<string>();

  for (const action of screened) {
    const next = applyAction(state, action);
    if (next.winner === state.currentPlayer) continue;
    if (next.winner || opponentCanForceCapture(next, state.currentPlayer, options.captureReadDepth, perMoveMs)) {
      refutedKeys.add(actionKey(action));
    }
  }

  const survivors = ranked.filter((action) => !refutedKeys.has(actionKey(action)));
  if (survivors.length === 0) {
    return {
      actions: ranked,
      screened: screened.length,
      refuted: refutedKeys.size,
      allRefutedFallback: true,
    };
  }
  return {
    actions: survivors,
    screened: screened.length,
    refuted: refutedKeys.size,
    allRefutedFallback: false,
  };
}

/**
 * Neural PUCT with the existing rules engine as the sole authority.
 *
 * Tactical guards are intentionally outside the learned model:
 * - an immediate winning move is returned before search;
 * - the optional root shell reads focused forced captures and rejects only proven losing roots;
 * - internal expansion uses getSafeActions, so moves that volunteer an immediate loss are excluded;
 * - if every screened move is refuted, the full ranked pool is retained rather than inventing certainty.
 *
 * Random rollout simulation is never used. Every non-terminal leaf is evaluated by the supplied
 * policy/value/score/ownership evaluator.
 */
export async function searchKataCatPuct(
  state: GameState,
  evaluator: KataCatNeuralEvaluator,
  requested: Partial<KataCatPuctOptions> = {},
): Promise<KataCatPuctResult> {
  if (state.winner) throw new Error("Cannot search a finished KataCat game");
  const options: KataCatPuctOptions = { ...DEFAULT_OPTIONS, ...requested };
  options.simulations = Math.max(1, Math.floor(options.simulations));
  options.cpuct = Math.max(0, options.cpuct);
  options.captureReadDepth = Math.max(1, Math.floor(options.captureReadDepth));
  options.captureAttackMs = Math.max(0, Math.floor(options.captureAttackMs));
  options.captureDefenseMs = Math.max(0, Math.floor(options.captureDefenseMs));
  options.captureDefenseLimit = Math.max(1, Math.floor(options.captureDefenseLimit));

  const tactical = getSafeActions(state, state.currentPlayer);
  const baseTacticalReport: KataCatTacticalReport = {
    enabled: options.tacticalShell,
    forcedCaptureFound: false,
    screenedActions: 0,
    refutedActions: 0,
    rootPoolBefore: tactical.pool.length,
    rootPoolAfter: tactical.pool.length,
    allRefutedFallback: false,
  };
  if (tactical.winningMove) {
    return oneVisitResult(tactical.winningMove, "IMMEDIATE_WIN", baseTacticalReport);
  }

  if (options.tacticalShell && options.captureAttackMs > 0) {
    const forced = findForcedCapture(
      state,
      state.currentPlayer,
      options.captureReadDepth,
      options.captureAttackMs,
    );
    if (forced) {
      return oneVisitResult(forced.move, "FORCED_CAPTURE", {
        ...baseTacticalReport,
        forcedCaptureFound: true,
      });
    }
  }

  const root: SearchNode = { state, expanded: false, visits: 0, edges: [] };
  const rootEvaluation = await evaluator.evaluate(state);
  validateEvaluation(rootEvaluation);
  const screened = screenRootActions(state, tactical.pool, rootEvaluation, options);
  const tacticalReport: KataCatTacticalReport = {
    ...baseTacticalReport,
    screenedActions: screened.screened,
    refutedActions: screened.refuted,
    rootPoolAfter: screened.actions.length,
    allRefutedFallback: screened.allRefutedFallback,
  };
  expandNode(root, rootEvaluation, options.neuralPriorWeight, screened.actions);

  for (let simulation = 0; simulation < options.simulations; simulation += 1) {
    let node = root;
    const nodes: SearchNode[] = [root];
    const path: SearchEdge[] = [];

    while (node.expanded && !node.state.winner) {
      const edge = selectEdge(node, options.cpuct);
      if (!edge.child) {
        edge.child = {
          state: applyAction(node.state, edge.action),
          expanded: false,
          visits: 0,
          edges: [],
        };
      }
      path.push(edge);
      node = edge.child;
      nodes.push(node);
      if (!node.expanded) break;
    }

    let value: number;
    if (node.state.winner) {
      value = terminalValue(node.state);
    } else {
      const evaluation = await evaluator.evaluate(node.state);
      expandNode(node, evaluation, options.neuralPriorWeight);
      value = leafValue(evaluation, options.scoreValueWeight);
    }

    for (const visitedNode of nodes) visitedNode.visits += 1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const parent = nodes[index];
      const child = nodes[index + 1];
      if (parent.state.currentPlayer !== child.state.currentPlayer) value = -value;
      path[index].visits += 1;
      path[index].valueSum += value;
    }
  }

  const selected = chooseRootAction(root.edges);
  const visitDistribution = visitsFor(root.edges);
  const totalVisits = visitDistribution.reduce((sum, record) => sum + record.visits, 0);
  if (totalVisits !== options.simulations) {
    throw new Error(
      `KataCat PUCT visit accounting mismatch: ${totalVisits} != ${options.simulations}`,
    );
  }

  const rootKeys = new Set(screened.actions.map(actionKey));
  if (!rootKeys.has(actionKey(selected.action))) {
    throw new Error("KataCat PUCT selected an action outside the screened tactical root pool");
  }

  return {
    action: selected.action,
    reason: "SEARCH",
    simulations: options.simulations,
    visitDistribution,
    rootEvaluation,
    tactical: tacticalReport,
  };
}
