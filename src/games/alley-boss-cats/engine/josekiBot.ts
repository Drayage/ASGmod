import type { AIAction } from "../ai";
import { applyAction, getSafeActions } from "../ai";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";
import { getConnectedGroup, getGroupLiberties } from "../groups";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Coord, GameState, Player } from "../types";

/**
 * A scripted opponent that plays the corner strategy the human player described,
 * so the questions left about it can be asked of an arena instead of them.
 *
 * The measurements that matter now all need games against a human-like opponent,
 * and asking for ten games a time has run out of road. The player's policy is
 * stable enough to be worth encoding — of 104 moves they made from a board they
 * had faced before, 64% were the same answer — while the games themselves
 * diverge by move three or four because the engine varies, so they cannot simply
 * be replayed from the record.
 *
 * The strategy, in their words across a long session:
 *
 *   - open on the corner's (1,2) point, and take a second corner on it next
 *   - the big shape is the four-stone frame (1,2) (2,1) (0,3) (3,0), which the
 *     rules confirm encloses six cells and cannot be entered once closed
 *   - under pressure drop to the small shape instead: (1,2) with an edge point
 *     either side, three stones and one eye, which is very hard to kill
 *   - go into their corners too; one or two enemy stones is still playable
 *   - size to the opposition — obstruct where they are strong, take the whole
 *     corner where they never came
 *   - do not over-invest in a small fight; take the bigger point
 *
 * IMPORTANT, and the reason `joseki-fit.mts` exists: this bot is a guess at the
 * player, not the player. Tuning the engine against it would be fitting the
 * engine to my reading of them. It is only usable as an instrument for as long
 * as it predicts their recorded moves better than the engine does, which is what
 * that script checks and what its threshold is for.
 */

/** How deep the bot reads before trusting a move not to lose a group. */
const READ_DEPTH = 7;
const READ_MS = 120;
/** Enemy stones a corner may hold and still be worth entering. Measured: of 122 */
/** stones played into a quadrant the opponent held, 118 were alive at the end. */
const MAX_ENEMY = 2;
/** Frame stones one corner is worth. Beyond four the rules pay nothing more. */
const FRAME_STONES = 4;

type Quadrant = "TL" | "TR" | "BL" | "BR";

const quadrantOf = (row: number, col: number): Quadrant | null => {
  const mid = (BOARD_SIZE - 1) / 2;
  if (row === mid || col === mid) return null;
  return `${row < mid ? "T" : "B"}${col < mid ? "L" : "R"}` as Quadrant;
};

/** The corner's anti-diagonal: the four cells whose edge distances sum to three. */
function frameOf(q: Quadrant): Coord[] {
  const rowEdge = q[0] === "T" ? 0 : BOARD_SIZE - 1;
  const colEdge = q[1] === "L" ? 0 : BOARD_SIZE - 1;
  const step = (n: number, edge: number) => (edge === 0 ? n : edge - n);
  return [0, 1, 2, 3].map((a) => ({ row: step(a, rowEdge), col: step(3 - a, colEdge) }));
}

/**
 * The corner's professional points — both of them.
 *
 * A cell's class is the sorted pair of its distances to the two nearest edges,
 * so a corner has two cells of class (1,2), not one: on the bottom-right they
 * are G8 and H7. The first version of this returned only the frame's second
 * cell, which is one of the pair, and the player opens on the other one — H7 on
 * 64% of their first moves as A. Naming one of two equivalent points and calling
 * it the book was a mistake in the bot, not a difference in strategy.
 */
const proPointsOf = (q: Quadrant): Coord[] => [frameOf(q)[1], frameOf(q)[2]];

/**
 * The small shape: the (1,2) stone with the edge point either side of it. Three
 * stones, one eye, and the player's report is that they have never had it killed.
 */
function smallEyeOf(q: Quadrant): Coord[] {
  const rowEdge = q[0] === "T" ? 0 : BOARD_SIZE - 1;
  const colEdge = q[1] === "L" ? 0 : BOARD_SIZE - 1;
  const pro = frameOf(q)[1];
  const along = Math.abs(pro.row - rowEdge) < Math.abs(pro.col - colEdge);
  return along
    ? [{ row: rowEdge, col: pro.col - 1 }, { row: rowEdge, col: pro.col + 1 }]
    : [{ row: pro.row - 1, col: colEdge }, { row: pro.row + 1, col: colEdge }];
}

interface Holding {
  mine: number;
  theirs: number;
  /** My stones sitting on this corner's frame line. */
  frame: number;
  /** Their stones touching one of mine here — the sign to take the small shape. */
  touching: boolean;
}

