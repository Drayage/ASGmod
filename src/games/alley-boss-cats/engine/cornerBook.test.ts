import { afterEach, describe, expect, it } from "vitest";
import {
  cornerBookMove,
  findBestMoveVeryHard,
  lastDecision,
  setCornerBookEnabled,
  setCornerBookFinishEnabled,
  setCornerBookFollowCap,
  setCornerBookFollowEnabled,
  setCornerBookLeaveContestedEnabled,
  setCornerBookSpreadEnabled,
  setLargerEnclosureEnabled,
  setSealOverridesBookEnabled,
} from "./minimax";
import { getLegalMoves } from "../rules";
import { calculateTerritories } from "../territory";
import { createInitialState } from "../rules";
import { playerCell } from "../types";
import type { GameState, Player } from "../types";
import type { AIAction } from "../ai";

/**
 * The book's budget used to count the mover's stones on the whole board, so a
 * side that had claimed two corners had three moves left against the four one
 * frame needs and never finished either. These pin the finishing rule: it keeps
 * building an opened corner past the old limit, it stops at the four stones the
 * frame is, and it will not open a third corner with the extra budget.
 */
function withStones(stones: Array<[number, number, Player]>): GameState {
  const state = createInitialState();
  const board = state.board.map((r) => [...r]);
  for (const [row, col, side] of stones) board[row][col] = playerCell(side);
  return { ...state, board, currentPlayer: "A" };
}

const pool = (state: GameState, side: Player): AIAction[] =>
  getLegalMoves(state, side).map((m) => ({ type: "PLACE", row: m.row, col: m.col }));

const at = (move: AIAction | null) =>
  move && move.type === "PLACE" ? `${move.row},${move.col}` : null;

afterEach(() => {
  setCornerBookFinishEnabled(false);
  setCornerBookEnabled(false);
  setCornerBookSpreadEnabled(false);
  setCornerBookLeaveContestedEnabled(false);
  setCornerBookFollowEnabled(false);
  setCornerBookFollowCap(3);
  setSealOverridesBookEnabled(false);
  setLargerEnclosureEnabled(true);
});

describe("the same enclosure, one size larger", () => {
  it("takes the wider closing point when it settles a superset", () => {
    // Their stones wall a corner; closing tight settles three cells, closing one
    // line out settles those three and two more. Nothing else is going on, so
    // the ladder falls through to the search and the upgrade applies.
    const state = withStones([
      [0, 3, "A"],
      [1, 2, "A"],
      [2, 1, "A"],
      [3, 0, "A"],
      [6, 6, "B"],
      [7, 7, "B"],
    ]);
    setLargerEnclosureEnabled(false);
    const tight = findBestMoveVeryHard(state, "A", 600);
    setLargerEnclosureEnabled(true);
    const wide = findBestMoveVeryHard(state, "A", 600);
    const cells = (move: typeof wide) => {
      if (move.type !== "PLACE") return 0;
      const board = state.board.map((r) => [...r]);
      board[move.row][move.col] = "PLAYER_A";
      return calculateTerritories(board).A.length;
    };
    expect(cells(wide)).toBeGreaterThanOrEqual(cells(tight));
  });

  it("does not fire when the move settles nothing", () => {
    // With nothing settled the empty set is a subset of every gain, so an
    // unguarded version would turn into "always take the biggest seal".
    const state = withStones([[6, 6, "A"], [2, 2, "B"]]);
    setLargerEnclosureEnabled(true);
    findBestMoveVeryHard(state, "A", 600);
    expect(lastDecision.stage.endsWith("+ larger")).toBe(false);
  });
});

describe("a concrete enclosure over a corner point that settles nothing", () => {
  it("takes the seal when the book move closes none and three cells are there", () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setSealOverridesBookEnabled(true);
    // A three-cell enclosure is one move from done in the bottom-left, and the
    // book would otherwise open a fresh corner and settle nothing.
    const state = withStones([
      [8, 2, "A"],
      [7, 1, "A"],
      [6, 0, "A"],
      [6, 6, "A"],
      // Well away and with room to breathe, so nothing is capturable and the
      // stages above the book all decline.
      [3, 4, "B"],
      [2, 5, "B"],
    ]);
    const move = findBestMoveVeryHard(state, "A", 800);
    expect(lastDecision.stage).toBe("1.88 seal over corner point");
    void move;
  });

  it("leaves the book alone when its own move already settles ground", () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setSealOverridesBookEnabled(true);
    const state = withStones([[1, 2, "A"], [3, 4, "B"], [2, 5, "B"]]);
    findBestMoveVeryHard(state, "A", 800);
    expect(lastDecision.stage).not.toBe("1.88 seal over corner point");
  });
});

