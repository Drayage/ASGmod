/**
 * Corner-opening policy layer for the arena experiments.
 *
 * This never touches the shipped engine (ai.ts / minimax.ts / territoryPlanner.ts
 * etc. are all imported unmodified). Every policy is a thin wrapper around
 * findBestMoveVeryHard: it runs the exact same search, with the exact same
 * budget, and only ever *overrides the returned move* for a bounded opening
 * window, before any local fight has started at the corner in question. After
 * that window (or once combat starts there), every policy falls back to
 * calling findBestMoveVeryHard exactly as BASELINE does, for the rest of the
 * game.
 *
 * "corner", "1,1" and "2,2" below are always expressed in a corner-local
 * frame and translated to real board coordinates via `CORNERS`, so the same
 * logic applies to all four corners regardless of rotation/reflection.
 */
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import type { AIAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { isLegalMove } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

export type PolicyName =
  | "BASELINE"
  | "CORNER_11"
  | "CORNER_22"
  | "RESPOND_22_WITH_11"
  | "RESPOND_22_WITH_EDGE"
  | "RESPOND_11_WITH_EDGE";

export type PolicyMode = "FORCE" | "BOOST";

export const POLICY_NAMES: readonly PolicyName[] = [
  "BASELINE",
  "CORNER_11",
  "CORNER_22",
  "RESPOND_22_WITH_11",
  "RESPOND_22_WITH_EDGE",
  "RESPOND_11_WITH_EDGE",
];

/** How many plies (both sides combined) the opening-corner policies are
 * allowed to act in, regardless of whether combat has started. Configurable
 * so the arena runner can sweep it if needed. */
export const DEFAULT_POLICY_WINDOW_PLIES = 24;

/** BOOST mode plays the policy's target move over the engine's own pick
 * whenever the target's static eval is within this many points of it. Wide
 * enough to let through anything that isn't a clear engine-judged blunder;
 * evaluateState's terms run in the tens-to-hundreds (100 pts/confirmed cell,
 * 90 for a losing atari), so this sits below "the engine thinks this loses
 * something concrete" but above ordinary positional noise. */
export const DEFAULT_BOOST_TOLERANCE = 40;

interface CornerFrame {
  name: string;
  /** (row,col) of the actual corner cell. */
  corner: Coord;
  sr: 1 | -1;
  sc: 1 | -1;
}

/** The four corners, described the same way frameworks.ts does: an origin
 * plus the row/col direction that walks inward from it. */
export const CORNERS: readonly CornerFrame[] = [
  { name: "TL", corner: { row: 0, col: 0 }, sr: 1, sc: 1 },
  { name: "TR", corner: { row: 0, col: BOARD_SIZE - 1 }, sr: 1, sc: -1 },
  { name: "BL", corner: { row: BOARD_SIZE - 1, col: 0 }, sr: -1, sc: 1 },
  { name: "BR", corner: { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1 }, sr: -1, sc: -1 },
];

/** Corner-local (i,j) -> real board coordinate, for a given corner frame. */
function point(frame: CornerFrame, i: number, j: number): Coord {
  return { row: frame.corner.row + frame.sr * i, col: frame.corner.col + frame.sc * j };
}

export interface CornerPoints {
  frame: CornerFrame;
  corner: Coord;
  p11: Coord;
  p22: Coord;
  /** The "row arm" -- (1,0) in TL-local coordinates. */
  armR: Coord;
  /** The "col arm" -- (0,1) in TL-local coordinates. */
  armC: Coord;
}

export function cornerPoints(frame: CornerFrame): CornerPoints {
  return {
    frame,
    corner: point(frame, 0, 0),
    p11: point(frame, 1, 1),
    p22: point(frame, 2, 2),
    armR: point(frame, 1, 0),
    armC: point(frame, 0, 1),
  };
}

function coordKey(c: Coord): string {
  return `${c.row},${c.col}`;
}

/** All cells in the corner's local 4x4 wedge (0<=i,j<=3, 16 cells) -- the
 * region CORNER_11/CORNER_22/RESPOND_* actually reason about. Deliberately a
 * bit larger than the p22 diagonal itself so "combat nearby" is caught even
 * when it hasn't touched the exact wall cells yet. */
function localZone(frame: CornerFrame): Coord[] {
  const cells: Coord[] = [];
  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 3; j++) {
      cells.push(point(frame, i, j));
    }
  }
  return cells;
}

/**
 * Heuristic: has a local fight already started in this corner's zone?
 *
 * True if either side already has a group there down to <=2 liberties (a
 * live tactical squeeze), or if five or more stones (either color, combined)
 * already sit in the zone (no longer just an opening probe). Both thresholds
 * are judgement calls, not something the rules define -- documented here so
 * they're easy to revisit rather than silently baked into the numbers.
 */
