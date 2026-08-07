import type { AIAction } from "../ai";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "../groups";
import { applyMove, isLegalMove } from "../rules";
import { coordKeySet } from "../territory";
import { DIRECTIONS, inBounds, opponent } from "../types";
import type { Board, Coord, GameState, Player } from "../types";

/**
 * A focused life-and-death reader.
 *
 * Destroying a single castle wins the game outright, so most decisive play is
 * a local capture race rather than anything the whole-board search is good at
 * seeing. Rather than deepening a wide search, this reads a *narrow* region —
 * the liberties of one endangered group and the cells around them — far enough
 * ahead to prove whether the group can be taken by force.
 *
 * The search is an AND/OR read: the attacker needs one move that works, the
 * defender needs every reply to fail.
 */

const MAX_TRACKED_LIBERTIES = 3;

/**
 * How many times one read may switch which group it is hunting.
 *
 * A module-level setting rather than a field on `tuning`, because
 * `ai.ts -> frameworks.ts -> captureSearch.ts` is already a chain and reaching
 * back for `tuning` closes it into a cycle. The engine's other switchable
 * behaviours are set the same way for the same reason.
 */
let captureRetargets = 0;

export function setCaptureRetargets(value: number): void {
  captureRetargets = value;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function parseKey(k: string): Coord {
  const [row, col] = k.split(",").map(Number);
  return { row, col };
}

/** The liberties of `group` plus the empty cells touching them — everything
 * that can plausibly matter to this group's life within a few moves. */
function focusAround(board: Board, group: Coord[]): Set<string> {
  const focus = new Set<string>();
  for (const lib of getGroupLiberties(board, group)) {
    focus.add(lib);
    const { row, col } = parseKey(lib);
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (inBounds(r, c) && board[r][c] === "EMPTY") focus.add(key(r, c));
    }
  }
  return focus;
}

/** Cells where `player` would capture something immediately — a defender can
 * always try these, even outside the focus region, because capturing ends the
 * game in their favour. */
function immediateWinCells(state: GameState, player: Player): string[] {
  const cells: string[] = [];
  for (const group of getAllGroups(state.board, opponent(player))) {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size === 1) cells.push(...liberties);
  }
  return cells;
}

function movesWithin(state: GameState, player: Player, cells: Iterable<string>): Coord[] {
  const moves: Coord[] = [];
  const seen = new Set<string>();
  for (const k of cells) {
    if (seen.has(k)) continue;
    seen.add(k);
    const { row, col } = parseKey(k);
    if (isLegalMove(state, row, col, player)) moves.push({ row, col });
  }
  return moves;
}

/** Is `group` (identified by one of its stones) still on the board? */
function groupStillThere(board: Board, anchor: Coord, player: Player): boolean {
  const cell = board[anchor.row][anchor.col];
  return cell === (player === "A" ? "PLAYER_A" : "PLAYER_B");
}

/** A liberty inside `owner`'s confirmed territory can never be filled by
 * either side, so a group holding one is permanently alive. */
function hasTerritoryLiberty(state: GameState, owner: Player, liberties: Set<string>): boolean {
  if (state.territories[owner].length === 0) return false;
  const keys = coordKeySet(state.territories[owner]);
  for (const liberty of liberties) {
    if (keys.has(liberty)) return true;
  }
  return false;
}

interface ReadContext {
  attacker: Player;
  defender: Player;
  /** Stone identifying the group under attack. */
  anchor: Coord;
  deadline: number;
  /**
   * How many times this line may still switch which group it is hunting.
   *
   * The read follows one group, which is what keeps it cheap enough to run at
   * every node. The cost of that was measured against the publisher's own
   * life-and-death problems: it solves one of four, and the three it misses
   * are all the same shape. Blue threatens two groups, the defender saves one
   * by abandoning the other, and the tracked group climbing past
   * MAX_TRACKED_LIBERTIES reads as an escape — while the same position asked
   * fresh finds the kill on the group that was given up.
   *
   * Each retarget is a whole new read, so this is a budget rather than a
   * flag. Zero reproduces the old behaviour exactly.
   */
  retargets: number;
}

/** The group currently containing the anchor stone, or null once captured. */
function currentTarget(board: Board, ctx: ReadContext): Coord[] | null {
  if (!groupStillThere(board, ctx.anchor, ctx.defender)) return null;
  return getConnectedGroup(board, ctx.anchor.row, ctx.anchor.col);
}


