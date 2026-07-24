import { findBestMoveMinimax } from "./engine/minimax";
import type { AIAction } from "./ai";
import type { GameState, Player } from "./types";

export interface AIWorkerRequest {
  state: GameState;
  player: Player;
  timeLimitMs: number;
}

export type AIWorkerResponse = AIAction;

self.onmessage = (event: MessageEvent<AIWorkerRequest>) => {
  const { state, player, timeLimitMs } = event.data;
  const action = findBestMoveMinimax(state, player, timeLimitMs);
  (self as unknown as Worker).postMessage(action satisfies AIWorkerResponse);
};
