/**
 * Choosing a move that leaves the board countable.
 *
 * A capture wins outright here, so most games stop long before the ground is
 * settled — 71% of engine self-play by measurement. Those games carry no final
 * ownership to learn from, and the ones that do are exactly the games the
 * engine keeps losing. So the ownership dataset's label rollout declines
 * capture wins: it asks how the ground would divide if the game were counted,
 * which is the question a learned territory term needs answered.
 *
 * Nothing here runs during play. It is used only by the dataset generator in
 * scripts/generate-ownership-dataset.ts, and lives in src/ so it can be tested
 * — that generator does its work at import time, so nothing inside it is
 * reachable from a test.
 */
import { applyAction, getSafeActions, rankByStaticEval } from "./ai";
import type { AIAction } from "./ai";
import type { GameState, Player } from "./types";

function endsOnCapture(state: GameState, action: AIAction): boolean {
  const next = applyAction(state, action);
  return next.winner !== null && next.winReason === "CAPTURE";
}

/**
 * The best move available that does not end the game on a capture, or null when
 * every move does.
 *
 * Two things this has to get right, both of which an earlier version did not.
 *
 * Candidates come from the shared safety pool rather than the raw legal move
 * list. Declining a capture only helps if the game then reaches a count, and a
 * move drawn from the legal list can hand the *opponent* a capture on the reply
 * — which ends the rollout the same way, and throws away every label in that
 * game with it. `getSafeActions` already falls back to every legal action when
 * nothing is safe, so this never runs out of candidates.
 *
 * And the ranking has to actually rank. This runs on roughly one move in eight
 * of a rollout — a 200-game pilot declined 1,572 capture wins — so a comparator
 * that silently fails to order anything picks an arbitrary move at precisely
 * the points where the label is decided.
 */
export function bestQuietAlternative(state: GameState, player: Player): AIAction | null {
  const { pool } = getSafeActions(state, player);
  const quiet = pool.filter((action) => !endsOnCapture(state, action));
  if (quiet.length === 0) return null;
  return rankByStaticEval(state, player, quiet)[0] ?? null;
}