export function localCombatStarted(state: GameState, frame: CornerFrame): boolean {
  const zone = localZone(frame);
  let stoneCount = 0;
  for (const cell of zone) {
    const cellValue = state.board[cell.row][cell.col];
    if (cellValue === "PLAYER_A" || cellValue === "PLAYER_B") stoneCount += 1;
  }
  if (stoneCount >= 5) return true;

  return zoneHasLowLibertyGroup(state, frame);
}

function zoneHasLowLibertyGroup(state: GameState, frame: CornerFrame): boolean {
  const zone = new Set(localZone(frame).map(coordKey));
  const visited = new Set<string>();

  for (const cell of localZone(frame)) {
    const cellValue = state.board[cell.row][cell.col];
    if (cellValue !== "PLAYER_A" && cellValue !== "PLAYER_B") continue;
    const key = coordKey(cell);
    if (visited.has(key)) continue;

    // BFS the connected group (can extend outside the zone -- a group that
    // pokes out is still the same group), counting liberties as we go.
    const stack: Coord[] = [cell];
    const groupSeen = new Set<string>([key]);
    const liberties = new Set<string>();
    let touchesZone = false;

    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (zone.has(coordKey(cur))) touchesZone = true;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const r = cur.row + dr;
        const c = cur.col + dc;
        if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
        const neighborValue = state.board[r][c];
        const nKey = `${r},${c}`;
        if (neighborValue === "EMPTY") {
          liberties.add(nKey);
        } else if (neighborValue === cellValue && !groupSeen.has(nKey)) {
          groupSeen.add(nKey);
          stack.push({ row: r, col: c });
        }
      }
    }

    for (const g of groupSeen) visited.add(g);
    if (touchesZone && liberties.size <= 2) return true;
  }

  return false;
}

/** Has the given player already placed a stone at `cell`? Used to check
 * whether a corner's key points are still untouched. */
function occupied(state: GameState, cell: Coord): boolean {
  return state.board[cell.row][cell.col] !== "EMPTY" && state.board[cell.row][cell.col] !== "NEUTRAL";
}

/** A corner counts as "still open" for the CORNER_11/CORNER_22 opening
 * policies only if none of its five key points have been touched by either
 * side yet -- otherwise "prefer the corner" has nothing clean left to do. */
function cornerIsUntouched(state: GameState, points: CornerPoints): boolean {
  return [points.corner, points.p11, points.p22, points.armR, points.armC].every(
    (c) => !occupied(state, c),
  );
}

export interface PolicyFireLog {
  ply: number;
  player: Player;
  policy: PolicyName;
  mode: PolicyMode;
  corner: string;
  move: AIAction;
  /** What findBestMoveVeryHard would have played on its own, for comparison. */
  searchMove: AIAction;
  /** True only when the policy's move actually differs from the search's own pick. */
  deviated: boolean;
}

/** Mutable per-game bookkeeping the policy wrapper needs across calls:
 * which corners have already been "claimed" or "responded to", so a policy
 * doesn't refire on the same corner every remaining ply of the opening
 * window. */
export class PolicyState {
  claimedCorners = new Set<string>();
  respondedCorners = new Set<string>();
  fireLog: PolicyFireLog[] = [];
  /** Corner name the policy actually acted on, first time it fires -- the
   * one the arena runner measures territory/moves-spent against. */
  primaryCorner: string | null = null;
}

/** True when getSafeActions leaves this player only a handful of real
 * options right now. Used by the arena runner to measure how many plies
 * after a policy fires the follow-through was actually forced by tactics
 * rather than merely chosen. */
export function hasNarrowSafePool(state: GameState, player: Player, maxPoolSize = 3): boolean {
  return getSafeActions(state, player).pool.length <= maxPoolSize;
}

/** Did the opponent's most recent move land exactly on `target`? */
function lastMoveWas(state: GameState, target: Coord): boolean {
  const last = state.moveHistory[state.moveHistory.length - 1];
  if (!last || last.type !== "PLACE") return false;
  return last.row === target.row && last.col === target.col;
}

function toPlace(c: Coord): AIAction {
  return { type: "PLACE", row: c.row, col: c.col };
}

/** Picks whichever of two candidate cells the engine's own evaluation likes
 * better, restricted to legal moves. Returns null if neither is legal. */
export function betterByEval(state: GameState, player: Player, a: Coord, b: Coord): Coord | null {
  const aLegal = isLegalMove(state, a.row, a.col, player);
  const bLegal = isLegalMove(state, b.row, b.col, player);
  if (!aLegal && !bLegal) return null;
  if (aLegal && !bLegal) return a;
  if (!aLegal && bLegal) return b;
  const scoreA = evaluateState(applyAction(state, toPlace(a)), player);
  const scoreB = evaluateState(applyAction(state, toPlace(b)), player);
  return scoreA >= scoreB ? a : b;
}

const withinWindow = (state: GameState, windowPlies: number) => state.moveHistory.length < windowPlies;