/**
 * A ladder is a walk, not a search.
 *
 * Chasing a two-liberty group to the edge takes eleven plies in one of the
 * publisher's problems while the reader is allowed seven, so the tree can
 * never see it. It does not need to: every move in a ladder is atari, so the
 * defender has exactly one reply, and following that costs the length of the
 * chase rather than an exponential in depth.
 *
 * The one thing that must not be got wrong is the ladder breaker. If the
 * defender can answer by putting one of the chasing stones in atari, the chase
 * is not forced — and the right conclusion is simply that this is not a
 * ladder, so the walk gives up. An earlier version assumed the defender always
 * had to extend and reported blue B9 in problem 3 as a forced capture that
 * 2 of 71 replies survive. Missing a kill costs a chance; inventing one plays
 * a losing move believing it decisive, in a game a single capture ends.
 */
const LADDER_MAX_STEPS = 40;

/**
 * Can the defender break this chase?
 *
 * Not by counter-atari. A defender in a ladder is in atari at every step and
 * has no move to spare — answer or be taken — so threatening the chasing
 * stones buys them nothing. Refusing a chase whenever some nearby attacker
 * group is thin gives up ladders that plainly work, including the one in
 * problem 4, where the stone doing the chasing is itself on two liberties.
 *
 * What does break it is a capture available *now*, which ends the game the
 * defender's way before the chase can finish. The other classical breaker, a
 * friendly stone waiting at the end of the run, needs no test of its own: if
 * the running group connects to one its liberties jump, and the walk already
 * stops the moment an extension leaves more than one.
 */
function defenderCanCaptureNow(state: GameState, ctx: ReadContext): boolean {
  return movesWithin(state, ctx.defender, immediateWinCells(state, ctx.defender)).length > 0;
}

/**
 * The other way out of an atari: seal the last breath into an eye.
 *
 * A point surrounded entirely by one colour becomes that player's confirmed
 * territory, and nobody may ever play there — so a group breathing through one
 * is alive for good, however long the chase would otherwise have run. In
 * problem 3 the defender answers blue B9 with E9 rather than extending, which
 * closes D9 into an eye and saves the group outright.
 *
 * `liberty` is the running group's last breath. It can be sealed if no
 * attacker stone touches it — an attacker stone can never be inside the
 * defender's territory — and at most one of its neighbours is still open for
 * the defender to fill. Problem 4's chase survives this test because the
 * liberty it drives towards is touched by a blue stone throughout.
 */
function libertyCanBecomeEye(
  state: GameState,
  ctx: ReadContext,
  liberty: Coord,
  running: Coord[],
): boolean {
  const inGroup = new Set(running.map((stone) => key(stone.row, stone.col)));
  const attackerCell = ctx.attacker === "A" ? "PLAYER_A" : "PLAYER_B";
  let openNeighbours = 0;

  for (const [dr, dc] of DIRECTIONS) {
    const r = liberty.row + dr;
    const c = liberty.col + dc;
    if (!inBounds(r, c)) continue; // the edge walls it in for free
    if (state.board[r][c] === attackerCell) return false;
    if (state.board[r][c] === "EMPTY" && !inGroup.has(key(r, c))) openNeighbours += 1;
  }
  return openNeighbours <= 1;
}

/**
 * One rung: attacker to move against a group down to one or two liberties.
 * Returns true only when the simulation actually ends in a capture.
 */
function ladderStep(state: GameState, ctx: ReadContext, anchor: Coord, steps: number): boolean {
  if (steps <= 0 || Date.now() >= ctx.deadline) return false;
  if (!groupStillThere(state.board, anchor, ctx.defender)) return false;

  const group = getConnectedGroup(state.board, anchor.row, anchor.col);
  const liberties = [...getGroupLiberties(state.board, group)];
  if (liberties.length === 0 || liberties.length > 2) return false;

  for (const key of liberties) {
    const { row, col } = parseKey(key);
    if (!isLegalMove(state, row, col, ctx.attacker)) continue;
    const chased = applyMove(state, row, col);
    if (chased.winner === ctx.attacker) return true;
    if (chased.winner) continue;

    // Ladder breaker: the defender can turn on the chasing stones instead of
    // running. Then the chase was never forced.
    if (defenderCanCaptureNow(chased, ctx)) continue;

    const running = getConnectedGroup(chased.board, anchor.row, anchor.col);
    const left = [...getGroupLiberties(chased.board, running)];
    if (left.length !== 1) continue; // not atari: this liberty was the wrong one

    const { row: dr, col: dc } = parseKey(left[0]);
    if (libertyCanBecomeEye(chased, ctx, { row: dr, col: dc }, running)) continue;
    if (!isLegalMove(chased, dr, dc, ctx.defender)) continue;
    const extended = applyMove(chased, dr, dc);
    if (extended.winner === ctx.attacker) return true;
    if (extended.winner) continue;

    if (ladderStep(extended, ctx, anchor, steps - 1)) return true;
  }
  return false;
}

