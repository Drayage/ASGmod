import type { AIAction } from "../ai";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "../groups";
import { getLegalMoves, isLegalMove } from "../rules";
import { DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Board, GameState, Player } from "../types";

/**
 * A cheap, purely local score for a candidate placement.
 *
 * Ranking moves by the full evaluation meant applying the move and rescanning
 * the whole board for every child of every node — the ordering alone cost more
 * than the search it was meant to speed up. This only inspects the groups
 * touching the placed cell, which is what decides captures and escapes anyway.
 */
export function localMoveScore(board: Board, row: number, col: number, player: Player): number {
  const own = playerCell(player);
  const enemy = playerCell(opponent(player));

  board[row][col] = own;
  let score = 0;

  try {
    const scoredEnemyGroups = new Set<string>();

    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) {
        score += 3; // hugging a wall helps close off territory cheaply
        continue;
      }

      const value = board[r][c];
      if (value === enemy) {
        const group = getConnectedGroup(board, r, c);
        // Canonical key so a group touched from two sides is scored once.
        const anchor = group.reduce((a, b) => (a.row * 100 + a.col <= b.row * 100 + b.col ? a : b));
        const key = `${anchor.row},${anchor.col}`;
        if (!scoredEnemyGroups.has(key)) {
          scoredEnemyGroups.add(key);
          const liberties = getGroupLiberties(board, group).size;
          if (liberties === 0) score += 1_000_000; // outright capture = win
          else if (liberties === 1) score += 900;
          else if (liberties === 2) score += 130;
          score += group.length * 6;
        }
      } else if (value === own) {
        score += 6; // connecting is usually solid
      }
    }

    const ownGroup = getConnectedGroup(board, row, col);
    const ownLiberties = getGroupLiberties(board, ownGroup).size;
    if (ownLiberties === 1) score -= 800;
    else if (ownLiberties === 2) score -= 170;
    else score += ownLiberties * 4;
  } finally {
    board[row][col] = "EMPTY";
  }

  return score;
}

/**
 * Legal placements sorted by `localMoveScore`, capped at `limit`. Because
 * captures and escapes dominate the score, trimming the tail never drops a
 * tactically relevant move.
 */
/**
 * The points where this game is decided on the very next move, for either side.
 *
 * Every inner node keeps only the top `limit` moves by `localMoveScore`, and at
 * depth one that is six of roughly fifty. Nothing was making sure the move that
 * saves a group in atari survived that cut — and when it did not, the search
 * watched the defender fail to save it and scored the line as a capture. It had
 * not refuted the escape; it had never generated it.
 *
 * Measured on 17 fruitless chases from recorded games: the search called two of
 * them already-won and four near-decisive, and playing them out captured
 * nothing at all. Widening every node fourfold made all six disappear, which is
 * the same fix as this one but paid for at every node instead of the few where
 * something is actually in atari.
 *
 * Both sides' ataris matter and for the same reason. The liberty of my own
 * endangered group is the only move that can save it; the liberty of theirs
 * ends the game on the spot, since one capture wins outright here. Neither may
 * be dropped for scoring badly on a shape heuristic.
 */
/**
 * On. Turned off once on a bad number, and back on once that number was checked.
 *
 * The recorded games appeared to show mean depth falling from 5.87 to 5.00 on
 * the build carrying this. They did not. All three games in that sample ended
 * before turn 40, and turns 40+ are the deepest part of any game at 7.7 — so a
 * sample missing its endgame was being compared against samples that had one.
 * Matched on shared turn ranges the gap is 0.30, resting on buckets of eleven
 * and ten moves, and the 10-19 bucket is deeper on the new build.
 *
 * Paired at the shipped 3000ms budget, same positions, over 263 of them:
 * +0.01 ply for this, +0.03 for the leaf computation now gated below. Both
 * effectively free, and those are the measurements to trust — same position,
 * alternating order, one variable.
 *
 * Against that, what it buys is verified by playing the positions out: the
 * engine's phantom captures went 6 to 0, and the arena had it winning 41-27
 * while being captured 17 times against 24.
 */
export let decisivePointsEnabled = true;
export function setDecisivePointsEnabled(value: boolean): void {
  decisivePointsEnabled = value;
}

function decisivePoints(state: GameState, player: Player): AIAction[] {
  const out: AIAction[] = [];
  const seen = new Set<string>();
  for (const side of [player, opponent(player)]) {
    for (const group of getAllGroups(state.board, side)) {
      const liberties = getGroupLiberties(state.board, group);
      if (liberties.size !== 1) continue;
      const [only] = liberties;
      if (seen.has(only)) continue;
      const [row, col] = only.split(",").map(Number);
      if (!isLegalMove(state, row, col, player)) continue;
      seen.add(only);
      out.push({ type: "PLACE", row, col });
    }
  }
  return out;
}

/**
 * Off until measured. See `edgeFramingPoints`.
 */
export let edgeFramingEnabled = false;
export function setEdgeFramingEnabled(value: boolean): void {
  edgeFramingEnabled = value;
}

/** How far along the edge an extension may reach. The human's spacing between
 * consecutively played wall stones is 46% one, 27% two, 18% three. */
