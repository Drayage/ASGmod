import { describe, expect, it } from "vitest";
import games from "./testdata/humanGames.json";
import { applyMove, createInitialState, isLegalMove, passTurn } from "./rules";
import { findSealingMoves } from "./engine/territoryPlanner";
import type { GameState, Move, Player } from "./types";

/**
 * Seven real games a human played against VERY_HARD, exported from the app.
 *
 * They serve two purposes. First they are the only end-to-end check the rules
 * engine has against games it did not generate itself: every move was accepted
 * by the deployed build, so any of them turning illegal, or ending with a
 * different winner or a different count, is a regression the unit tests missed.
 *
 * Second, they are the record of where the engine actually loses. Its four wins
 * finish in 16-27 moves by capture; both long territory games — 50 and 53 moves
 * — it lost. Measured below: the human settles ground around move 10, the
 * engine not until move 22-29. That gap, not tactics, is what decides these
 * games, so it is worth pinning down before anything tries to close it.
 */

interface Record {
  id: string;
  playerSide: Player;
  winner: Player;
  winReason: "CAPTURE" | "TERRITORY";
  territoryA: number;
  territoryB: number;
  moveHistory: Move[];
}

const RECORDS = games.records as Record[];

function replay(record: Record): GameState[] {
  let state = createInitialState();
  const states = [state];
  for (const move of record.moveHistory) {
    state = move.type === "PASS" ? passTurn(state) : applyMove(state, move.row, move.col);
    states.push(state);
  }
  return states;
}

/** Turn number on which `player` first has any confirmed living area. */
function firstTerritoryTurn(states: GameState[], player: Player): number | null {
  for (let i = 1; i < states.length; i++) {
    if (states[i].territories[player].length > 0) return i;
  }
  return null;
}

describe("real games against VERY_HARD", () => {
  it("has the fixtures it claims to", () => {
    expect(RECORDS).toHaveLength(7);
    expect(RECORDS.every((r) => r.moveHistory.length > 0)).toBe(true);
  });

  it.each(RECORDS.map((r, i) => [i, r.id, r] as const))(
    "game %i (%s) replays move for move under the current rules",
    (_i, _id, record) => {
      let state = createInitialState();
      for (const move of record.moveHistory) {
        if (move.type === "PASS") {
          state = passTurn(state);
          continue;
        }
        expect(
          isLegalMove(state, move.row, move.col, move.player),
          `move ${move.turn} at (${move.row},${move.col}) became illegal`,
        ).toBe(true);
        state = applyMove(state, move.row, move.col);
      }

      expect(state.winner).toBe(record.winner);
      expect(state.winReason).toBe(record.winReason);
      expect(state.territories.A).toHaveLength(record.territoryA);
      expect(state.territories.B).toHaveLength(record.territoryB);
    },
  );

  it("records a capture win with the group that was surrounded", () => {
    for (const record of RECORDS.filter((r) => r.winReason === "CAPTURE")) {
      const states = replay(record);
      const final = states[states.length - 1];
      expect(final.capturedGroup, `game ${record.id}`).toBeDefined();
      expect(final.capturedGroup!.length).toBeGreaterThan(0);
    }
  });
});

describe("where the engine loses these games", () => {
  /** The two games decided by area rather than by a capture race. */
  const LONG_GAMES = RECORDS.filter((r) => r.moveHistory.length >= 50);

  it("pins the opening gap: the human settles ground long before the engine", () => {
    expect(LONG_GAMES).toHaveLength(2);

    for (const record of LONG_GAMES) {
      const states = replay(record);
      const ai: Player = record.playerSide === "A" ? "B" : "A";
      const human = record.playerSide;

      const aiFirst = firstTerritoryTurn(states, ai);
      const humanFirst = firstTerritoryTurn(states, human);

      expect(humanFirst).not.toBeNull();
      expect(aiFirst).not.toBeNull();
      // This is the defect, recorded rather than asserted away: the human is
      // ten-plus moves ahead on converting. Tighten these numbers as the
      // opening improves — the test should start failing when it gets better.
      expect(humanFirst!).toBeLessThanOrEqual(11);
      expect(aiFirst!).toBeGreaterThanOrEqual(22);
      expect(record.winner).toBe(human);
    }
  });

  it("shows the engine cannot enclose anything at all early on", () => {
    for (const record of LONG_GAMES) {
      const states = replay(record);
      const ai: Player = record.playerSide === "A" ? "B" : "A";

      // Through its first eight turns the engine has no move anywhere on the
      // board that would settle even one cell — its cats are too far apart to
      // wall anything in.
      let turnsWithNoSealAvailable = 0;
      for (let i = 0; i < Math.min(16, states.length - 1); i++) {
        if (states[i].currentPlayer !== ai) continue;
        if (findSealingMoves(states[i], ai).length === 0) turnsWithNoSealAvailable += 1;
      }
      expect(turnsWithNoSealAvailable).toBeGreaterThanOrEqual(7);
    }
  });
});
