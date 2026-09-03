import { describe, expect, it } from "vitest";
import { getAIMove } from "./ai";
import { createInitialState, isLegalAction, playMove } from "./rules";
import type { Difficulty } from "./ai";
import type { GameState } from "./types";

const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];

describe("getAIMove", () => {
  it.each(DIFFICULTIES)("always returns a legal action for %s", (difficulty) => {
    let state: GameState = createInitialState("practice-garden");
    for (let i = 0; i < 6; i++) {
      if (state.winner) break;
      const action = getAIMove(state, difficulty);
      expect(isLegalAction(state, action, state.currentPlayer)).toBe(true);
      state = playMove(state, action).state;
    }
  });

  it(
    "HARD plays a full game to completion within a reasonable move count",
    () => {
      let state: GameState = createInitialState("central-pond");
      let moves = 0;
      while (!state.winner && moves < 200) {
        const action = getAIMove(state, "HARD");
        state = playMove(state, action).state;
        moves++;
      }
      expect(state.winner).not.toBeNull();
    },
    120_000,
  );
});
