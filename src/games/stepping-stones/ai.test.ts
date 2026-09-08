import { describe, expect, it } from "vitest";
import { getAIMove, type Difficulty } from "./ai";
import { createInitialState, getAllLegalActions, isLegalAction, playAction } from "./rules";
import type { GameState } from "./types";

const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];

describe.each(DIFFICULTIES)("getAIMove (%s)", (difficulty) => {
  it("always returns a legal action for the side to move", () => {
    let state: GameState = createInitialState();
    for (let i = 0; i < 15; i++) {
      if (state.winner) break;
      const action = getAIMove(state, difficulty);
      expect(isLegalAction(state, action)).toBe(true);
      state = playAction(state, action);
    }
  });

  it(
    "plays a full self-play game to completion without ever proposing an illegal move",
    () => {
      let state: GameState = createInitialState();
      let guard = 0;
      while (!state.winner && guard < 150) {
        const action = getAIMove(state, difficulty);
        expect(getAllLegalActions(state)).toContainEqual(action);
        state = playAction(state, action);
        guard++;
      }
      expect(state.winner).not.toBeNull();
    },
    30_000,
  );
});
