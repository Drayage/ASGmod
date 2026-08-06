/**
 * Playing a position out to a count, for labelling.
 *
 * Measured on the pilot, roughly half of an early position's final margin is
 * not a property of the position at all — replaying one opening position with
 * play allowed to vary gives a spread of 3.02 cells against a total spread of
 * 4.22, which caps any model's correlation there at about 0.70. A single
 * playout is therefore a noisy teacher, and averaging several is the cheapest
 * way to sharpen the target: k playouts cut the noise variance by k, lifting
 * that ceiling to 0.93 at k=4.
 *
 * Shared so the noise measurement and the label averaging cannot disagree about
 * what a playout is — the whole argument rests on the two being the same thing.
 *
 * Nothing here runs during play.
 */
import { applyAction, evaluateState, getSafeActions } from "./ai";
import type { AIAction } from "./ai";
import { calculateTerritories } from "./territory";
import type { GameState } from "./types";

/** Deterministic PRNG, so a playout can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlayoutOptions {
  /** How many of the best moves to sample among. 1 is deterministic. */
  topK?: number;
  maxPlies?: number;
}

/**
 * Play to a double pass and return the final territory margin from A's side.
 *
 * Capture wins are declined throughout. A capture ends the game outright, which
 * would leave nothing to count — and a game that cannot be counted carries no
 * ownership label, which is the one thing this exists to produce.
 *
 * Sampling among the top `topK` rather than always taking the best is what
 * makes repeated playouts differ. The engine is near enough deterministic that
 * without it every replay returns the same number and measures nothing.
 */
export function playoutToCount(
  start: GameState,
  random: () => number,
  { topK = 3, maxPlies = 220 }: PlayoutOptions = {},
): number {
  let state = start;
  let plies = 0;

  while (!state.winner && plies < maxPlies) {
    const player = state.currentPlayer;
    const { pool } = getSafeActions(state, player);

    let best: Array<{ next: GameState; score: number }> = [];
    for (const action of pool as AIAction[]) {
      const next = applyAction(state, action);
      if (next.winner !== null && next.winReason === "CAPTURE") continue;
      best.push({ next, score: evaluateState(next, player) });
    }
    if (best.length === 0) break;

    // Only the top few are needed, so a full sort of ~40 candidates per ply is
    // wasted work over a playout this long.
    const limit = Math.min(topK, best.length);
    for (let slot = 0; slot < limit; slot += 1) {
      let pick = slot;
      for (let index = slot + 1; index < best.length; index += 1) {
        if (best[index].score > best[pick].score) pick = index;
      }
      [best[slot], best[pick]] = [best[pick], best[slot]];
    }

    state = best[Math.floor(random() * limit)].next;
    plies += 1;
  }

  const territories = calculateTerritories(state.board);
  return territories.A.length - territories.B.length;
}

export interface AveragedLabel {
  mean: number;
  standardDeviation: number;
  playouts: number;
}

/** Average several playouts, and report how much they disagreed. */
export function averagedLabel(
  start: GameState,
  seed: number,
  playouts: number,
  options: PlayoutOptions = {},
): AveragedLabel {
  const results: number[] = [];
  for (let run = 0; run < playouts; run += 1) {
    results.push(playoutToCount(start, seededRandom(seed + run * 7919), options));
  }
  const mean = results.reduce((sum, value) => sum + value, 0) / results.length;
  const variance =
    results.length > 1
      ? results.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (results.length - 1)
      : 0;
  return { mean, standardDeviation: Math.sqrt(variance), playouts: results.length };
}
