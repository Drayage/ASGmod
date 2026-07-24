import type { AIAction } from "../ai";
import type { GameState, Player } from "../types";
import type { AIWorkerRequest } from "../aiWorker";

const HARD_TIME_LIMIT_MS = 900;
const WATCHDOG_MARGIN_MS = 2000;

/** Thin wrapper around the HARD-difficulty Web Worker: one worker per
 * client, spun up lazily and reused across moves, with a watchdog timeout
 * in case the worker never replies. */
export class HardAIClient {
  private worker: Worker | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../aiWorker.ts", import.meta.url), { type: "module" });
    }
    return this.worker;
  }

  requestMove(state: GameState, player: Player): Promise<AIAction> {
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("HARD AI worker timed out"));
      }, HARD_TIME_LIMIT_MS + WATCHDOG_MARGIN_MS);

      const handleMessage = (event: MessageEvent<AIAction>) => {
        cleanup();
        resolve(event.data);
      };
      const handleError = (event: ErrorEvent) => {
        cleanup();
        reject(event.error instanceof Error ? event.error : new Error("HARD AI worker error"));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage({ state, player, timeLimitMs: HARD_TIME_LIMIT_MS } satisfies AIWorkerRequest);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
