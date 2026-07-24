/** Maps a board position to the action-key that scored best there in an
 * earlier (possibly shallower) search — used purely as a move-ordering hint
 * ("try what worked last time first") to make alpha-beta pruning bite
 * harder, not as a cached evaluation. */
export class TranspositionTable {
  private bestMoveByPosition = new Map<string, string>();

  getBestMoveKey(positionKey: string): string | undefined {
    return this.bestMoveByPosition.get(positionKey);
  }

  setBestMoveKey(positionKey: string, actionKey: string): void {
    this.bestMoveByPosition.set(positionKey, actionKey);
  }

  clear(): void {
    this.bestMoveByPosition.clear();
  }

  get size(): number {
    return this.bestMoveByPosition.size;
  }
}
