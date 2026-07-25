import { describe, expect, it } from "vitest";
import games from "./testdata/humanGames.json";
import { applyMove, createInitialState, isLegalMove, passTurn } from "./rules";
import { findSealingMoves, planTerritory } from "./engine/territoryPlanner";
import { findBestMoveVeryHard } from "./engine/minimax";
import { opponentCanForceCapture } from "./engine/captureSearch";
import type { GameState, Move, Player } from "./types";

/**
 * Real games a human played against VERY_HARD, exported from the app.
 *
 * They serve two purposes. First they are the only end-to-end check the rules
 * engine has against games it did not generate itself: every move was accepted
 * by the deployed build, so any of them turning illegal, or ending with a
 * different winner or a different count, is a regression the unit tests missed.
 *
 * Second, they are the record of where the engine actually loses. It wins the
 * short capture races; the long games decided on area are the ones it dropped.
 * Measured below: in those, the human settles ground around move 10 and the
 * engine not until move 22 or later. That gap, not tactics, is what decides
 * them, which is why the last group here pins one exact position.
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
    expect(RECORDS.length).toBeGreaterThanOrEqual(15);
    expect(RECORDS.every((r) => r.moveHistory.length > 0)).toBe(true);
    expect(new Set(RECORDS.map((r) => r.id)).size).toBe(RECORDS.length);
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
  /** Long games the human won — the ones area decided, rather than a capture
   * race the engine was always going to win. */
  const LONG_GAMES = RECORDS.filter(
    (r) => r.moveHistory.length >= 49 && r.winner === r.playerSide,
  );

  it("pins the opening gap: the human settles ground long before the engine", () => {
    expect(LONG_GAMES.length).toBeGreaterThanOrEqual(2);

    for (const record of LONG_GAMES) {
      const states = replay(record);
      const ai: Player = record.playerSide === "A" ? "B" : "A";
      const human = record.playerSide;

      const aiFirst = firstTerritoryTurn(states, ai);
      const humanFirst = firstTerritoryTurn(states, human);

      expect(humanFirst).not.toBeNull();
      expect(aiFirst).not.toBeNull();
      // The human converts by move 12 in every one of these, and the engine
      // always later — 15, 22, 29. Deliberately stated as loosely as the data
      // supports: a tighter bound fitted to the first two games broke as soon
      // as a third arrived, in which the engine converted on move 15 and lost
      // anyway, for the quite separate reason pinned in the group below. There
      // is more than one way to lose these, and this assertion only claims the
      // part that holds across all of them.
      expect(humanFirst!).toBeLessThanOrEqual(12);
      expect(aiFirst!).toBeGreaterThan(humanFirst!);
      expect(record.winner).toBe(human);
    }
  });

  it("shows the engine cannot enclose anything at all early on", () => {
    for (const record of LONG_GAMES) {
      const states = replay(record);
      const ai: Player = record.playerSide === "A" ? "B" : "A";

      // Through almost all of its first eight turns the engine has no move
      // anywhere on the board that would settle even one cell — its cats are
      // too far apart to wall anything in.
      let turns = 0;
      let turnsWithNoSealAvailable = 0;
      for (let i = 0; i < Math.min(16, states.length - 1); i++) {
        if (states[i].currentPlayer !== ai) continue;
        turns += 1;
        if (findSealingMoves(states[i], ai).length === 0) turnsWithNoSealAvailable += 1;
      }
      expect(turnsWithNoSealAvailable).toBeGreaterThanOrEqual(turns - 2);
    }
  });
});

