import type { AIAction } from "../ai";
import { applyAction, getAIMove, getSafeActions } from "../ai";
import { opponentCanForceCapture } from "./captureSearch";
import { bestTwoMovePlan, findSealingMoves } from "./territoryPlanner";
import { BOARD_SIZE, CENTER, DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Coord, GameState, Player } from "../types";

/**
 * A scripted opponent that converts open ground into settled ground early, the
 * way the human player who keeps beating the engine does.
 *
 * This exists because the arena could not see the engine's actual weakness.
 * Games between the engines average about twenty moves and end in a capture, so
 * they only ever test the half of the game the engine is already good at. In
 * seven real games against a human the split was stark: the engine won all four
 * short capture races (16-27 moves) and lost both long territory games (50 and
 * 53 moves). In those two the human had settled ground by move 10-11 while the
 * engine managed nothing until move 22-29, and was behind for the rest of the
 * game no matter how well it defended.
 *
 * wideAreaBot was the earlier attempt at this and gets the first half right —
 * it stakes out the board with jumps — but it only closes a frame worth three
 * or more cells, so it spreads and spreads and rarely banks anything. This bot
 * inverts that priority: take the ground, even a cell at a time, and prefer
 * moves that bring a wall closer to closing. Corners and edges do half the
 * walling for free, which is exactly where the human plays.
 */

/**
 * How much ground a seal has to settle before it is worth spending a cat on.
 *
 * Measured, and the answer was not the obvious one. Raising this to 2 or 4 to
 * make the bot hold out for a worthwhile enclosure did not make it patient — it
 * stopped it sealing at all, and its games against VERY_HARD collapsed from
 * 32-57 moves down to 15-26, every one lost to capture.
 *
 * The reason is a rule interaction worth remembering: a liberty inside your own
 * settled area can never be filled by anyone, so closing even a two-cell corner
 * makes the wall around it permanently alive. The tiny seal this bot takes on
 * move three or four is not really about the two cells; it is what keeps its
 * first group from ever being captured. Which means the engine settling nothing
 * until move 22-29 costs it twice over — the ground, and the safety.
 */
const MIN_SEAL = 1;
/** Answer the opponent's frame only when it is bigger than what we can build. */
const BLOCK_THRESHOLD = 4;
/** A two-move plan has to promise this much before it beats taking ground now. */
const PLAN_THRESHOLD = 3;

function rimDistance({ row, col }: Coord): number {
  return Math.min(row, col, BOARD_SIZE - 1 - row, BOARD_SIZE - 1 - col);
}

/** Own cats adjacent or diagonally adjacent — a wall is built by staying in
 * touch, not by scattering. */
function nearbyOwn(state: GameState, move: Coord, player: Player): number {
  const own = playerCell(player);
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = move.row + dr;
      const c = move.col + dc;
      if (inBounds(r, c) && state.board[r][c] === own) count += 1;
    }
  }
  return count;
}

function touchingFoe(state: GameState, move: Coord, player: Player): number {
  const foe = playerCell(opponent(player));
  let count = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const r = move.row + dr;
    const c = move.col + dc;
    if (inBounds(r, c) && state.board[r][c] === foe) count += 1;
  }
  return count;
}

/** Depth and budget for checking that a territorial move is not just a gift.
 * A human playing this style still reads the local fight before committing. */
const READ_DEPTH = 6;
const READ_MS = 40;

export function sealingBotMove(state: GameState, player: Player): AIAction {
  // Take a win, and never volunteer a cat that the opponent takes next move.
  const { winningMove, pool } = getSafeActions(state, player);
  if (winningMove) return winningMove;

  const safe: Coord[] = pool
    .filter((a): a is Extract<AIAction, { type: "PLACE" }> => a.type === "PLACE")
    .map(({ row, col }) => ({ row, col }));
  if (safe.length === 0) return { type: "PASS" };
  const isSafe = (move: Coord) => safe.some((m) => m.row === move.row && m.col === move.col);

  /**
   * The one-move safety check above is not enough on its own. The first version
   * of this bot passed it and still lost 11 games in 12 to capture, ending
   * before area could decide anything — which is precisely the failure that
   * made the earlier wideAreaBot useless as an instrument. A territorial move
   * also has to survive the opponent reading the fight out.
   */
  const survivesReading = (move: Coord): boolean => {
    if (!isSafe(move)) return false;
    const next = applyAction(state, { type: "PLACE", ...move });
    if (next.winner) return next.winner === player;
    return !opponentCanForceCapture(next, player, READ_DEPTH, READ_MS);
  };

  const candidates: Coord[] = [];

  // 1. Deny a frame bigger than anything we could build right now.
  const mySeals = findSealingMoves(state, player).filter((s) => s.gained.length >= MIN_SEAL);
  const theirSeal = findSealingMoves(state, opponent(player))[0];
  if (
    theirSeal &&
    theirSeal.gained.length >= BLOCK_THRESHOLD &&
    theirSeal.gained.length > (mySeals[0]?.gained.length ?? 0)
  ) {
    candidates.push(theirSeal.move);
  }

  // 2. Bank ground whenever it is there — even a cell at a time. Holding out
  //    for a big enclosure is what left the previous bot with nothing settled.
  candidates.push(...mySeals.map((s) => s.move));

  // 3. Nothing closes yet: start the best two-move enclosure.
  const plan = bestTwoMovePlan(state, player);
  if (plan && plan.gained.length >= PLAN_THRESHOLD) candidates.push(plan.move);

  // 4. Build a frame where the board does half the walling: corners and edges
  //    need the fewest cats, which is where this style of player lives.
  candidates.push(
    ...safe
      .filter((move) => !(move.row === CENTER && move.col === CENTER))
      .map((move) => ({
        move,
        score:
          nearbyOwn(state, move, player) * 6 +
          (3 - Math.min(rimDistance(move), 3)) * 4 -
          touchingFoe(state, move, player) * 3,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((s) => s.move),
  );

  for (const move of candidates) {
    if (survivesReading(move)) return { type: "PLACE", ...move };
  }

  // Everything territorial reads badly — play the ordinary engine's move rather
  // than forcing the policy through and losing the game to it.
  return getAIMove(state, player, "NORMAL");
}
