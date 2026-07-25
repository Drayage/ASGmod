import { applyAction } from "../ai";
import { calculateTerritories } from "../territory";
import { isLegalMove } from "../rules";
import { findForcedCapture } from "./captureSearch";
import { BOARD_SIZE, inBounds, opponent, playerCell } from "../types";
import type { Board, Coord, GameState, Player } from "../types";

/**
 * Frameworks: ground a player is close to walling off, and whether it is
 * actually theirs.
 *
 * Counting settled territory is too late a signal — by the time a region shows
 * up there the game is decided. Counting influence is too loose: it rewards
 * spreading cats out, which is exactly what left the engine unable to enclose a
 * single cell for its first eight turns. What sits between the two is a wall
 * that is nearly built, and the question of whether the other player can do
 * anything about it.
 *
 * The test applied here is the one a strong human player actually uses. A
 * region is only yours if, whatever the opponent tries, you keep it:
 *
 *  - if they play *inside* it, you can surround and destroy that cat, and
 *  - if they take the point you were going to close with, you have another way
 *    to close.
 *
 * A frame failing either test is not territory-in-waiting, it is a claim. The
 * bigger the region, the more room an invading cat has to live, so large loose
 * frames fail the first test routinely — which is why walling off a modest
 * corner beats sketching out half the board.
 */

/** Cheapest shape there is: n cats laid diagonally across a corner enclose
 * n(n-1)/2 cells, and the two board edges do the rest of the walling for free.
 * These are the lines worth checking. */
const CORNERS: ReadonlyArray<{ row: number; col: number; dr: number; dc: number }> = [
  { row: 0, col: 0, dr: 1, dc: 1 },
  { row: 0, col: BOARD_SIZE - 1, dr: 1, dc: -1 },
  { row: BOARD_SIZE - 1, col: 0, dr: -1, dc: 1 },
  { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1, dr: -1, dc: -1 },
];

/** Smallest and largest corner cut worth considering. Below three the prize is
 * not worth a cat; above seven the region is too big to defend against an
 * invasion, which is the whole point of the security test. */
const MIN_CUT = 3;
const MAX_CUT = 7;

export interface Framework {
  /** Which corner this cut walls off. */
  corner: Coord;
  /** Cells that must all be mine for the corner to be sealed. */
  wall: Coord[];
  /** Ground it would enclose. */
  enclosed: Coord[];
  /** Wall points still empty — what completing it would cost, in cats. */
  missing: Coord[];
  /** Enemy cats sitting on the wall line or inside the region. */
  intruders: Coord[];
}

/** Every corner cut, described but not yet judged. */
export function candidateFrameworks(board: Board, player: Player): Framework[] {
  const own = playerCell(player);
  const foe = playerCell(opponent(player));
  const frames: Framework[] = [];

  for (const corner of CORNERS) {
    for (let d = MIN_CUT; d <= MAX_CUT; d++) {
      const wall: Coord[] = [];
      let offBoard = false;
      for (let i = 0; i <= d; i++) {
        const row = corner.row + corner.dr * i;
        const col = corner.col + corner.dc * (d - i);
        if (!inBounds(row, col)) {
          offBoard = true;
          break;
        }
        wall.push({ row, col });
      }
      if (offBoard) continue;

      // Everything strictly nearer the corner than the line.
      const enclosed: Coord[] = [];
      for (let i = 0; i < d; i++) {
        for (let j = 0; j < d - i; j++) {
          const row = corner.row + corner.dr * i;
          const col = corner.col + corner.dc * j;
          if (inBounds(row, col)) enclosed.push({ row, col });
        }
      }

      const missing = wall.filter(({ row, col }) => board[row][col] === "EMPTY");
      const intruders = [...wall, ...enclosed].filter(({ row, col }) => board[row][col] === foe);
      // A wall point held by neither of us and not empty (the feeding spot)
      // can never be ours, so the cut is impossible.
      const blocked = wall.some(({ row, col }) => board[row][col] === "NEUTRAL");
      if (blocked) continue;
      // Ignore cuts we have not started: every corner would otherwise qualify.
      if (!wall.some(({ row, col }) => board[row][col] === own)) continue;

      frames.push({ corner: { row: corner.row, col: corner.col }, wall, enclosed, missing, intruders });
    }
  }

  return frames;
}

/**
 * A cheap, search-free reading of how much ground each side has nearly walled
 * off — enumeration only, so it is safe to call at every leaf of the search.
 *
 * The security judgement below is the honest test, but it runs capture reads
 * and costs far too much for an evaluation. This keeps the part that matters
 * for steering: ground enclosed, discounted by how many cats it would still
 * take to close, and abandoned entirely once the opponent is inside it.
 *
 * Only the best frame per corner counts. Summing every offset would pay the
 * same corner four times over, and the engine would learn to pile cats into
 * one corner rather than take four.
 */
export function frameworkPotential(board: Board, player: Player): number {
  const bestPerCorner = new Map<string, number>();

  for (const frame of candidateFrameworks(board, player)) {
    if (frame.intruders.length > 0) continue;
    // A closed frame is territory, and the territory term already pays for it.
    // Counting it here as well would make corner ground worth twice what the
    // same ground is worth anywhere else.
    if (frame.missing.length === 0) continue;
    const corner = `${frame.corner.row},${frame.corner.col}`;
    // Ground already settled is counted by the territory term; what this adds
    // is credit for a wall that is nearly built. One cat from closing is worth
    // most of the prize, five cats from closing is worth very little.
    const value = frame.enclosed.length / (frame.missing.length + 1);
    bestPerCorner.set(corner, Math.max(bestPerCorner.get(corner) ?? 0, value));
  }

  let total = 0;
  for (const value of bestPerCorner.values()) total += value;
  return total;
}

