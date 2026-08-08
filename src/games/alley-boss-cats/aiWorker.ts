import { findBestMoveMinimax, findBestMoveVeryHard, lastSearchDepth } from "./engine/minimax";
import type { AIAction, SearchDifficulty } from "./ai";
import type { GameState, Player } from "./types";
import { applyAIVariant, type AIVariant } from "./aiVariant";

export interface AIWorkerRequest {
  state: GameState;
  player: Player;
  timeLimitMs: number;
  difficulty: SearchDifficulty;
  /** Which named engine settings to search with. The worker keeps module-level
   * state between moves, so this is applied on every request rather than once. */
  variant: AIVariant;
}

export interface AIWorkerResponse {
  action: AIAction;
  /** Deepest ply the search completed — the number that says whether it thought
   * hard or barely started. Elapsed time cannot: iterative deepening spends the
   * whole budget by design. */
  depth: number;
}

self.onmessage = (event: MessageEvent<AIWorkerRequest>) => {
  const { state, player, timeLimitMs, difficulty, variant } = event.data;
  applyAIVariant(variant ?? "STANDARD");
  const action =
    difficulty === "VERY_HARD"
      ? findBestMoveVeryHard(state, player, timeLimitMs)
      : findBestMoveMinimax(state, player, timeLimitMs);
  (self as unknown as Worker).postMessage({ action, depth: lastSearchDepth } satisfies AIWorkerResponse);
};
