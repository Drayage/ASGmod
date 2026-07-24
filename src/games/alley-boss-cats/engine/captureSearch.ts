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
}

/** The group currently containing the anchor stone, or null once captured. */
function currentTarget(board: Board, ctx: ReadContext): Coord[] | null {
  if (!groupStillThere(board, ctx.anchor, ctx.defender)) return null;
  return getConnectedGroup(board, ctx.anchor.row, ctx.anchor.col);
}

/** Attacker to move: can they force a win within `depth` plies? */
function attackerCanForce(state: GameState, depth: number, ctx: ReadContext): boolean {
  if (depth <= 0 || Date.now() >= ctx.deadline) return false;

  // Once the target has room to run, stop calling it a forced capture.
  const target = currentTarget(state.board, ctx);
  if (!target) return false;
  const targetLiberties = getGroupLiberties(state.board, target);
  if (targetLiberties.size > MAX_TRACKED_LIBERTIES) return false;
  // Escaped into permanent life: a liberty inside the defender's own
  // territory can never be filled by anyone.
  if (hasTerritoryLiberty(state, ctx.defender, targetLiberties)) return false;

  for (const move of movesWithin(state, ctx.attacker, focusAround(state.board, target))) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner === ctx.attacker) return true;
    if (next.winner) continue; // somehow lost — not a forcing line
    if (!defenderCanEscape(next, depth - 1, ctx)) return true;
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
    const ctx: ReadContext = { attacker, defender, anchor: group[0], deadline };

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