/**
 * The policy decision for one ply. Always computes the plain
 * findBestMoveVeryHard answer too (for the deviation/fire-count metrics),
 * so BASELINE and every policy pay the exact same search cost; the override,
 * when one applies, is on top of that, not instead of it.
 */
export function decideWithPolicy(
  state: GameState,
  player: Player,
  policy: PolicyName,
  mode: PolicyMode,
  policyState: PolicyState,
  budgetMs: number,
  windowPlies: number = DEFAULT_POLICY_WINDOW_PLIES,
  boostTolerance: number = DEFAULT_BOOST_TOLERANCE,
): AIAction {
  const searchMove = findBestMoveVeryHard(state, player, budgetMs);
  if (policy === "BASELINE") return searchMove;
  if (!withinWindow(state, windowPlies)) return searchMove;

  const target = findPolicyTarget(state, player, policy, policyState);
  if (!target) return searchMove;

  const { corner, move } = target;
  const legal = move.type === "PLACE" && isLegalMove(state, move.row, move.col, player);
  if (!legal) return searchMove;

  let finalMove = searchMove;
  if (mode === "FORCE") {
    finalMove = move;
  } else {
    const targetScore = evaluateState(applyAction(state, move), player);
    const searchScore = evaluateState(applyAction(state, searchMove), player);
    finalMove = targetScore >= searchScore - boostTolerance ? move : searchMove;
  }

  const deviated = finalMove.type !== searchMove.type || (finalMove.type === "PLACE" && searchMove.type === "PLACE" &&
    (finalMove.row !== searchMove.row || finalMove.col !== searchMove.col));

  if (finalMove === move) {
    // The policy's move actually got played -- mark bookkeeping so this
    // corner doesn't refire, and record it as this game's primary corner if
    // it's the first policy action so far.
    if (policy === "CORNER_11" || policy === "CORNER_22") policyState.claimedCorners.add(corner);
    else policyState.respondedCorners.add(corner);
    if (policyState.primaryCorner === null) policyState.primaryCorner = corner;
  }

  policyState.fireLog.push({
    ply: state.moveHistory.length,
    player,
    policy,
    mode,
    corner,
    move: finalMove,
    searchMove,
    deviated,
  });

  return finalMove;
}

function findPolicyTarget(
  state: GameState,
  player: Player,
  policy: PolicyName,
  policyState: PolicyState,
): { corner: string; move: AIAction } | null {
  if (policy === "CORNER_11" || policy === "CORNER_22") {
    // Prefer the untouched corner whose target point scores best right now,
    // among corners not already claimed this game.
    let best: { corner: string; move: AIAction; score: number } | null = null;
    for (const frame of CORNERS) {
      if (policyState.claimedCorners.has(frame.name)) continue;
      const pts = cornerPoints(frame);
      if (!cornerIsUntouched(state, pts)) continue;
      const targetCell = policy === "CORNER_11" ? pts.p11 : pts.p22;
      if (!isLegalMove(state, targetCell.row, targetCell.col, player)) continue;
      const score = evaluateState(applyAction(state, toPlace(targetCell)), player);
      if (!best || score > best.score) best = { corner: frame.name, move: toPlace(targetCell), score };
    }
    return best;
  }

  // RESPOND_* policies: trigger off the opponent's last move landing on a
  // corner's 2,2 or 1,1 point.
  const wantsP22 = policy === "RESPOND_22_WITH_11" || policy === "RESPOND_22_WITH_EDGE";
  for (const frame of CORNERS) {
    if (policyState.respondedCorners.has(frame.name)) continue;
    const pts = cornerPoints(frame);
    const trigger = wantsP22 ? pts.p22 : pts.p11;
    if (!lastMoveWas(state, trigger)) continue;
    // The move that triggered this must have been the opponent's, not ours.
    const lastMove = state.moveHistory[state.moveHistory.length - 1];
    if (lastMove.type !== "PLACE" || lastMove.player === player) continue;

    if (policy === "RESPOND_22_WITH_11") {
      return { corner: frame.name, move: toPlace(pts.p11) };
    }
    const pick = betterByEval(state, player, pts.armR, pts.armC);
    if (!pick) continue;
    return { corner: frame.name, move: toPlace(pick) };
  }
  return null;
}

/** Cells in a corner's local zone actually occupied by `player`, and the
 * territory that corner's zone ended up as at game end, for that player. */
export function cornerStats(state: GameState, cornerName: string, player: Player) {
  const frame = CORNERS.find((f) => f.name === cornerName)!;
  const zone = new Set(localZone(frame).map(coordKey));

  let stonesPlaced = 0;
  for (const move of state.moveHistory) {
    if (move.type !== "PLACE" || move.player !== player) continue;
    if (zone.has(`${move.row},${move.col}`)) stonesPlaced += 1;
  }

  const territoryCells = state.territories[player].filter((c) => zone.has(coordKey(c)));
  return { stonesPlaced, territoryCells: territoryCells.length };
}