/** The first move of a ladder that captures `group`, or null. */
function ladderCapture(state: GameState, ctx: ReadContext, group: Coord[]): Coord | null {
  if (getGroupLiberties(state.board, group).size !== 2) return null;
  const anchor = group[0];
  for (const key of getGroupLiberties(state.board, group)) {
    const { row, col } = parseKey(key);
    if (!isLegalMove(state, row, col, ctx.attacker)) continue;
    const probe = applyMove(state, row, col);
    if (probe.winner === ctx.attacker) return { row, col };
    if (probe.winner) continue;
    if (defenderCanCaptureNow(probe, ctx)) continue;
    const running = getConnectedGroup(probe.board, anchor.row, anchor.col);
    const left = [...getGroupLiberties(probe.board, running)];
    if (left.length !== 1) continue;
    const { row: dr, col: dc } = parseKey(left[0]);
    if (libertyCanBecomeEye(probe, ctx, { row: dr, col: dc }, running)) continue;
    if (!isLegalMove(probe, dr, dc, ctx.defender)) continue;
    const extended = applyMove(probe, dr, dc);
    if (extended.winner === ctx.attacker) return { row, col };
    if (extended.winner) continue;
    if (ladderStep(extended, ctx, anchor, LADDER_MAX_STEPS)) return { row, col };
  }
  return null;
}

/** Attacker to move: can they force a win within `depth` plies? */
function attackerCanForce(state: GameState, depth: number, ctx: ReadContext): boolean {
  if (depth <= 0 || Date.now() >= ctx.deadline) return false;

  // Once the target has room to run, stop calling it a forced capture.
  const target = currentTarget(state.board, ctx);
  if (!target) return false;
  const targetLiberties = getGroupLiberties(state.board, target);
  // The hunted group has room to run. Before giving up on the line, see
  // whether the defender bought that room by abandoning something else.
  if (targetLiberties.size > MAX_TRACKED_LIBERTIES) return retarget(state, depth, ctx, target);
  // Escaped into permanent life: a liberty inside the defender's own
  // territory can never be filled by anyone. An eye is a stronger escape than
  // extra liberties, not a weaker one, so this retargets for the same reason.
  if (hasTerritoryLiberty(state, ctx.defender, targetLiberties)) {
    return retarget(state, depth, ctx, target);
  }
  // Out of road. Filling L liberties takes L attacker moves, so 2L-1 plies at
  // best, and below that this group cannot be taken however the read goes.
  // Switching here is what catches a defender who answered and simply lives
  // without ever crossing the liberty cap — arithmetic rather than a guess,
  // which is what keeps it from exploding the way retargeting on every
  // failure did.
  if (targetLiberties.size * 2 - 1 > depth) return retarget(state, depth, ctx, target);
  // Depth-independent, so a chase that outruns the tree's horizon still counts.
  if (targetLiberties.size === 2 && ladderCapture(state, ctx, target)) return true;

  for (const move of movesWithin(state, ctx.attacker, focusAround(state.board, target))) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner === ctx.attacker) return true;
    if (next.winner) continue; // somehow lost — not a forcing line
    if (!defenderCanEscape(next, depth - 1, ctx)) return true;
  }

  // Deliberately no retarget here, though this is where "let that one live
  // and take the other" would have to come from — it is why problem 4 stays
  // unsolved. Retargeting on every failed node rather than only on an escape
  // was tried and is not viable: it never returned on that problem even at a
  // 200ms budget, because each failure spawns a fresh read against every
  // other group at the same depth and the deadline checks cannot unwind a
  // tree growing that fast. Making it work needs a real bound, not a knob.
  return false;
}

/**
 * The hunted group got away. Is some *other* defender group now catchable?
 *
 * Only groups the read would have accepted at the root are considered, and
 * never the one just abandoned. Each attempt spends a retarget, so a line can
 * only change its mind a bounded number of times however the fight develops.
 */
