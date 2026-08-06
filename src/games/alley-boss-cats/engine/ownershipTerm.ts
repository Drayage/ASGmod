/**
 * The learned territory term, and the caching that makes it affordable.
 *
 * `evaluateState` prices open ground at `influenceCount * 0.12` — how much of
 * the board each side is nearer to. Measured against what the ground actually
 * becomes, that signal finds 77% of the territory that forms and is wrong about
 * 68% of what it claims. The net reads 71% precision at 82% open-point
 * accuracy, so swapping which prior values the open points is the whole idea.
 *
 * The catch is cost. One forward pass is about 74ms here, against a 3000ms
 * move — fine once, ruinous at every leaf, where the search visits tens of
 * thousands of positions and the depth that makes this engine tactically strong
 * would collapse. So the map is computed once for the position actually being
 * played and held for the search beneath it.
 *
 * That is an approximation, and a defensible one. Settled territory is still
 * counted exactly at every leaf, so a move that genuinely banks ground is
 * scored on arithmetic, not on the prior; the prior only values what is still
 * open. A leaf that converts ground the net was unsure about gains, which is
 * the behaviour this whole investigation is trying to produce.
 *
 * Off unless `tuning.ownershipWeight` is above zero, and silently off if the
 * net file is missing — a build without it plays exactly as before.
 */
import { BOARD_SIZE } from "../types";
import type { GameState, Player } from "../types";
import { OwnershipNet, type OwnershipNetFile, type OwnershipPrediction } from "./ownershipNet";

let net: OwnershipNet | null = null;
let loadAttempted = false;
let rootPrediction: OwnershipPrediction | null = null;

/** Supply the net directly. Node callers (arena, tests) use this. */
export function setOwnershipNet(file: OwnershipNetFile | null): void {
  net = file ? new OwnershipNet(file) : null;
  loadAttempted = true;
  rootPrediction = null;
}

export function ownershipNetLoaded(): boolean {
  return net !== null;
}

/**
 * Compute the map for the position about to be searched.
 *
 * Called once per move, before the search starts. Doing nothing when the term
 * is off keeps a disabled net free rather than merely cheap.
 */
export function primeRootOwnership(state: GameState, enabled: boolean): void {
  rootPrediction = null;
  if (!enabled || !net) return;
  if (state.winner) return;
  rootPrediction = net.predict(OwnershipNet.encodeState(state), false);
}

export function clearRootOwnership(): void {
  rootPrediction = null;
}

export function hasRootOwnership(): boolean {
  return rootPrediction !== null;
}

/**
 * How far ahead `player` is on ground, in cells: settled territory counted
 * exactly, open points valued by the cached map.
 *
 * Returns null when there is no map, so callers fall back to the shipped
 * influence term rather than silently scoring zero.
 */
export function ownershipMargin(state: GameState, player: Player): number | null {
  if (!rootPrediction) return null;

  let margin = state.territories.A.length - state.territories.B.length;
  const { probabilityA, probabilityB } = rootPrediction;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (state.board[row][col] !== "EMPTY") continue;
      const cell = row * BOARD_SIZE + col;
      margin += probabilityA[cell] - probabilityB[cell];
    }
  }
  return player === "A" ? margin : -margin;
}

/**
 * Load the net from the app's static assets, once.
 *
 * Failure is not an error worth stopping for: the engine has a complete
 * territory term without it, and a missing or malformed file should cost the
 * player nothing beyond the improvement it would have brought.
 */
export async function loadOwnershipNet(url: string): Promise<boolean> {
  if (loadAttempted) return net !== null;
  loadAttempted = true;
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    net = new OwnershipNet((await response.json()) as OwnershipNetFile);
    return true;
  } catch {
    net = null;
    return false;
  }
}