function survey(state: GameState, player: Player): Record<Quadrant, Holding> {
  const held: Record<Quadrant, Holding> = {
    TL: { mine: 0, theirs: 0, frame: 0, touching: false },
    TR: { mine: 0, theirs: 0, frame: 0, touching: false },
    BL: { mine: 0, theirs: 0, frame: 0, touching: false },
    BR: { mine: 0, theirs: 0, frame: 0, touching: false },
  };
  const me = playerCell(player);
  const them = playerCell(opponent(player));
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = state.board[row][col];
      if (cell !== me && cell !== them) continue;
      const q = quadrantOf(row, col);
      if (!q) continue;
      if (cell === me) {
        held[q].mine += 1;
        const dr = Math.min(row, BOARD_SIZE - 1 - row);
        const dc = Math.min(col, BOARD_SIZE - 1 - col);
        if (dr + dc === 3) held[q].frame += 1;
        for (const [ar, ac] of DIRECTIONS) {
          const r = row + ar;
          const c = col + ac;
          if (inBounds(r, c) && state.board[r][c] === them) held[q].touching = true;
        }
      } else {
        held[q].theirs += 1;
      }
    }
  }
  return held;
}

/** Liberties the group at a point would have — used to prefer room over contact. */
function roomAt(state: GameState, move: Coord, player: Player): number {
  const board = state.board.map((r) => [...r]);
  board[move.row][move.col] = playerCell(player);
  return getGroupLiberties(board, getConnectedGroup(board, move.row, move.col)).size;
}

export function josekiBotMove(state: GameState, player: Player): AIAction {
  // Win outright when it is there, and never hand over a group in one move.
  const { winningMove, pool } = getSafeActions(state, player);
  if (winningMove) return winningMove;
  const safe = pool.filter((a): a is Extract<AIAction, { type: "PLACE" }> => a.type === "PLACE");
  if (safe.length === 0) return { type: "PASS" };
  const playable = (move: Coord) =>
    safe.some((a) => a.row === move.row && a.col === move.col);

  // A move also has to survive the fight being read out. The player's whole
  // stated method is "only look at lines where I don't die, then take the
  // bigger place", so this is the filter that makes the rest of it theirs.
  const sound = (move: Coord): boolean => {
    if (!playable(move)) return false;
    const next = applyAction(state, { type: "PLACE", ...move });
    if (next.winner) return next.winner === player;
    return !opponentCanForceCapture(next, player, READ_DEPTH, READ_MS);
  };
  const first = (moves: Coord[]): AIAction | null => {
    for (const move of moves) if (sound(move)) return { type: "PLACE", ...move };
    return null;
  };

  // 1. Save a group that is about to be taken. Nothing else matters: a capture
  //    ends the game, so there is no writing one off and playing elsewhere.
  const threat = findForcedCapture({ ...state, currentPlayer: opponent(player) }, opponent(player), READ_DEPTH, READ_MS);
  if (threat) {
    const rescue = safe
      .map((a) => ({ row: a.row, col: a.col }))
      .filter((move) => {
        const next = applyAction(state, { type: "PLACE", ...move });
        return !next.winner && !opponentCanForceCapture(next, player, READ_DEPTH, READ_MS);
      })
      .sort((a, b) => roomAt(state, b, player) - roomAt(state, a, player));
    if (rescue.length > 0) return { type: "PLACE", ...rescue[0] };
  }

  const held = survey(state, player);
  const quadrants: Quadrant[] = ["TL", "TR", "BL", "BR"];

  // 2. Finish a corner already started. Pressed, that means the small eye; free,
  //    it means the next stone of the frame. Sized to the opposition, which is
  //    the rule the player states and the records show both sides following.
  for (const q of quadrants) {
    const h = held[q];
    if (h.mine === 0 || h.theirs > MAX_ENEMY) continue;
    if (h.frame >= FRAME_STONES) continue;
    const pressed = h.theirs >= 2 || h.touching;
    const wanted = pressed ? smallEyeOf(q) : frameOf(q);
    const move = first(wanted.filter((c) => inBounds(c.row, c.col) && state.board[c.row][c.col] === "EMPTY"));
    if (move) return move;
  }

  // 3. Open a corner nobody holds, on its professional point.
  const fresh = quadrants
    .filter((q) => held[q].mine === 0 && held[q].theirs === 0)
    .flatMap(proPointsOf);
  const opened = first(fresh);
  if (opened) return opened;

  // 4. Go into one of theirs. One or two stones there is still playable, and
  //    leaving every corner they touch to them is how the corner count is lost.
  const theirs = quadrants
    .filter((q) => held[q].mine === 0 && held[q].theirs > 0 && held[q].theirs <= MAX_ENEMY)
    .flatMap(proPointsOf);
  const entered = first(theirs);
  if (entered) return entered;

  // 5. Nothing in the corners is owed. Take the point with the most room that
  //    is not glued to a stone — the spacing the player describes, one step off,
  //    so it can still be joined either way.
  const rest = safe
    .map((a) => ({ row: a.row, col: a.col }))
    .map((move) => ({ move, room: roomAt(state, move, player) }))
    .sort((a, b) => b.room - a.room)
    .map((x) => x.move);
  const spaced = first(rest);
  if (spaced) return spaced;

  return { type: "PLACE", row: safe[0].row, col: safe[0].col };
}
