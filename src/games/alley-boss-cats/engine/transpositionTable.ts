/**
 * What kind of information a stored score carries.
 *
 * Alpha-beta does not always learn a position's true value. When a branch is
 * cut off, all that is known is that the value is at least (or at most) what
 * was seen — storing that as if it were exact would hand later lookups a
 * number the search never actually proved.
 */
export const enum Bound {
  /** The search examined every move: this is the position's real value. */
  Exact = 0,
  /** A cutoff stopped the search early — the true value is at least this. */
  Lower = 1,
  /** Every move came in below the window — the true value is at most this. */
  Upper = 2,
}

export interface TranspositionEntry {
  /** Plies of search remaining below this node when the score was produced.
   * A score read at a shallower depth than the current search needs is not
   * trustworthy enough to reuse, so this is checked before the score is. */
  depth: number;
  score: number;
  bound: Bound;
  /** Action-key that scored best here, kept even when the score itself is
   * too shallow to reuse — "try what worked last time first" costs nothing
   * and is what makes alpha-beta prune hard. */
  bestMoveKey: string | null;
}

/** Ceiling on stored positions. The table is per-search and a search visits
 * tens of thousands of nodes, so this is not normally reached; it exists so
 * a much faster search (or a much longer budget) cannot grow the map without
 * limit. Cleared wholesale rather than evicting one entry at a time —
 * picking a victim costs more than the occasional rebuild. */
const MAX_ENTRIES = 400_000;

/**
 * Maps a board position to what an earlier search learned about it: the best
 * move found there, and — when the search actually proved something — the
 * score and what kind of bound that score is.
 *
 * The move hint alone (all this table used to hold) only speeds up move
 * ordering. Storing the score as well lets a repeated position return its
 * answer outright instead of re-searching the subtree underneath it, which
 * is where most of the saving is: transpositions are common here because the
 * same few cells get played in different orders all over the tree.
 */
export class TranspositionTable {
  private entries = new Map<string, TranspositionEntry>();

  get(positionKey: string): TranspositionEntry | undefined {
    return this.entries.get(positionKey);
  }

  /** Move-ordering hint only — safe to use at any depth, since a hint that
   * turns out to be wrong costs a little ordering quality and nothing else. */
  getBestMoveKey(positionKey: string): string | undefined {
    return this.entries.get(positionKey)?.bestMoveKey ?? undefined;
  }

  /**
   * Records what this node learned. A deeper result always replaces a
   * shallower one; an equally deep one replaces too, since it comes from the
   * current iteration and reflects a better-ordered search. A shallower
   * result keeps whatever the deeper search already established, but still
   * refreshes the move hint, which has no depth requirement.
   */
  store(
    positionKey: string,
    depth: number,
    score: number,
    bound: Bound,
    bestMoveKey: string | null,
  ): void {
    const existing = this.entries.get(positionKey);
    if (existing && existing.depth > depth) {
      if (bestMoveKey) existing.bestMoveKey = bestMoveKey;
      return;
    }
    if (!existing && this.entries.size >= MAX_ENTRIES) this.entries.clear();
    this.entries.set(positionKey, {
      depth,
      score,
      bound,
      bestMoveKey: bestMoveKey ?? existing?.bestMoveKey ?? null,
    });
  }

  /** Stores a move hint without claiming anything about the score — used for
   * nodes whose search was cut short by the clock, where the value reached
   * so far is not a proven bound on anything. */
  setBestMoveKey(positionKey: string, actionKey: string): void {
    const existing = this.entries.get(positionKey);
    if (existing) {
      existing.bestMoveKey = actionKey;
      return;
    }
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    // depth -1 so any real search result outranks it.
    this.entries.set(positionKey, { depth: -1, score: 0, bound: Bound.Exact, bestMoveKey: actionKey });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