function retarget(state: GameState, depth: number, ctx: ReadContext, escaped: Coord[]): boolean {
  if (ctx.retargets <= 0 || depth <= 0 || Date.now() >= ctx.deadline) return false;

  const escapedKeys = coordKeySet(escaped);
  const candidates = getAllGroups(state.board, ctx.defender)
    .filter((group) => !escapedKeys.has(`${group[0].row},${group[0].col}`))
    .map((group) => ({ group, liberties: getGroupLiberties(state.board, group) }))
    .filter(({ liberties }) => liberties.size <= MAX_TRACKED_LIBERTIES)
    .filter(({ liberties }) => !hasTerritoryLiberty(state, ctx.defender, liberties))
    .sort((a, b) => a.liberties.size - b.liberties.size);

  for (const { group } of candidates) {
    if (Date.now() >= ctx.deadline) return false;
    const next: ReadContext = { ...ctx, anchor: group[0], retargets: ctx.retargets - 1 };
    if (attackerCanForce(state, depth, next)) return true;
  }
  return false;
}

/** Defender to move: can they survive `depth` plies? Conservative — an
 * unproven position counts as an escape, so this never invents a capture. */
function defenderCanEscape(state: GameState, depth: number, ctx: ReadContext): boolean {
  if (depth <= 0 || Date.now() >= ctx.deadline) return true;
  const target = currentTarget(state.board, ctx);
  if (!target) return true; // already gone

  const candidates = [
    ...focusAround(state.board, target),
    ...immediateWinCells(state, ctx.defender),
  ];
  const moves = movesWithin(state, ctx.defender, candidates);
  // No playable move anywhere in the fight. The focus is rebuilt from the
  // group's *current* liberties, so a group with room to breathe always has
  // one here — reaching this line means the group really is trapped.
  if (moves.length === 0) return false;

  for (const move of moves) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner === ctx.defender) return true; // counter-capture saves it
    if (next.winner === ctx.attacker) continue;
    if (!attackerCanForce(next, depth - 1, ctx)) return true;
  }
  return false;
}

export interface ForcedCapture {
  move: AIAction;
  target: Coord;
}

/**
 * Looks for a move that starts a forced capture of some opponent group.
 * `state.currentPlayer` must be `attacker`.
 */
export function findForcedCapture(
  state: GameState,
  attacker: Player,
  depth: number,
  timeBudgetMs: number,
): ForcedCapture | null {
  const defender = opponent(attacker);
  const deadline = Date.now() + timeBudgetMs;

  const targets = getAllGroups(state.board, defender)
    .map((group) => ({ group, liberties: getGroupLiberties(state.board, group) }))
    .filter(({ liberties }) => liberties.size <= MAX_TRACKED_LIBERTIES)
    // A group breathing through its own territory is permanently alive —
    // don't spend any of the read budget proving the impossible.
    .filter(({ liberties }) => !hasTerritoryLiberty(state, defender, liberties))
    .sort((a, b) => a.liberties.size - b.liberties.size);

  for (const { group } of targets) {
    if (Date.now() >= deadline) break;
    const ctx: ReadContext = {
      attacker,
      defender,
      anchor: group[0],
      deadline,
      retargets: captureRetargets,
    };

    const ladder = ladderCapture(state, ctx, group);
    if (ladder) return { move: { type: "PLACE", ...ladder }, target: group[0] };

    for (const move of movesWithin(state, attacker, focusAround(state.board, group))) {
      const next = applyMove(state, move.row, move.col);
      if (next.winner === attacker) {
        return { move: { type: "PLACE", ...move }, target: group[0] };
      }
      if (next.winner) continue;
      if (!defenderCanEscape(next, depth - 1, ctx)) {
        return { move: { type: "PLACE", ...move }, target: group[0] };
      }
    }
  }

  return null;
}

/**
 * True when the opponent, moving next, could force the capture of one of
 * `player`'s groups. Used to throw out moves that lose by force.
 */
export function opponentCanForceCapture(
  state: GameState,
  player: Player,
  depth: number,
  timeBudgetMs: number,
): boolean {
  if (state.winner) return state.winner !== player;
  const foe = opponent(player);
  if (state.currentPlayer !== foe) return false;
  return findForcedCapture(state, foe, depth, timeBudgetMs) !== null;
}
