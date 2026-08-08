import type { SearchDifficulty } from "../ai";
import type { GameState, Player } from "../types";
import type { AIVariant } from "../aiVariant";
import type { AIWorkerRequest, AIWorkerResponse } from "../aiWorker";

export const TIME_LIMIT_MS: Record<SearchDifficulty, number> = {
  HARD: 2500,
  // VERY_HARD splits its budget between the life-and-death reader and the
  // positional search, so it needs a little more room than HARD.
  VERY_HARD: 3000,
};
const WATCHDOG_MARGIN_MS = 4000;

/** Thin wrapper around the search Web Worker: one worker per client, spun up
 * lazily and reused across moves, with a watchdog timeout in case the worker
 * never replies. */
export class SearchAIClient {
  private worker: Worker | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../aiWorker.ts", import.meta.url), { type: "module" });
    }
    return this.worker;
  }

  requestMove(
    state: GameState,
    player: Player,
    difficulty: SearchDifficulty,
    variant: AIVariant = "STANDARD",
  ): Promise<AIWorkerResponse> {
    const worker = this.ensureWorker();
    const timeLimitMs = TIME_LIMIT_MS[difficulty];

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(`${difficulty} AI worker timed out`));
      }, timeLimitMs + WATCHDOG_MARGIN_MS);

      const handleMessage = (event: MessageEvent<AIWorkerResponse>) => {
        cleanup();
        resolve(event.data);
      };
      const handleError = (event: ErrorEvent) => {
        cleanup();
        reject(event.error instanceof Error ? event.error : new Error(`${difficulty} AI worker error`));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage({ state, player, timeLimitMs, difficulty, variant } satisfies AIWorkerRequest);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
