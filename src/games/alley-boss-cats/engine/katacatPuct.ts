import { applyAction, getSafeActions } from "../ai";
import type { AIAction } from "../ai";
import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";

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
}

export interface KataCatVisitRecord {
  action: AIAction;
  actionIndex: number;
  visits: number;
  prior: number;
  meanValue: number;
}

export interface KataCatPuctResult {
  action: AIAction;
  reason: "IMMEDIATE_WIN" | "SEARCH";
  simulations: number;
  visitDistribution: KataCatVisitRecord[];
  rootEvaluation?: KataCatNeuralEvaluation;
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
): void {
  validateEvaluation(evaluation);
  const safe = getSafeActions(node.state, node.state.currentPlayer);
  const actions = safe.winningMove ? [safe.winningMove] : safe.pool;
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
    const exploration = cpuct * edge.prior * explorationScale / (1 + edge.visits);
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

/**
 * Neural PUCT with the existing rules engine as the sole authority.
 *
 * Tactical guards are intentionally outside the learned model:
 * - an immediate winning move is returned before search;
 * - expansion uses getSafeActions, so moves that volunteer an immediate loss are excluded;
 * - if every move loses, getSafeActions falls back to all legal actions rather than inventing one.
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

  const tactical = getSafeActions(state, state.currentPlayer);
  if (tactical.winningMove) {
    return {
      action: tactical.winningMove,
      reason: "IMMEDIATE_WIN",
      simulations: 0,
      visitDistribution: [
        {
          action: tactical.winningMove,
          actionIndex: encodeKataCatPuctAction(tactical.winningMove),
          visits: 1,
          prior: 1,
          meanValue: 1,
        },
      ],
    };
  }

  const root: SearchNode = { state, expanded: false, visits: 0, edges: [] };
  const rootEvaluation = await evaluator.evaluate(state);
  expandNode(root, rootEvaluation, options.neuralPriorWeight);

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
      value = -value;
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

  const safeKeys = new Set(tactical.pool.map(actionKey));
  if (!safeKeys.has(actionKey(selected.action))) {
    throw new Error("KataCat PUCT selected an action outside the tactical safe root pool");
  }

  return {
    action: selected.action,
    reason: "SEARCH",
    simulations: options.simulations,
    visitDistribution,
    rootEvaluation,
  };
}
