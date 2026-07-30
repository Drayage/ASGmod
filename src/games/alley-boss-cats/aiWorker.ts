import { findBestMoveMinimax, findBestMoveVeryHard, lastSearchDepth } from "./engine/minimax";
import { findBestMoveHybridMCTS } from "./engine/mcts";
import type { MCTSRootStat, MCTSSelection } from "./engine/mcts";
import type { AIAction, SearchDifficulty } from "./ai";
import type { GameState, Player } from "./types";

export type SearchEngine = "CURRENT" | "HYBRID_MCTS";

export interface AIWorkerRequest {
  state: GameState;
  player: Player;
  timeLimitMs: number;
  difficulty: SearchDifficulty;
  /** Experimental opt-in. Existing app calls omit this and keep current AI. */
  engine?: SearchEngine;
  simulations?: number;
  seed?: number;
}

export interface AIWorkerResponse {
  action: AIAction;
  /** Deepest ply the search completed — the number that says whether it thought
   * hard or barely started. Elapsed time cannot: iterative deepening spends the
   * whole budget by design. */
  depth: number;
  simulations?: number;
  rootStats?: MCTSRootStat[];
  selection?: MCTSSelection;
  baselineAction?: AIAction;
}

self.onmessage = (event: MessageEvent<AIWorkerRequest>) => {
  const { state, player, timeLimitMs, difficulty, engine = "CURRENT", simulations, seed } = event.data;

  if (engine === "HYBRID_MCTS") {
    const result = findBestMoveHybridMCTS(state, player, {
      timeLimitMs,
      simulations: simulations ?? 10_000,
      seed,
    });
    (self as unknown as Worker).postMessage({
      action: result.action,
      depth: 0,
      simulations: result.simulations,
      rootStats: result.rootStats,
      selection: result.selection,
      baselineAction: result.baselineAction,
    } satisfies AIWorkerResponse);
    return;
  }

  const action =
    difficulty === "VERY_HARD"
      ? findBestMoveVeryHard(state, player, timeLimitMs)
      : findBestMoveMinimax(state, player, timeLimitMs);
  (self as unknown as Worker).postMessage({ action, depth: lastSearchDepth } satisfies AIWorkerResponse);
};