export interface FrameworkVerdict {
  frame: Framework;
  /** Cells enclosed if it completes. */
  size: number;
  /** Cats still needed to close it. */
  movesToClose: number;
  /**
   * Distinct ways to finish. More than one means the opponent taking a closing
   * point does not stop it — "상대가 막으러 와도 완성할 수 있다".
   */
  closingOptions: number;
  /** Invasion points where a cat of theirs would live. Any at all and the
   * region is not really mine. */
  livingInvasions: Coord[];
  /** Both of the player's tests passed. */
  secure: boolean;
}

/** Budget per invasion read. Deliberately small: this runs over several frames
 * and the reader is only confirming a local kill, not solving the board. */
const INVASION_READ_MS = 25;
const INVASION_READ_DEPTH = 5;
/** Checking every cell of a large region costs more than it is worth; the
 * roomiest points are the ones an invader would actually choose. */
const MAX_INVASION_CHECKS = 6;

/**
 * Applies the player's own test to a frame: can every invasion be killed, and
 * is there more than one way to close?
 */
export function judgeFramework(
  state: GameState,
  player: Player,
  frame: Framework,
  budgetMs = 200,
): FrameworkVerdict {
  const deadline = Date.now() + budgetMs;
  const foe = opponent(player);

  // Points inside the region where an invading cat would have room to breathe.
  const roomy = frame.enclosed
    .filter(({ row, col }) => isLegalMove(state, row, col, foe))
    .map((cell) => {
      let open = 0;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const r = cell.row + dr;
        const c = cell.col + dc;
        if (inBounds(r, c) && state.board[r][c] === "EMPTY") open += 1;
      }
      return { cell, open };
    })
    .sort((a, b) => b.open - a.open)
    .slice(0, MAX_INVASION_CHECKS);

  const livingInvasions: Coord[] = [];
  for (const { cell } of roomy) {
    if (Date.now() >= deadline) break;
    let invaded = applyAction({ ...state, currentPlayer: foe }, { type: "PLACE", ...cell });
    if (invaded.winner === foe) {
      livingInvasions.push(cell);
      continue;
    }

    // Answer the invasion the way the frame is meant to be played: shut the
    // gap. A cat that walked in while the wall was still open is a very
    // different animal once the wall is closed behind it — that is the whole
    // point of holding a frame you can complete at will, rather than spending
    // cats closing it early. Reading the invasion without this reply says no
    // frame is ever safe until it is already territory, which is true but
    // useless: it is just the definition of territory again.
    if (frame.missing.length === 1) {
      const gap = frame.missing[0];
      if (isLegalMove(invaded, gap.row, gap.col, player)) {
        invaded = applyAction({ ...invaded, currentPlayer: player }, { type: "PLACE", ...gap });
        if (invaded.winner === player) continue; // closing captured it outright
        if (invaded.winner) {
          livingInvasions.push(cell);
          continue;
        }
      }
    }
    // Can I hunt *this cat* down by force? The reader looks for a forced
    // capture of any group and returns which one, and it tries the most
    // vulnerable first — so a kill it finds elsewhere on the board says nothing
    // about the invasion. Taking any kill as proof made every frame in a test
    // position look secure, including ones six moves from being closed, because
    // the opponent happened to have a weak cat in a far corner.
    const kill = findForcedCapture(
      { ...invaded, currentPlayer: player },
      player,
      INVASION_READ_DEPTH,
      INVASION_READ_MS,
    );
    const killedTheInvader = kill !== null && kill.target.row === cell.row && kill.target.col === cell.col;
    if (!killedTheInvader) livingInvasions.push(cell);
  }

  // How many single moves would settle ground here — more than one means an
  // opponent blocking one of them does not take the region away.
  const before = state.territories[player].length;
  let closingOptions = 0;
  for (const cell of frame.missing) {
    if (!isLegalMove(state, cell.row, cell.col, player)) continue;
    const board: Board = state.board.map((r) => [...r]);
    board[cell.row][cell.col] = playerCell(player);
    if (calculateTerritories(board)[player].length > before) closingOptions += 1;
  }

  const movesToClose = frame.missing.length;
  const secure =
    frame.intruders.length === 0 &&
    livingInvasions.length === 0 &&
    (movesToClose === 0 || closingOptions >= 2 || movesToClose === 1);

  return {
    frame,
    size: frame.enclosed.length,
    movesToClose,
    closingOptions,
    livingInvasions,
    secure,
  };
}

/**
 * The player's frameworks, best first.
 *
 * Ranked by what the ground is worth against what finishing it costs, since
 * over-investing in one corner is how a player ends up behind everywhere else.
 * Frames that fail the security test are kept but sorted below the secure ones
 * — knowing a claim is hollow is as useful as knowing one is sound.
 */
export function rankFrameworks(state: GameState, player: Player, budgetMs = 400): FrameworkVerdict[] {
  const deadline = Date.now() + budgetMs;
  const verdicts: FrameworkVerdict[] = [];

  for (const frame of candidateFrameworks(state.board, player)) {
    if (Date.now() >= deadline) break;
    if (frame.intruders.length > 0) continue; // already broken into
    verdicts.push(judgeFramework(state, player, frame, INVASION_READ_MS * MAX_INVASION_CHECKS));
  }

  return verdicts.sort((a, b) => {
    if (a.secure !== b.secure) return a.secure ? -1 : 1;
    return b.size / (b.movesToClose + 1) - a.size / (a.movesToClose + 1);
  });
}