describe("cornerBookMove with the finishing budget", () => {
  // Six own stones: the old gate stopped at five, so this position is exactly
  // where the two rules disagree.
  const started: Array<[number, number, Player]> = [
    [1, 2, "A"], // top-left frame
    [2, 1, "A"],
    [1, 6, "A"], // top-right frame
    [6, 6, "A"], // stones elsewhere, spending the old budget
    [6, 2, "A"],
    [4, 3, "A"],
  ];

  it("stops once the mover has five stones without it", () => {
    const state = withStones(started);
    expect(cornerBookMove(state, "A", pool(state, "A"))).toBeNull();
  });

  it("keeps building an opened corner with it", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones(started);
    // The top-left frame is (1,2) (2,1) (0,3) (3,0); two are down, so the book
    // has to offer one of the two that are not.
    expect(["0,3", "3,0"]).toContain(at(cornerBookMove(state, "A", pool(state, "A"))));
  });

  it("takes the middle of the frame first, not the edge one", () => {
    setCornerBookFinishEnabled(true);
    // One stone on the (1,2) point. (0,3) and (2,1) are both two steps away, and
    // the rules make them the worst and best second stone a corner has: (1,2)
    // with (2,1) kills an invader at all eight entry points, (1,2) with (0,3)
    // lets five of eight live. The tie has to break toward the middle.
    const state = withStones([
      [1, 2, "A"],
      [6, 6, "A"],
      [4, 3, "A"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("2,1");
  });

  it("leaves a finished frame alone", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "A"],
      [0, 3, "A"],
      [3, 0, "A"],
      [1, 6, "A"],
    ]);
    // Nothing more is owed to the top-left; the answer has to be the other
    // corner it has opened, never a fifth stone on the finished frame.
    const move = at(cornerBookMove(state, "A", pool(state, "A")));
    expect(["0,3", "3,0", "1,2", "2,1"]).not.toContain(move);
  });

  it("blocks along the edge when they are beside the edge point", () => {
    setCornerBookFinishEnabled(true);
    // Our stone on (1,2), theirs on (0,2) — the cell flanking the edge-side
    // frame point (0,3) along the first line. Measured on both of the corner's
    // edges: with the enemy there the edge point leaks at none of its entry
    // points and the middle one at three of seven, so the block outranks the
    // centrality rule here and only here.
    // Their stone at (0,4) is not touching ours, so the book is still choosing
    // a frame gap rather than dropping to the small eye.
    const state = withStones([
      [1, 2, "A"],
      [6, 6, "A"],
      [4, 3, "A"],
      [0, 4, "B"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,3");
  });

  it("takes the small eye toward the stone that is pressing", () => {
    setCornerBookFinishEnabled(true);
    // Their stone at (0,2) touches ours at (1,2), so this is the pressed branch
    // and the choice is between the two edge points either side. Measured: the
    // near one is never worse and is better at half the placements, and which
    // came first used to be the order the pair happens to be built in.
    const state = withStones([
      [1, 2, "A"],
      [6, 6, "A"],
      [4, 3, "A"],
      [0, 2, "B"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,1");
  });

  it("will not open a third corner", () => {
    setCornerBookFinishEnabled(true);
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "A"],
      [0, 3, "A"],
      [3, 0, "A"],
      [1, 6, "A"],
      [2, 7, "A"],
      [0, 5, "A"],
      [3, 8, "A"],
    ]);
    // Both corners are finished frames, so the book is done rather than
    // claiming a bottom corner with the budget it has left.
    expect(cornerBookMove(state, "A", pool(state, "A"))).toBeNull();
  });
});

/**
 * Leaving a corner the opponent has answered, which is the player's own read of
 * the position: the engine plays (1,2), they answer at (2,1), and the engine
 * spends a third stone there while a corner nobody is in sits open.
 */
describe("a corner they have answered", () => {
  const contested = () => withStones([[1, 2, "A"], [2, 1, "B"]]);

  it("is built up by default, which is what the player saw", () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    const state = contested();
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,3");
  });

  it("is left for an empty corner when the rule is on", () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookLeaveContestedEnabled(true);
    const state = contested();
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE").toBe(true);
    if (move && move.type === "PLACE") {
      // Any corner but the one they answered.
      expect(Math.min(move.row, 8 - move.row) + Math.min(move.col, 8 - move.col)).toBeLessThan(4);
      expect(move.row < 4 && move.col < 4).toBe(false);
    }
  });

  it("is built anyway once there is nowhere left to leave to", () => {
    // Leaving has to be leaving *for* something. With every other corner
    // already touched the rule must fall through to the claim it would have
    // made, not decline to move.
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookLeaveContestedEnabled(true);
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "B"],
      [1, 6, "B"],
      [6, 1, "B"],
      [6, 6, "B"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,3");
  });
});

/**
 * Following their investment rather than leaving outright, which is the player's
 * actual rule: at one stone each the corner is level and the next stone is worth
 * more somewhere untouched; when they make it two to one, come back and even it.
 */
