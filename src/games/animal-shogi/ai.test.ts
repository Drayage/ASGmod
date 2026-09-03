import { describe, expect, it } from "vitest";
import { getAIMove } from "./ai";
import { createInitialState, isLegalAction, playAction } from "./rules";
import type { Difficulty } from "./ai";
import type { GameState } from "./types";

const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];

describe("getAIMove", () => {
  it.each(DIFFICULTIES)(
    "always returns a legal action for %s",
    (difficulty) => {
      let state: GameState = createInitialState();
      for (let i = 0; i < 10; i++) {
        if (state.winner) break;
        const action = getAIMove(state, difficulty);
        expect(isLegalAction(state, action, state.currentPlayer)).toBe(true);
        state = playAction(state, action).state;
      }
    },
    15_000,
  );

  it(
    "HARD plays a full game to completion",
    () => {
      let state: GameState = createInitialState();
      let moves = 0;
      while (!state.winner && moves < 200) {
        const action = getAIMove(state, "HARD");
        state = playAction(state, action).state;
        moves++;
      }
      expect(state.winner).not.toBeNull();
    },
    30_000,
  );
});
