import { describe, expect, it } from "vitest";
import { getAIMove, type Difficulty } from "./ai";
import { getAllLegalPlacements, isLegalPlacement, playAction } from "./rules";
import { createInitialState } from "./rules";
import type { GameState } from "./types";

const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];

describe.each(DIFFICULTIES)("getAIMove (%s)", (difficulty) => {
  it("always returns a legal action for the side to move", () => {
    const state = createInitialState();
    for (let i = 0; i < 20; i++) {
      const action = getAIMove(state, difficulty);
      expect(isLegalPlacement(state, state.currentPlayer, action.pieceId, action.cells)).toBe(true);
    }
  });

  it(
    "plays a full self-play game to completion without ever proposing an illegal move",
    () => {
      let state: GameState = createInitialState();
      let guard = 0;
      while (!state.winner && guard < 200) {
        const action = getAIMove(state, difficulty);
        expect(getAllLegalPlacements(state, state.currentPlayer)).toContainEqual(action);
        state = playAction(state, action);
        guard++;
      }
      expect(state.winner).not.toBeNull();
      expect(state.scores).not.toBeNull();
    },
    30_000,
  );
});