describe("answering a large enclosure", () => {
  /**
   * The position that cost a game 11-22, and the narrowest test in this file.
   *
   * 고등어냥 had spread a diagonal down the left side and could settle ten cells
   * with one cat at (4,0). The engine could see it — the planner reported the
   * threat and put every answer to it on the shortlist — and then played an
   * expanding move from the same shortlist, worth one cell, on the far side of
   * the board. Sixteen moves in, the count was 3-13 and it never recovered.
   */
  const DECIDED_GAME = "1784982918951-4u5evc";
  const PLY = 14; // 치즈냥 to play its fifteenth move

  function decisivePosition(): GameState {
    const record = RECORDS.find((r) => r.id === DECIDED_GAME)!;
    return replay(record)[PLY];
  }

  it("sees the threat", () => {
    const state = decisivePosition();
    expect(state.currentPlayer).toBe("A");

    const plan = planTerritory(state, "A");
    expect(plan.imminent).toBe(true);
    expect(plan.theirBestSeal?.gained).toHaveLength(10);
    expect(plan.theirBestSeal?.move).toEqual({ row: 4, col: 0 });
  });

  it.each([300, 600, 800, 1200, 2500])("answers it on a %ims budget", (budget) => {
    // Budget matters because the engine runs on a phone: the same three seconds
    // buys far less search there, and the failure only showed up under that
    // pressure. Every one of these used to be able to wander off instead.
    const action = findBestMoveVeryHard(decisivePosition(), "A", budget);
    expect(action.type).toBe("PLACE");

    const move = action as { row: number; col: number };
    const answers = planTerritory(decisivePosition(), "A").blockingMoves;
    expect(
      answers.some((a) => a.type === "PLACE" && a.row === move.row && a.col === move.col),
      `played (${move.row},${move.col}), which does not answer the enclosure`,
    ).toBe(true);
  });
});

describe("walking a lone cat into a dead corner", () => {
  /**
   * The position that cost a game 6-1 by CAPTURE, exported straight from the
   * app. 치즈냥 (A) played (4,8) — a single cat, edge column, three liberties —
   * squeezed into the pocket between 고등어냥's column-7 wall and its stone at
   * (2,8). The engine's own forced-capture reader can already see the kill the
   * instant that stone lands, and 고등어냥 needed only three unhurried moves
   * (18, 20, 22) to actually take it, since 치즈냥 spent turns 19 and 21
   * elsewhere. The stone was never savable once placed: every legal extension
   * from it re-lands on exactly one liberty, because the surrounding cells
   * were already 고등어냥's.
   *
   * Playing (4,8) survived here because it scored nothing by local move
   * order (45th of 60 legal moves) and so never got the forced-capture check
   * every top-ranked candidate gets — the deeper positional search picked it
   * anyway, for the open ground it looked like it was grabbing, and nothing
   * downstream ever asked whether that specific choice was safe.
   */
  const DECIDED_GAME = "1784994937163-cj5fkb";
  const PLY = 16; // 치즈냥 to play its seventeenth move

  function positionBeforeTheBlunder(): GameState {
    const record = RECORDS.find((r) => r.id === DECIDED_GAME)!;
    return replay(record)[PLY];
  }

  it("confirms (4,8) is already a proven forced capture the moment it's played", () => {
    const state = positionBeforeTheBlunder();
    expect(state.currentPlayer).toBe("A");

    const afterBlunder = applyMove(state, 4, 8);
    expect(opponentCanForceCapture(afterBlunder, "A", 9, 5000)).toBe(true);
  });

  // A generous, fixed-budget check of "is this move forceable at all" turns
  // out to be far too blunt an invariant for this position to hold in
  // general: mapping every legal reply here found 53 of 60 read as a proven
  // forced capture at the engine's own search depth, most of them isolated
  // stones nowhere near 고등어냥's wall — a lone stone dropped onto a board
  // that already has sixteen others scattered across it can often be laddered
  // into one of them, whatever the shape. That is a real property of the
  // position, not a bug, so the test pins the one thing that actually is a
  // bug: replaying the exact historical blunder.
  it.each([2000, 3000])("never plays (4,8) again on a %ims budget", (budget) => {
    const state = positionBeforeTheBlunder();
    const action = findBestMoveVeryHard(state, "A", budget);
    expect(action).not.toEqual({ type: "PLACE", row: 4, col: 8 });
  });
});