const MAX_EDGE_STEP = 3;

/**
 * Extensions along the board edge from a stone already sitting near it.
 *
 * Measured over six recorded games: humans take 1.22 cells of final territory
 * per wall stone against the engine's 0.82, and 43% of a human large region's
 * boundary is board edge against the engine's 13%. Humans wall against the edge
 * and let the board supply half the enclosure; the engine builds in the open and
 * pays seven stones for the same six cells.
 *
 * The engine is not scoring those points badly so much as never reaching them.
 * Ranked by `localMoveScore`, a human first-line move averages 35.9th of 50 and
 * enters a 14-move candidate list 19% of the time, where the same human's
 * fourth-line moves enter it 80% of the time. The root searches the whole safe
 * pool, so the first edge stone is always considered — but every inner node
 * keeps only its top few, so the follow-up that turns one stone into a wall is
 * pruned, and the leaf never sees a frame that a human would already be
 * counting.
 *
 * Raising the edge's score does not fix that: the moves beating it are contact
 * and atari moves scoring 130 and 900, and a blanket first-line bonus promotes
 * the rival edge moves along with the intended one — +20 recovers 22% of the
 * misses. So this reserves a slot instead, which is the shape of the two
 * changes in this engine that did work.
 *
 * Deliberately narrow and local: from each own stone on the first or second
 * line, step 1 to 3 cells along the edge, stop at the first occupied cell, skip
 * anything an enemy stone already touches, and keep the two best by how much
 * empty edge the extension spans.
 */
export function edgeFramingPoints(state: GameState, player: Player, max = 2): AIAction[] {
  const own = playerCell(player);
  const enemy = playerCell(opponent(player));
  const found = new Map<string, number>();

  for (let row = 0; row < state.board.length; row += 1) {
    for (let col = 0; col < state.board.length; col += 1) {
      if (state.board[row][col] !== own) continue;
      const line = Math.min(row, col, state.board.length - 1 - row, state.board.length - 1 - col);
      if (line > 1) continue;

      for (const [dr, dc] of DIRECTIONS) {
        for (let step = 1; step <= MAX_EDGE_STEP; step += 1) {
          const r = row + dr * step;
          const c = col + dc * step;
          if (!inBounds(r, c) || state.board[r][c] !== "EMPTY") break;
          // Stay near the edge: an extension that walks inward is an ordinary
          // move and the ordering already judges it on its own merits.
          const stepLine = Math.min(r, c, state.board.length - 1 - r, state.board.length - 1 - c);
          if (stepLine > 1) break;

          let touchesEnemy = false;
          for (const [er, ec] of DIRECTIONS) {
            if (inBounds(r + er, c + ec) && state.board[r + er][c + ec] === enemy) {
              touchesEnemy = true;
              break;
            }
          }
          if (touchesEnemy) continue;
          if (!isLegalMove(state, r, c, player)) continue;

          // Reaching further claims more, but only up to what stays defensible;
          // ties go to the wider extension.
          const key = `${r},${c}`;
          found.set(key, Math.max(found.get(key) ?? 0, step));
        }
      }
    }
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => {
      const [row, col] = key.split(",").map(Number);
      return { type: "PLACE", row, col } as AIAction;
    });
}

export function orderedCandidates(
  state: GameState,
  player: Player,
  limit: number,
  preferredKey?: string,
  framing = false,
): AIAction[] {
  const scored = getLegalMoves(state, player).map((move) => ({
    action: { type: "PLACE", row: move.row, col: move.col } as AIAction,
    score: localMoveScore(state.board, move.row, move.col, player),
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit).map(({ action }) => action);

  // Put back anything decisive that the cut removed. Added rather than
  // substituted: these are extra moves to look at, never a replacement for the
  // ones the ordering already liked.
  const present = new Set(
    top.map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS")),
  );
  if (decisivePointsEnabled) for (const action of decisivePoints(state, player)) {
    if (action.type !== "PLACE") continue;
    const key = `${action.row},${action.col}`;
    if (present.has(key)) continue;
    present.add(key);
    top.unshift(action);
  }

  // Appended, not unshifted: a decisive point has to be looked at first, an
  // edge extension only has to be looked at.
  if (framing && edgeFramingEnabled) for (const action of edgeFramingPoints(state, player)) {
    if (action.type !== "PLACE") continue;
    const key = `${action.row},${action.col}`;
    if (present.has(key)) continue;
    present.add(key);
    top.push(action);
  }

  if (!preferredKey) return top;

  // Search the full list for the transposition table's hint, not just the
  // trimmed head, so a good move found at a shallower depth is never lost.
  const hintIndex = top.findIndex(
    (a) => a.type === "PLACE" && `${a.row},${a.col}` === preferredKey,
  );
  if (hintIndex > 0) {
    const [hinted] = top.splice(hintIndex, 1);
    return [hinted, ...top];
  }
  if (hintIndex === 0) return top;

  const fromFull = scored.find(
    ({ action }) => action.type === "PLACE" && `${action.row},${action.col}` === preferredKey,
  );
  return fromFull ? [fromFull.action, ...top] : top;
}
