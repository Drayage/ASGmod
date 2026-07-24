import { findBestMoveMinimax, findBestMoveVeryHard } from "./engine/minimax";
import type { AIAction, SearchDifficulty } from "./ai";
import type { GameState, Player } from "./types";

export interface AIWorkerRequest {
  state: GameState;
  player: Player;
  timeLimitMs: number;
  difficulty: SearchDifficulty;
}

export type AIWorkerResponse = AIAction;

self.onmessage = (event: MessageEvent<AIWorkerRequest>) => {
  const { state, player, timeLimitMs, difficulty } = event.data;
  const action =
    difficulty === "VERY_HARD"
      ? findBestMoveVeryHard(state, player, timeLimitMs)
      : findBestMoveMinimax(state, player, timeLimitMs);
  (self as unknown as Worker).postMessage(action satisfies AIWorkerResponse);
};