describe("following what they spend on a corner", () => {
  const book = () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookFollowEnabled(true);
  };

  it("leaves a level corner for one nobody is in", () => {
    book();
    const state = withStones([[1, 2, "A"], [2, 1, "B"]]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row < 4 && move.col < 4).toBe(false);
  });

  it("finishes an uncontested pair before coming back to match", () => {
    book();
    // Two of theirs to one of mine in the top left, and my own lone stone in the
    // top right wanting its pair. The pair wins: a corner with two of mine and
    // none of theirs finishes worth 6.23 cells in the engine's recorded games,
    // more than any contested corner returns.
    //
    // This assertion used to run the other way, on my reading of "when they make
    // it two to one, come back" — the player corrected it twice.
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "B"],
      [0, 3, "B"],
      [1, 6, "A"],
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row < 4 && move.col >= 4).toBe(true);
  });

  it("comes back to match once nothing of mine is left to finish", () => {
    book();
    // Behind one to two in the bottom right, nothing of mine uncontested, and a
    // corner holding only their stone still open. Matching outranks entering.
    const state = withStones([
      [7, 6, "A"],
      [6, 7, "B"],
      [7, 7, "B"],
      [1, 6, "B"],
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row >= 4 && move.col >= 4).toBe(true);
  });

  it("leaves again once the corner is level", () => {
    book();
    const state = withStones([
      [1, 2, "A"],
      [2, 2, "A"],
      [2, 1, "B"],
      [0, 3, "B"],
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row < 4 && move.col < 4).toBe(false);
  });

  it("builds a level corner only when every other one already holds a stone of mine", () => {
    // Corners holding a stone of theirs and none of mine are somewhere to go —
    // see "what counts as somewhere to go" below, which is the player's
    // correction. Nowhere left means I am already in all of them.
    book();
    // Every other corner holds a finished pair of mine, so there is nothing to
    // complete and nowhere to enter — only then does the level corner get a
    // third stone.
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "B"],
      [1, 6, "A"], [2, 7, "A"],
      [6, 1, "A"], [7, 2, "A"],
      [6, 7, "A"], [7, 6, "A"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,3");
  });

  it("leaves an uncontested corner alone", () => {
    book();
    const state = withStones([[1, 2, "A"]]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("2,1");
  });
});

describe("where following stops", () => {
  const book = () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookFollowEnabled(true);
  };

  it("matches a second stone when they have two and I have one", () => {
    // The player's case, in the range the book actually operates in: they made
    // it two to one, so the corner is one I am behind in and worth returning to.
    book();
    // The top right already holds a finished pair, so nothing of mine is short
    // and the corner I am behind in is the one that gets the stone.
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "B"],
      [0, 3, "B"],
      [1, 6, "A"], [2, 7, "A"],
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row < 4 && move.col < 4).toBe(true);
  });

  it("does not follow them into a corner they have spent three on", () => {
    // Two separate locks agree here, and it is worth knowing which bites: the
    // corner is already past CORNER_BOOK_MAX_ENEMY, so the book declines before
    // the cap is ever consulted. The cap is the second lock, not the first —
    // raising the enemy limit is what would put it in play, and that is a
    // different experiment from this one.
    book();
    const state = withStones([
      [1, 2, "A"],
      [2, 1, "A"],
      [1, 1, "B"],
      [2, 2, "B"],
      [0, 2, "B"],
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE" && move.row < 4 && move.col < 4).toBe(false);
  });
});

describe("what counts as somewhere to go", () => {
  it("enters a corner holding only their stone before adding to a blocked one", () => {
    // The player watched the first version add a third stone to a corner already
    // blocked at one each while a corner holding one of theirs and none of mine
    // sat open. "Nowhere to go" was counting untouched corners only, so a corner
    // they had opened alone did not count as anywhere — even though entering it
    // is the move being weighed.
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookFollowEnabled(true);
    const state = withStones([
      [1, 2, "A"], [2, 1, "B"],   // top left, one each and blocked
      [1, 6, "B"],                // top right, theirs alone
      [7, 2, "A"], [6, 1, "A"],   // bottom left, my pair
      [7, 6, "A"], [6, 7, "A"],   // bottom right, my pair
    ]);
    const move = cornerBookMove(state, "A", pool(state, "A"));
    expect(move && move.type === "PLACE").toBe(true);
    if (move && move.type === "PLACE") {
      // Not the blocked corner.
      expect(move.row < 4 && move.col < 4).toBe(false);
      // The one they opened.
      expect(move.row < 4 && move.col >= 4).toBe(true);
    }
  });

  it("still builds the blocked corner when every other one holds a stone of mine", () => {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setCornerBookFollowEnabled(true);
    const state = withStones([
      [1, 2, "A"], [2, 1, "B"],
      [1, 6, "A"], [2, 7, "A"],
      [7, 2, "A"], [6, 1, "A"],
      [7, 6, "A"], [6, 7, "A"],
    ]);
    expect(at(cornerBookMove(state, "A", pool(state, "A")))).toBe("0,3");
  });
});
