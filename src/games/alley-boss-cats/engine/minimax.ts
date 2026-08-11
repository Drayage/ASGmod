import { applyAction, evaluateState, getSafeActions, tuning } from "../ai";
import type { AIAction } from "../ai";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "../groups";
import { applyMove, isLegalMove } from "../rules";
import { DIRECTIONS, inBounds, opponent, playerCell } from "../types";
import type { Board, Coord, GameState, Player } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";
import { rankFrameworks } from "./frameworks";
import { localMoveScore, orderedCandidates } from "./moveOrdering";
import { primeRootOwnership } from "./ownershipTerm";
import { findSealingMoves, planTerritory, sealingUrgency } from "./territoryPlanner";
import type { TerritoryPlan } from "./territoryPlanner";
import { Bound, TranspositionTable } from "./transpositionTable";

/**
 * Deepest ply the last search completed.
 *
 * Recorded because "the engine used its whole budget" does not distinguish a
 * search that thought hard from one that barely got started — iterative
 * deepening always spends the budget by design, so elapsed time alone says
 * nothing. Depth does. A module variable rather than a return value because
 * every caller wants the move and only the worker wants this; the search is
 * synchronous and single-threaded, so reading it straight afterwards is sound.
 */
export let lastSearchDepth = 0;
/**
 * What the last completed iteration scored its chosen move at.
 *
 * Diagnostic only, written where lastSearchDepth already is. Exists because
 * "the evaluation scores this move 190 points below the alternative and the
 * search plays it anyway" is only answerable by asking the search what it
 * thinks it is getting.
 */
export let lastSearchScore = 0;

/** Testing-only escape hatch for avoidSelfInflictedThin below, so the arena
 * can play the guarded and unguarded engine head-to-head. Always on in the
 * shipped app. */
export let selfInflictedThinGuardEnabled = true;
export function setSelfInflictedThinGuardEnabled(enabled: boolean): void {
  selfInflictedThinGuardEnabled = enabled;
}

/** Same, for avoidOneMoveTraps — kept independent of the flag above so the
 * two screens can be A/B tested apart before either one's default is
 * trusted. Always on in the shipped app. */
export let oneMoveTrapGuardEnabled = true;
export function setOneMoveTrapGuardEnabled(enabled: boolean): void {
  oneMoveTrapGuardEnabled = enabled;
}

/** Same, for avoidDominatedPockets. Always on in the shipped app. */
export let dominatedPocketGuardEnabled = true;
export function setDominatedPocketGuardEnabled(enabled: boolean): void {
  dominatedPocketGuardEnabled = enabled;
}

/** Same, for existingGroupDanger's libertyGainingMoves ranking. Always on in
 * the shipped app. */
export let existingGroupDangerRankingEnabled = true;
export function setExistingGroupDangerRankingEnabled(enabled: boolean): void {
  existingGroupDangerRankingEnabled = enabled;
}

/** Same, for pocketSealDanger. Always on in the shipped app. */
export let pocketSealDangerGuardEnabled = true;
export function setPocketSealDangerGuardEnabled(enabled: boolean): void {
  pocketSealDangerGuardEnabled = enabled;
}

/** Same, for pocketSealDanger's denial-candidate filter below. Always on in
 * the shipped app. */
export let pocketSealDenialFilterEnabled = true;
export function setPocketSealDenialFilterEnabled(enabled: boolean): void {
  pocketSealDenialFilterEnabled = enabled;
}

/** Same, for frameworkCompletionMoves. Always on in the shipped app. */
export let frameworkGuardEnabled = true;
export function setFrameworkGuardEnabled(enabled: boolean): void {
  frameworkGuardEnabled = enabled;
}

/** Same, for opponentFrameworkDenialMoves. Always on in the shipped app. */
export let opponentFrameworkGuardEnabled = true;
export function setOpponentFrameworkGuardEnabled(enabled: boolean): void {
  opponentFrameworkGuardEnabled = enabled;
}

/**
 * Same, for thinGroupDanger — stage 1.75. Off, on the arena's evidence.
 *
 * Unlike stage 1.5 beneath it, this guard proves nothing: it fires whenever any
 * of the mover's groups sits at three liberties or fewer with an opponent stone
 * beside it, which measured over 604 recorded AI turns is 23.8% of all moves,
 * second only to the full search itself. Each time it hands the search about
 * three candidates out of a pool of forty-three — and at turn 28 of the first
 * recorded app game it forced F4 from two candidates out of forty-eight, where
 * H9 scored 52 points better after a full-strength reply and the game was lost
 * on territory.
 *
 * Two independent 68-game seeded runs, guard on against the same engine with it
 * off, clustered by source game:
 *
 *   territory margin  -1.96 cells [-2.92, -1.00]   and  -1.82 [-2.48, -1.17]
 *   conversion        16.5% vs 22.3%               and  14.9% vs 20.3%
 *   games             (not recorded)               and  26 : 42
 *   lost to a capture (not recorded)               and  22 : 22
 *
 * The interval excludes zero in both, and influence-to-territory conversion —
 * the one number this engine's territory defect has always shown up in — rises
 * by five points. On wins the sign test over clusters is 4 to 12, p = 0.077:
 * suggestive, not conclusive, and quoted that way.
 *
 * The safety case for keeping it does not survive contact with the data. It
 * exists to stop groups being captured, and removing it changed capture losses
 * from 22 to 22 — exactly none. The likely reason is that it was a crutch for a
 * capture reader that could not prove much; that reader now solves four of four
 * published life-and-death problems where it solved one, so the general search
 * defends these groups better than the heuristic that pre-empts it.
 *
 * Lowering its ceiling to two liberties was tried as a safer middle and is
 * worse than both: same territory gain, wins dead level (p = 1.0), and capture
 * losses up from 17 to 24. Firing only in the critical moments is where its
 * narrowness costs most.
 *
 * Set this back to true to restore the old behaviour exactly; all 164 tests
 * pass either way, so nothing here is pinned by a regression test.
 */
export let thinGroupGuardEnabled = false;
export function setThinGroupGuardEnabled(enabled: boolean): void {
  thinGroupGuardEnabled = enabled;
}

/**
 * Which stage of `findBestMoveVeryHard` decided the last move, and how much of
 * the pool it left the search to choose from.
 *
 * The function is a ladder of guards, and all but the last two hand the search
 * a shortlist and return. That makes "why did it play that?" unanswerable from
 * outside: a move can be forced by a guard the position barely triggered, and
 * it looks identical to a move the full search chose. Recording the stage costs
 * two assignments per move and turns that into a fact.
 */
export interface DecisionTrace {
  stage: string;
  /** Candidates the search was given, against the pool it could have had. */
  candidates: number;
  poolSize: number;
}
export let lastDecision: DecisionTrace = { stage: "none", candidates: 0, poolSize: 0 };
function note(stage: string, candidates: number, poolSize: number): void {
  lastDecision = { stage, candidates, poolSize };
}

/** Whether the transposition table's stored *scores* are used to answer a
 * repeated position outright, or only its move hints are (which is all this
 * table held before). Always on in the shipped app; the toggle exists so
 * ai-arena.mts can measure what the scores are worth. */
export let ttScoresEnabled = true;
export function setTtScoresEnabled(enabled: boolean): void {
  ttScoresEnabled = enabled;
}

const WIN_SCORE = 1_000_000;
const MAX_DEPTH = 8;

const CELL_CODE: Record<Board[number][number], string> = {
  EMPTY: "E",
  PLAYER_A: "A",
  PLAYER_B: "B",
  NEUTRAL: "N",
};

function positionKey(state: GameState): string {
  let cells = "";
  for (const row of state.board) {
    for (const cell of row) cells += CELL_CODE[cell];
  }
  return `${cells}|${state.currentPlayer}|${state.consecutivePasses}`;
}

function actionKey(action: AIAction): string {
  return action.type === "PASS" ? "PASS" : `${action.row},${action.col}`;
}

/** Branch factor narrows as the search deepens so the tree stays inside its
 * time budget while still following the critical line a long way. */
/**
 * Scale on how many moves each inner node considers. 1 is shipped.
 *
 * Settable so the "the defender's escape was never in the list" explanation for
 * the engine's phantom captures can be tested by widening rather than argued.
 */
export let branchLimitScale = 1;
export function setBranchLimitScale(value: number): void {
  branchLimitScale = value;
}

function branchLimit(remainingDepth: number): number {
  const base =
    remainingDepth >= 5 ? 14
    : remainingDepth === 4 ? 12
    : remainingDepth === 3 ? 10
    : remainingDepth === 2 ? 8
    : 6;
  return Math.round(base * branchLimitScale);
}

function minimax(
  state: GameState,
  playerToMove: Player,
  remainingDepth: number,
  alpha: number,
  beta: number,
  deadline: number,
  tt: TranspositionTable,
  rootPlayer: Player,
): number {
  // Checked on entry, not just between siblings, so a deadline unwinds the
  // whole stack at once instead of after the current ply finishes.
  if (state.winner || remainingDepth === 0 || Date.now() >= deadline) {
    return evaluateState(state, rootPlayer);
  }

  const key = positionKey(state);

  // What an earlier visit to this exact position already proved. The same
  // few cells get played in different orders all over the tree, so the same
  // position turns up again and again — answering from here skips the whole
  // subtree underneath it rather than merely ordering it better.
  //
  // Only a result searched at least as deep as this node needs can be
  // trusted; a shallower one saw less than we are about to. The bound kind
  // decides how much it says: an exact score answers outright, while a
  // one-sided bound can only narrow the window, which still often produces
  // an immediate cutoff.
  if (ttScoresEnabled) {
    const hit = tt.get(key);
    if (hit && hit.depth >= remainingDepth) {
      if (hit.bound === Bound.Exact) return hit.score;
      if (hit.bound === Bound.Lower) alpha = Math.max(alpha, hit.score);
      else beta = Math.min(beta, hit.score);
      if (alpha >= beta) return hit.score;
    }
  }

  const alphaOrig = alpha;
  const betaOrig = beta;

  const actions = orderedCandidates(
    state,
    playerToMove,
    branchLimit(remainingDepth),
    tt.getBestMoveKey(key),
    // Only near the top of the tree. The nodes at small remaining depth are
    // the overwhelming majority, and an extra candidate there costs a whole
    // subtree each; up here it costs one leaf and is what lets a frame appear
    // at all.
    remainingDepth >= 3,
  );
  if (actions.length === 0) return evaluateState(state, rootPlayer);

  const maximizing = playerToMove === rootPlayer;
  let best = maximizing ? -Infinity : Infinity;
  let bestActionKey: string | null = null;
  let aborted = false;

  for (const action of actions) {
    const child = applyAction(state, action);
    const value = child.winner
      ? evaluateState(child, rootPlayer)
      : minimax(child, opponent(playerToMove), remainingDepth - 1, alpha, beta, deadline, tt, rootPlayer);

    if (maximizing ? value > best : value < best) {
      best = value;
      bestActionKey = actionKey(action);
    }

    if (maximizing) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);

    if (beta <= alpha) break;
    if (Date.now() >= deadline) {
      aborted = true;
      break;
    }
  }

  // Nothing is stored once the clock has run out, however this node's loop
  // happened to end. Two different ways a score goes bad here, and only
  // checking `aborted` catches the first:
  //
  //  - this node broke out early, so it never saw the rest of its moves;
  //  - the deadline passed somewhere *below* it, where every recursive call
  //    bails out returning a static evaluation instead of a searched value.
  //    Those shallow numbers propagate straight back up, and a node that
  //    then exits on a beta cutoff still looks like a clean cutoff — so it
  //    would store a bound built out of values nothing ever searched.
  //
  // The second is the dangerous one, because a stored score is read back as
  // fact by every later lookup, and the table now outlives a single search
  // (see searchVerified) — so one poisoned entry can steer every remaining
  // attempt on this move. The deadline only ever passes, never un-passes,
  // so testing it here rules out both cases at once. The move hint is still
  // worth keeping either way: it is only ever a suggestion.
  if (aborted || Date.now() >= deadline) {
    if (bestActionKey) tt.setBestMoveKey(key, bestActionKey);
    return best;
  }

  if (ttScoresEnabled) {
    // Which side of the original window the result fell out of is what
    // decides whether it is exact or one-sided, and the same two tests read
    // correctly for both node types: a maximizing node cuts off having shown
    // the value is at least `best`, a minimizing one having shown it is at
    // most `best`, and each lands on its own branch below. Only a result
    // that stayed strictly inside the window saw every move it needed to.
    const bound =
      best <= alphaOrig ? Bound.Upper : best >= betaOrig ? Bound.Lower : Bound.Exact;
    tt.store(key, remainingDepth, best, bound, bestActionKey);
  } else if (bestActionKey) {
    tt.setBestMoveKey(key, bestActionKey);
  }
  return best;
}

const CAPTURE_READ_DEPTH = 7;
/** Share of the budget spent proving a kill before anything else. */
const ATTACK_READ_SHARE = 0.2;
/** Share spent screening our own candidates for forced losses. */
const DEFEND_READ_SHARE = 0.4;
/** Only the most promising moves are worth a full life-and-death screening;
 * checking all ~70 would consume the entire budget and leave the positional
 * search with nothing. */
const DEFEND_SCREEN_LIMIT = 18;

/** Budget for checking whether one of the mover's own *existing* groups —
 * one already on the board before this turn, not a candidate about to be
 * placed — is being walked toward a forced capture. Cheap to afford
 * generously: there are usually zero or one such groups on the whole board,
 * so one thorough read here costs far less in aggregate than the ~60-way
 * per-candidate screen above, and a real loss traced to exactly this gap —
 * see `existingGroupDanger` below. */
const EXISTING_DANGER_BUDGET_MS = 200;

/**
 * Does the opponent already have a forced capture against one of the
 * mover's own existing groups, regardless of what the mover plays elsewhere
 * this turn? Reuses findForcedCapture exactly as the attack side does,
 * just asked from the other direction: "if it were your move right now,
 * could you force one of my groups?"
 *
 * This is not a hypothetical the routine defend-screen already covers. That
 * screen only tests candidates ranked highest by local score, and it tests
 * them by asking "does *this* move create a problem" — never "is there a
 * problem sitting on the board already that this move ignores". A traced
 * real loss: a lone cat sat at two liberties for three unanswered turns
 * because extending it never scored well locally, so it never reached the
 * screen, and searchVerified's own after-the-fact check kept flagging
 * whatever else the search preferred as *also* forced (true — the danger
 * belongs to the existing group, not to the candidate that ignored it), so
 * every retry burned through the same greedy candidates without ever
 * trying the one move that actually helps: extending the endangered group
 * itself. Surfacing that group's own liberties as the candidate set is what
 * closes the gap.
 */
function existingGroupDanger(rootState: GameState, aiPlayer: Player, budgetMs: number): AIAction[] {
  const hypothetical: GameState = { ...rootState, currentPlayer: opponent(aiPlayer) };
  const forced = findForcedCapture(hypothetical, opponent(aiPlayer), CAPTURE_READ_DEPTH, budgetMs);
  if (!forced) return [];

  const group = getConnectedGroup(rootState.board, forced.target.row, forced.target.col);
  const liberties = getGroupLiberties(rootState.board, group);

  // Prefer a liberty that actually raises the group's count over one that
  // merely sits on it — see libertyGainingMoves. A real loss played this
  // exact gap: this check proved the group forced and handed over all three
  // of its raw liberties with no ranking between them, and the search chose
  // one that dropped the count from three to two over the one liberty away
  // that would have raised it to four, because nothing here had ever told it
  // the three looked-alike candidates weren't alike at all. Falling back to
  // the raw set when nothing improves keeps this check's original floor: a
  // defense is still offered even once the group is genuinely past saving.
  const improving = existingGroupDangerRankingEnabled
    ? libertyGainingMoves(rootState, aiPlayer, liberties, liberties.size)
    : [];
  // Added to the extending moves rather than replacing them, so the search
  // still chooses — the guard's job is to make sure the answer is on the list,
  // not to decide which answer it is.
  const walling = eyeMakingDefenceEnabled ? eyeMakingMoves(rootState, aiPlayer, liberties) : [];
  if (improving.length > 0 || walling.length > 0) {
    const both = [...improving];
    const have = new Set(
      improving.map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS")),
    );
    for (const move of walling) {
      const key = move.type === "PLACE" ? `${move.row},${move.col}` : "PASS";
      if (!have.has(key)) both.push(move);
    }
    return both;
  }

  const candidates: AIAction[] = [];
  for (const liberty of liberties) {
    const [row, col] = liberty.split(",").map(Number);
    if (isLegalMove(rootState, row, col, aiPlayer)) candidates.push({ type: "PLACE", row, col });
  }
  return candidates;
}

/**
 * Whether a threatened group may also be defended by walling one of its
 * liberties into an eye, rather than only by extending onto one.
 *
 * On by default — see `tuning.eyeSpaceWeight` for the measurement. The two
 * belong together: this puts the walling move on the shortlist, and the weight
 * is what lets the search prefer it.
 */
export let eyeMakingDefenceEnabled = true;
export function setEyeMakingDefenceEnabled(value: boolean): void {
  eyeMakingDefenceEnabled = value;
}

/**
 * Moves that would enclose one of this group's liberties into an eye.
 *
 * `existingGroupDanger` can only ever offer the group's own liberties, so the
 * only defence it can express is "extend". Walling off a point beside the group
 * is not in its vocabulary, and in this game that is the stronger answer: one
 * eye is life, because confirmed territory can never be played by either side.
 *
 * Traced through two lost games. The group's eye point was a liberty of it, the
 * two stones that would have closed the eye were neighbours of that liberty and
 * therefore not liberties of the group, and so were never candidates at all.
 * The guard offered the eye point itself — extending onto it raises the liberty
 * count, which is the only thing it measures — and playing it destroyed the eye.
 *
 * So: for each liberty that could still become an eye (no enemy stone beside
 * it, at most two empty neighbours to fill), offer those empty neighbours.
 */
function eyeMakingMoves(
  rootState: GameState,
  aiPlayer: Player,
  liberties: Iterable<string>,
): AIAction[] {
  const enemy = playerCell(opponent(aiPlayer));
  const moves: AIAction[] = [];
  const seen = new Set<string>();
  for (const libertyKey of liberties) {
    const [row, col] = libertyKey.split(",").map(Number);
    const empties: Array<{ row: number; col: number }> = [];
    let enemyBeside = false;
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (rootState.board[r][c] === enemy) { enemyBeside = true; break; }
      if (rootState.board[r][c] === "EMPTY") empties.push({ row: r, col: c });
    }
    if (enemyBeside || empties.length === 0 || empties.length > 2) continue;
    for (const { row: r, col: c } of empties) {
      const key = `${r},${c}`;
      if (seen.has(key)) continue;
      if (!isLegalMove(rootState, r, c, aiPlayer)) continue;
      seen.add(key);
      moves.push({ type: "PLACE", row: r, col: c });
    }
  }
  return moves;
}

/** The subset of `liberties` (a group's own liberties) where playing there
 * actually raises that group's post-move liberty count above `currentCount`
 * — not just "is one of the group's current liberties," which is a much
 * weaker test. A move that merely relocates a liberty (fills one, opens
 * another elsewhere on the same stone) leaves the count unchanged and isn't
 * real reinforcement, whatever it looks like. */
function libertyGainingMoves(
  rootState: GameState,
  aiPlayer: Player,
  liberties: Iterable<string>,
  currentCount: number,
): AIAction[] {
  const moves: AIAction[] = [];
  for (const libertyKey of liberties) {
    const [row, col] = libertyKey.split(",").map(Number);
    if (!isLegalMove(rootState, row, col, aiPlayer)) continue;

    const action: AIAction = { type: "PLACE", row, col };
    const next = applyAction(rootState, action);
    if (next.winner === aiPlayer) {
      moves.push(action);
      continue;
    }
    if (next.winner) continue;

    const newGroup = getConnectedGroup(next.board, row, col);
    const newLiberties = getGroupLiberties(next.board, newGroup);
    if (newLiberties.size > currentCount) moves.push(action);
  }
  return moves;
}

/** Liberty count a thin group is allowed to sit at before this check starts
 * looking for reinforcement. Kept equal to captureSearch's own tracked
 * ceiling: below this, findForcedCapture is already the tool for the job.
 *
 * Three is what shipped, and it is the reason this guard decides 23.8% of the
 * engine's moves. Split by what triggered it over 604 recorded AI turns, the
 * firing is halved between real urgency and not: 1.3% on a group already in
 * atari, 23.3% on two liberties — one move from atari, genuinely pressing —
 * and 23.0% on three, which takes three opponent moves against two replies.
 *
 * Settable so the arena can price dropping it to 2, which would hand that last
 * 23.0% back to the full search and leave the guard covering every group that
 * is actually one move from trouble.
 */
const THIN_GROUP_LIBERTY_THRESHOLD = 3;

/**
 * The same ceiling, for `thinGroupDanger` alone.
 *
 * Split out rather than making the constant itself settable, because the other
 * two readers of it — `avoidSelfInflictedThin` — are asking a different
 * question ("would this move leave me thin?") and have no part in the 23.8%
 * measured above. Moving them together would change two behaviours and let the
 * arena attribute the result to neither.
 */
let thinGroupLibertyThreshold = THIN_GROUP_LIBERTY_THRESHOLD;
export function setThinGroupLibertyThreshold(value: number): void {
  thinGroupLibertyThreshold = value;
}

/**
 * A cheaper, earlier net than existingGroupDanger above. That check only
 * fires once the forced-capture reader can *prove* a kill, which needs a
 * group already down to a handful of liberties before the proof search even
 * starts working — and on a busy board the AND/OR read itself gets
 * unreliable well before that (traced on a real position: only 1 of 63
 * candidates cleared the check at all). This asks a much simpler question
 * instead, of any of the mover's own groups sitting at three liberties or
 * fewer with an opponent stone already bordering one of those liberties: is
 * there a legal move right here that actually *raises* this group's liberty
 * count? "Raises" is checked directly on the resulting board, not assumed —
 * a traced real loss extended a two-liberty group onto one of its own
 * liberties and came out with two liberties again, because the new stone's
 * only new liberty just replaced the one it was built on. A move that
 * doesn't clear that bar isn't reinforcement, whatever it looks like, and is
 * left out rather than returned as a false sense of safety.
 *
 * Deliberately does not try to stop a group from *becoming* thin in the
 * first place — that is the evaluation's job (see the `thin` shape term) —
 * only to notice one that already is and find whatever real escape exists
 * before the general search, which never asks this question until a capture
 * is provable, wanders past it.
 */
function thinGroupDanger(rootState: GameState, aiPlayer: Player): AIAction[] {
  const opponentPlayer = opponent(aiPlayer);
  const opponentCell = playerCell(opponentPlayer);
  const ownTerritory = new Set(rootState.territories[aiPlayer].map((c) => `${c.row},${c.col}`));

  const moves: AIAction[] = [];
  const seen = new Set<string>();

  for (const group of getAllGroups(rootState.board, aiPlayer)) {
    const liberties = getGroupLiberties(rootState.board, group);
    if (liberties.size === 0 || liberties.size > thinGroupLibertyThreshold) continue;
    // A liberty inside the mover's own confirmed territory can never be
    // filled by anyone — this group is permanently safe, not thin.
    if ([...liberties].some((l) => ownTerritory.has(l))) continue;

    const underPressure = [...liberties].some((libertyKey) => {
      const [row, col] = libertyKey.split(",").map(Number);
      return DIRECTIONS.some(([dr, dc]) => {
        const r = row + dr;
        const c = col + dc;
        return inBounds(r, c) && rootState.board[r][c] === opponentCell;
      });
    });
    if (!underPressure) continue;

    for (const action of libertyGainingMoves(rootState, aiPlayer, liberties, liberties.size)) {
      const dedupeKey = action.type === "PLACE" ? `${action.row},${action.col}` : "PASS";
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      moves.push(action);
    }
  }

  return moves;
}

/** Share of the remaining budget set aside to double-check the *search's own
 * answer* against the forced-capture reader, once it has one.
 *
 * The screen above only ever examines the moves ranked highest by local
 * score — cheap, but blind to a move that scores nothing locally and still
 * gets chosen by the deeper positional search for other reasons (an open
 * pocket looked like influence worth having). That gap is exactly how the
 * engine once walked a lone cat onto an edge column and lost it three moves
 * later: the move ranked 45th of 60 by local score, so the screen never
 * looked at it, and nothing checked the search's actual answer until the
 * opponent already had. Verifying every candidate up front to close that
 * would flood the budget with false alarms instead — nearly any lightly
 * supported edge placement reads as "forceable" in an otherwise open
 * position, the same way a lone stone in a Go corner dies to a ladder with
 * no help nearby. Checking only what the search actually wants to play
 * avoids that: it is asked about one move, not a shortlist of suspects. */
const VERIFY_SHARE = 0.2;
const VERIFY_BUDGET_CAP_MS = 400;
const VERIFY_BUDGET_FLOOR_MS = 150;
/** A whole neighbourhood can be equally bad — on the real game this fixes,
 * both the move actually played and the next thing the search reached for
 * instead were provable forced captures, because the opponent's wall there
 * was simply too strong for anything nearby to survive. One retry only
 * catches the first of those; a few catches the rest without letting a
 * pathological position spend the whole budget re-searching from scratch. */
const MAX_VERIFY_ATTEMPTS = 6;

/** Runs the positional search, then confirms its answer isn't a move the
 * opponent can force-capture — the same tactical floor the pre-screen above
 * gives the moves it actually examines. If the search's favourite fails that
 * check, it's dropped and the search runs again on what's left, up to
 * MAX_VERIFY_ATTEMPTS times; each attempt gets whatever time remains before
 * `budgetMs` runs out, so a pathological position degrades to less search
 * depth rather than blowing the deadline.
 *
 * `widenTo`, if given, is a broader pool to fall back to once `pool` itself
 * is exhausted. A territorial shortlist can be as small as one or two moves
 * — if every one of those is refuted, retrying within that same tiny list
 * has nothing left to offer, even though the wider legal pool still has
 * genuinely safe moves the shortlist never included. */
function searchVerified(
  rootState: GameState,
  aiPlayer: Player,
  pool: AIAction[],
  budgetMs: number,
  widenTo?: AIAction[],
): AIAction {
  const deadline = Date.now() + budgetMs;
  let candidates = pool;
  let hasWidened = false;
  let choice: AIAction = pool[0];

  // One table across every retry, rather than one per attempt. A refuted
  // candidate only removes a move from the *root* list; every position below
  // the root is the same board it was a moment ago, so everything the last
  // attempt proved about those subtrees still holds. Rebuilding from empty
  // each time threw all of it away — and it is exactly the positions that
  // retry most that could least afford it. Measured on a real game, turns
  // 30-40 ran six full re-searches per move, and search depth there had
  // collapsed to 3 while the early game managed 5.
  //
  // Safe because a cat is never removed from the board: a capture ends the
  // game outright, so stone count strictly increases and no position can
  // ever recur within a search. An entry can therefore never describe a
  // position that has since changed underneath it.
  const tt = ttScoresEnabled ? new TranspositionTable() : undefined;

  for (let attempt = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
    if (candidates.length === 0) {
      if (hasWidened || !widenTo || widenTo.length === 0) break;
      candidates = widenTo;
      hasWidened = true;
    }

    const timeLeft = Math.max(150, deadline - Date.now());
    const verifyBudget = Math.min(VERIFY_BUDGET_CAP_MS, Math.max(VERIFY_BUDGET_FLOOR_MS, timeLeft * VERIFY_SHARE));
    const searchBudget = Math.max(150, timeLeft - verifyBudget);

    choice = searchWithin(rootState, aiPlayer, candidates, searchBudget, tt);
    const next = applyAction(rootState, choice);
    if (next.winner || !opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, verifyBudget)) {
      return choice;
    }
    candidates = candidates.filter((action) => action !== choice);
  }

  // Every attempt was refuted — nothing left to offer but the last one tried.
  return choice;
}

/**
 * Openings worth playing, measured rather than judged.
 *
 * An empty board is symmetric under all eight rotations and reflections, so
 * every opening belongs to a class whose members are the same move with the
 * coordinates relabelled. Three classes were played out in full — each
 * member of each class, so that any lopsidedness in the test itself averages
 * away rather than being attributed to one point:
 *
 *   (2,2) class    61/120   50.8%
 *   (1,2) class    91/192   47.4%
 *   (1,3) class   100/216   46.3%
 *   (3,3) class    45/120   37.5%
 *
 * The top three are indistinguishable from one another — the widest gap
 * among them, (2,2) over (1,3), is 4.5 points at p = 0.43. Only (3,3) is
 * measurably worse than anything else (13.3 points below (2,2), z = 2.08,
 * p = 0.038), and it is the one this engine used to play. So the book holds
 * the three that tie and drops the one that loses.
 *
 * (1,2) is worth naming: it is the point professionals actually open on. In
 * a recorded Great Kingdom game (프로연우 vs 이세돌, 2023/06/05) all four
 * corners' first cat landed on a member of this class. It was nearly left
 * out on the strength of a single member scoring 46%, which is exactly the
 * mistake described below; across its full mirror set it scores as well as
 * anything in the book.
 *
 * It used to get there by ranking all 80 openings on a one-ply evaluation
 * and picking among the ties. That evaluation put (3,3) top with 95 points
 * and (2,2) joint-second with 75 — the reverse of how they actually score,
 * which is the same influence-radius bias documented on severeInfluenceTerm
 * and INFLUENCE_TO_TERRITORY: two board edges truncate a corner-ward cat's
 * apparent reach long before an opposing cat would. One ply is the
 * shallowest read this engine ever takes, and it was taking it on the one
 * move where nothing is under attack and there is nothing to read.
 *
 * Keeping all three rather than only the best also keeps the opening
 * unpredictable — twenty distinct first moves instead of four — which costs
 * nothing when they are statistically indistinguishable.
 *
 * Measured at a 700ms budget. If the search gets much faster or slower than
 * that, the ordering is worth re-running before it is trusted again.
 */
/**
 * Narrowed to the (1,2) class on the player's report, and on what the numbers
 * above already say.
 *
 * The three classes are statistically indistinguishable — the widest gap among
 * them is 4.5 points at p = 0.43 — so choosing one of them costs nothing that
 * was ever measured. (1,2) is the one professionals open on, the one every
 * corner of the recorded 프로연우 vs 이세돌 game used, and the one the player
 * opens on themselves: across their recorded games as first player, 10 of 13
 * first moves are members of this class.
 *
 * What it does cost is surprise. The book drops from twenty distinct first
 * moves to eight, all of the same shape, against an opponent who now knows it.
 * Against one human who already plays this opening every game, that is close to
 * nothing; it is the reason to put the other two classes back if the engine
 * ever faces someone else.
 *
 * The (2,2) and (1,3) members stay written down, commented out, so the measured
 * rates above keep the moves they refer to.
 */
const OPENING_BOOK: ReadonlyArray<Coord> = [
  // (2,2) class — 50.8%, held out
  // { row: 2, col: 2 }, { row: 2, col: 6 }, { row: 6, col: 2 }, { row: 6, col: 6 },
  // (1,2) class — 47.4%
  { row: 1, col: 2 },
  { row: 1, col: 6 },
  { row: 2, col: 1 },
  { row: 2, col: 7 },
  { row: 6, col: 1 },
  { row: 6, col: 7 },
  { row: 7, col: 2 },
  { row: 7, col: 6 },
  // (1,3) class — 46.3%, held out
  // { row: 1, col: 3 }, { row: 1, col: 5 }, { row: 3, col: 1 }, { row: 3, col: 7 },
  // { row: 5, col: 1 }, { row: 5, col: 7 }, { row: 7, col: 3 }, { row: 7, col: 5 },
];

/**
 * Off until measured. See `cornerBookMove`.
 */
export let cornerBookEnabled = false;
export function setCornerBookEnabled(value: boolean): void {
  cornerBookEnabled = value;
}

/**
 * Off until measured. See `cornerBookFinishGate`.
 */
export let cornerBookFinishEnabled = false;
export function setCornerBookFinishEnabled(value: boolean): void {
  cornerBookFinishEnabled = value;
}

/**
 * Whether equally near frame gaps break toward the middle of the anti-diagonal.
 *
 * On by default because the rules are unambiguous about the shape — see the
 * sort below. The flag exists so the arena can play the old arbitrary order
 * against the new one and say what the change is worth in games, which a local
 * shape measurement cannot.
 */
/**
 * Stake four corners with two stones each instead of finishing two with four.
 *
 * The player's method against the engine, found by playing it: put the middle
 * pair down, and if nothing comes near, go and put another pair in a different
 * corner rather than completing the first. The shape measurement is already on
 * their side — the middle pair alone leaves an invader alive at none of the
 * corner's eight entry points, so the frame's last two stones buy cells and no
 * safety at all, while the same two stones elsewhere claim a whole corner.
 *
 * Off until the arena says otherwise: it is a real policy change, not a tie.
 */
export let cornerBookSpreadEnabled = false;
export function setCornerBookSpreadEnabled(value: boolean): void {
  cornerBookSpreadEnabled = value;
}

/**
 * Go into a corner they have opened before finishing a pair of my own.
 *
 * The player's second question, asked right after the spreading one: if two
 * stones already close a corner, is answering their new corner worth more than
 * putting the second stone in mine? The book has no opinion today — a corner
 * they hold one stone in is claimable on exactly the same footing as an empty
 * one, and both come after extending whatever I have already started, so the
 * order is whichever the opening book lists first.
 *
 * Off until the arena says otherwise.
 */
export let cornerBookContestEnabled = false;
export function setCornerBookContestEnabled(value: boolean): void {
  cornerBookContestEnabled = value;
}

export let cornerFrameCentreEnabled = true;
export function setCornerFrameCentreEnabled(value: boolean): void {
  cornerFrameCentreEnabled = value;
}

/** How many of the mover's own stones the corner book still applies for. */
const CORNER_BOOK_STONES = 5;
/**
 * The same budget when the book is asked to finish what it starts.
 *
 * `CORNER_BOOK_STONES` counts the mover's stones on the whole board, not the
 * stones in the corner being built, so five is spent long before any frame is
 * done: claim two corners and three moves remain, against the four one frame
 * needs. The records show the consequence and not the intent — an uncontested
 * corner gets 2.14 engine stones and is dropped at turn 14.6 of a fifty-turn
 * game, where the player's gets 5.80 and is still being played at turn 32.8.
 *
 * What that costs is the whole gap: uncontested corners with one or two engine
 * stones finish worth 1.36 cells, the two that got three or four finish worth
 * 6.00 — the frame's six, exactly — and the player's five-plus finish at 8.75.
 *
 * Twelve is a valve rather than a target: it is the point by which two frames
 * and the moves around them are done, so the book can never run the middlegame.
 * The real limits are the two below it.
 */
const CORNER_BOOK_STONES_FINISHING = 12;
/** Frame stones one corner is worth, which is what encloses its six cells. */
const CORNER_BOOK_FRAME_STONES = 4;
/** Corners the book will open before it stops claiming and starts finishing. */
const CORNER_BOOK_MAX_CORNERS = 2;
/** The same two numbers under the spreading policy: the pair, in every corner. */
const CORNER_BOOK_SPREAD_STONES = 2;
const CORNER_BOOK_SPREAD_CORNERS = 4;
/**
 * Read given to checking the book's own move before it is played.
 *
 * One move, one read, so this is a fixed slice rather than a share of what is
 * left: the book fires in the opening where the budget is barely touched, and
 * spending a third of a second to not hand over a group is the trade.
 */
const CORNER_BOOK_VERIFY_MS = 300;
/**
 * Enemy stones a corner may already hold and still be worth walking into.
 *
 * Two, because that is where the record still reads as free: 40 of 42 human
 * stones and 59 of 60 engine stones survived entering a corner holding one, and
 * 4 of 4 on each side at two. Beyond that the sample thins out and the claim
 * stops being supported rather than being contradicted.
 */
const CORNER_BOOK_MAX_ENEMY = 2;

/**
 * The professional point of a corner nobody has opened yet.
 *
 * The evidence is suggestive rather than settled, and worth stating at its real
 * strength. Within each side's own games, the number of (1,2) stones in the
 * first six moves correlates with that side's mean available seal at turns
 * 21-30 at r = 0.26 for the human and r = 0.27 for the engine — the same
 * direction independently on both sides, neither significant alone (t = 1.4 and
 * 1.5). The engine's games split at zero: 1.00 cells of supply in the eleven
 * games where it played no (1,2) stone early, 1.65 in the twenty where it played
 * at least one.
 *
 * Against that, the opening measurement already showed the (1,2), (2,2) and
 * (1,3) classes are indistinguishable on win rate, so playing this point instead
 * of whatever the search preferred costs nothing that has been measured.
 */
export function cornerBookMove(
  rootState: GameState,
  aiPlayer: Player,
  pool: AIAction[],
): AIAction | null {
  let own = 0;
  for (const row of rootState.board) {
    for (const cell of row) if (cell === playerCell(aiPlayer)) own += 1;
  }
  // Covers the second player's first stone too. `openingMove` above only fires
  // on an empty board, so without this the side moving second picks its opening
  // by search — and in self-play it picked the centre, which is the one class
  // the opening measurement found measurably worse.
  if (own >= (cornerBookFinishEnabled ? CORNER_BOOK_STONES_FINISHING : CORNER_BOOK_STONES)) {
    return null;
  }

  const safe = new Set(
    pool
      .filter((a): a is Extract<AIAction, { type: "PLACE" }> => a.type === "PLACE")
      .map((a) => `${a.row},${a.col}`),
  );
  const size = rootState.board.length;
  const quadrant = (row: number, col: number) =>
    row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;

  // A corner is closed to us once we are already in it, or once the opponent
  // holds enough of it to make entering a fight rather than a claim.
  //
  // The first version of this refused any corner with a stone in it, which the
  // records say is too strict: of 122 stones played into a quadrant the opponent
  // already held, 118 were still alive at the end — 95% at one enemy stone, 100%
  // at two. Going in is nearly free, and refusing to hands the opponent every
  // corner they touch first.
  const held: Record<string, { mine: number; theirs: number; frame: number }> = {};
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const cell = rootState.board[row][col];
      if (cell !== playerCell(aiPlayer) && cell !== playerCell(opponent(aiPlayer))) continue;
      const q = quadrant(row, col);
      if (!q) continue;
      held[q] ??= { mine: 0, theirs: 0, frame: 0 };
      if (cell === playerCell(aiPlayer)) {
        held[q].mine += 1;
        const dr = Math.min(row, size - 1 - row);
        const dc = Math.min(col, size - 1 - col);
        if (dr + dc === 3) held[q].frame += 1;
      } else held[q].theirs += 1;
    }
  }

  const playable = (row: number, col: number) =>
    rootState.board[row][col] === "EMPTY" &&
    safe.has(`${row},${col}`) &&
    isLegalMove(rootState, row, col, aiPlayer);

  // A corner already holding one of our stones: keep building the frame.
  //
  // The four points (1,2) (0,3) (2,1) (3,0) are exactly the corner's anti-
  // diagonal, the cells whose two edge distances sum to three. Asked of the
  // rules, that frame encloses six cells and is the single best four-stone shape
  // in the corner — every other four-stone set tops out at five, and the finished
  // frame cannot be entered at all, since confirmed territory is unplayable by
  // either side.
  //
  // Interrupted it still holds. With three of the four down, an opponent stone
  // inside the corner dies to a single reply and the defender keeps a cell;
  // a stone outside lets the fourth land and settles all six.
  //
  // Under contact it drops to the small shape instead: (1,2) with the edge point
  // beside the corner and the one away from it — three stones, one eye, and
  // three enemy stones pressing cannot take it.
  const frameOf = (q: string) => {
    const rowEdge = q[0] === "T" ? 0 : size - 1;
    const colEdge = q[1] === "L" ? 0 : size - 1;
    const step = (n: number, edge: number) => (edge === 0 ? n : edge - n);
    return [0, 1, 2, 3].map((a) => ({
      row: step(a, rowEdge),
      col: step(3 - a, colEdge),
    }));
  };

  // Their corner first, when asked to. Same points and the same enemy-count
  // limit as the claim below; only the priority differs.
  if (cornerBookContestEnabled) {
    for (const { row, col } of OPENING_BOOK) {
      const q = quadrant(row, col);
      if (!q) continue;
      const there = held[q];
      if (!there || there.mine > 0 || there.theirs === 0) continue;
      if (there.theirs > CORNER_BOOK_MAX_ENEMY) continue;
      if (!playable(row, col)) continue;
      return { type: "PLACE", row, col };
    }
  }

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (rootState.board[row][col] !== playerCell(aiPlayer)) continue;
      const q = quadrant(row, col);
      if (!q) continue;
      if ((held[q]?.theirs ?? 0) > CORNER_BOOK_MAX_ENEMY) continue;
      // The frame is four stones and encloses six cells; a fifth adds nothing
      // the rules will pay for, and the measurement behind the depth limit says
      // a wider one only makes the inside easier to live in.
      const wantFrame = cornerBookSpreadEnabled
        ? CORNER_BOOK_SPREAD_STONES
        : CORNER_BOOK_FRAME_STONES;
      if ((held[q]?.frame ?? 0) >= wantFrame) continue;

      const dr = Math.min(row, size - 1 - row);
      const dc = Math.min(col, size - 1 - col);
      if (dr + dc !== 3) continue; // not a stone on this corner's frame line

      // Size to the opposition, which is what the records show both sides
      // doing and the player states as the rule. Cells finally held in a corner
      // against enemy stones present when the second stone landed:
      //
      //            0 enemies   1     2+
      //   human         6.18  3.04  2.47
      //   ai            2.00  1.49  0.90
      //
      // The human's uncontested corner is 6.18 cells, which is the frame. So the
      // frame is for corners with at most one enemy stone; beyond that, or with
      // one already touching, take the small eye and be content to obstruct.
      let pressed = (held[q]?.theirs ?? 0) >= 2;
      for (const [ar, ac] of DIRECTIONS) {
        const r = row + ar;
        const c = col + ac;
        if (inBounds(r, c) && rootState.board[r][c] === playerCell(opponent(aiPlayer))) {
          pressed = true;
          break;
        }
      }

      if (pressed) {
        // Secure the small eye: the two edge points either side of our stone.
        const rowEdge = q[0] === "T" ? 0 : size - 1;
        const colEdge = q[1] === "L" ? 0 : size - 1;
        const onEdge = dr < dc
          ? [{ row: rowEdge, col: col - 1 }, { row: rowEdge, col: col + 1 }]
          : [{ row: row - 1, col: colEdge }, { row: row + 1, col: colEdge }];
        // Toward the stone that is pressing, not away from it. Which of the two
        // came first was decided by the order they are built above, the same
        // accident that was choosing the frame's second stone. Measured on both
        // of the corner's edges: taking the near one leaks at none of its entry
        // points where the far one leaks at four of eight, and where it makes no
        // difference both are zero — better twice, level twice, worse never.
        if (cornerFrameCentreEnabled) {
          const near = (p: { row: number; col: number }) => {
            let best = Infinity;
            for (let r = 0; r < size; r += 1) {
              for (let c = 0; c < size; c += 1) {
                if (rootState.board[r][c] !== playerCell(opponent(aiPlayer))) continue;
                if (quadrant(r, c) !== q) continue;
                best = Math.min(best, Math.abs(r - p.row) + Math.abs(c - p.col));
              }
            }
            return best;
          };
          onEdge.sort((a, b) => near(a) - near(b));
        }
        for (const next of onEdge) {
          if (!inBounds(next.row, next.col)) continue;
          if (!playable(next.row, next.col)) continue;
          return { type: "PLACE", row: next.row, col: next.col };
        }
      }

      // Otherwise extend along the frame, nearest gap to what we already hold —
      // and where two gaps are equally near, take the more central one.
      //
      // That tie is not a detail. From the (1,2) point both (0,3) and (2,1) are
      // two steps away, so the sort was decided by the order `frameOf` happens
      // to build its array, which put (0,3) first. Asked of the rules, those two
      // pairs are the best and nearly the worst opening a corner has: over all
      // 120 two-stone starts in the corner, (1,2) with (2,1) kills the invader at
      // every one of eight entry points, and (1,2) with (0,3) lets five of eight
      // live, ranking 61st. The book was building the second one every time.
      //
      // Centrality is `min(dr, dc)`: the middle pair of the anti-diagonal is
      // symmetric about the corner's own diagonal, so the cut between the two
      // stones faces into the corner rather than out along an edge.
      //
      // One case overrides the centrality rule, and it is the player's, found
      // after the first version shipped. When the opponent already sits on the
      // edge line right beside the edge-side frame point, taking that point is
      // no longer a way of making an eye — it is a block, and the rules pay for
      // it. Measured on both of the corner's edges so the mirror checks the
      // claim: with the enemy on a flanking cell the edge point leaks at none of
      // its entry points and the middle one at two or three of seven, 4 of 4
      // both ways; with the enemy anywhere else the middle wins 10 of 12 and the
      // edge never does.
      const flanked = (p: { row: number; col: number }) => {
        const dr = Math.min(p.row, size - 1 - p.row);
        const dc = Math.min(p.col, size - 1 - p.col);
        if (Math.min(dr, dc) !== 0) return false; // not an edge-side frame point
        const along: Array<[number, number]> = dr === 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
        return along.some(([ar, ac]) => {
          const r = p.row + ar;
          const c = p.col + ac;
          return inBounds(r, c) && rootState.board[r][c] === playerCell(opponent(aiPlayer));
        });
      };
      const gaps = frameOf(q)
        .filter((p) => playable(p.row, p.col))
        .map((p) => ({
          p,
          near: Math.abs(p.row - row) + Math.abs(p.col - col),
          block: cornerFrameCentreEnabled && flanked(p) ? 1 : 0,
          middle: Math.min(
            Math.min(p.row, size - 1 - p.row),
            Math.min(p.col, size - 1 - p.col),
          ),
        }))
        .sort(
          (a, b) =>
            a.near - b.near ||
            b.block - a.block ||
            (cornerFrameCentreEnabled ? b.middle - a.middle : 0),
        )
        .map((x) => x.p);
      if (gaps.length > 0) return { type: "PLACE", row: gaps[0].row, col: gaps[0].col };
    }
  }

  // Claiming a third corner is not what the raised budget is for. Once two are
  // open the remaining stones belong to finishing them, which is the whole point
  // of the change — the old budget could open corners it could never close, and
  // an unclosed corner is worth 1.36 cells against a closed one's 6.
  const opened = Object.values(held).filter((h) => h.mine > 0).length;
  const maxCorners = cornerBookSpreadEnabled
    ? CORNER_BOOK_SPREAD_CORNERS
    : CORNER_BOOK_MAX_CORNERS;
  if (cornerBookFinishEnabled && opened >= maxCorners) return null;

  for (const { row, col } of OPENING_BOOK) {
    const q = quadrant(row, col);
    if (!q) continue;
    const there = held[q];
    if (there && (there.mine > 0 || there.theirs > CORNER_BOOK_MAX_ENEMY)) continue;
    if (!playable(row, col)) continue;
    return { type: "PLACE", row, col };
  }
  return null;
}

/**
 * The book move, on move one only. Past that the board is no longer
 * symmetric and the real search should decide.
 */
function openingMove(rootState: GameState, aiPlayer: Player): AIAction | null {
  const boardIsEmpty = rootState.board.every((row) =>
    row.every((cell) => cell !== "PLAYER_A" && cell !== "PLAYER_B"),
  );
  if (!boardIsEmpty) return null;

  const playable = OPENING_BOOK.filter(({ row, col }) => isLegalMove(rootState, row, col, aiPlayer));
  // Nothing in the book is playable — hand the position back to the search
  // rather than forcing a move the rules would not allow.
  if (playable.length === 0) return null;

  const pick = playable[Math.floor(Math.random() * playable.length)];
  return { type: "PLACE", row: pick.row, col: pick.col };
}

/**
 * Would `action` take one of the mover's own currently-safe groups and turn
 * it thin and opponent-pressured, for no compensating reason? "Currently
 * safe" is the point: this only fires when the group(s) the new stone joins
 * had *more* than three liberties before the move — a group that was
 * already this thin isn't made worse by extending it, that's
 * thinGroupDanger's territory. A traced real loss extended a lone cat with
 * four liberties one square deeper into a pocket the opponent had already
 * half-ringed, dropping it to three on a move that wasn't forced by
 * anything — nothing upstream of the search ever asked "does this specific
 * placement make one of my own groups worse than leaving it alone would
 * have," only "how does the resulting position score," and a three-liberty
 * group two moves deep into a search tree scores close enough to a safe one
 * that the drop never stood out.
 */
function createsVoluntaryThinGroup(rootState: GameState, aiPlayer: Player, action: AIAction): boolean {
  if (action.type !== "PLACE") return false;
  const { row, col } = action;

  const touchedLiberties: number[] = [];
  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) continue;
    if (rootState.board[r][c] !== playerCell(aiPlayer)) continue;
    const group = getConnectedGroup(rootState.board, r, c);
    touchedLiberties.push(getGroupLiberties(rootState.board, group).size);
  }
  // A fresh stone joining nothing of the mover's own isn't "extending into"
  // anything worse — whatever liberties it has are just what that empty
  // cell offered to begin with.
  if (touchedLiberties.length === 0) return false;
  const bestBefore = Math.max(...touchedLiberties);
  if (bestBefore <= THIN_GROUP_LIBERTY_THRESHOLD) return false;

  const next = applyAction(rootState, action);
  if (next.winner) return false;
  const mergedGroup = getConnectedGroup(next.board, row, col);
  const afterLiberties = getGroupLiberties(next.board, mergedGroup);
  if (afterLiberties.size === 0 || afterLiberties.size > THIN_GROUP_LIBERTY_THRESHOLD) return false;

  const ownTerritory = new Set(rootState.territories[aiPlayer].map((c) => `${c.row},${c.col}`));
  if ([...afterLiberties].some((l) => ownTerritory.has(l))) return false;

  const opponentCell = playerCell(opponent(aiPlayer));
  return [...afterLiberties].some((libertyKey) => {
    const [r2, c2] = libertyKey.split(",").map(Number);
    return DIRECTIONS.some(([dr, dc]) => {
      const rr = r2 + dr;
      const cc = c2 + dc;
      return inBounds(rr, cc) && next.board[rr][cc] === opponentCell;
    });
  });
}

/**
 * Drops candidates that would voluntarily thin one of the mover's own safe
 * groups (see createsVoluntaryThinGroup) from the pool everything downstream
 * draws from. Like every other screen in this file, it only ever narrows —
 * if it would remove everything, the original pool survives untouched
 * rather than handing the rest of the search an empty list to choose from.
 */
function avoidSelfInflictedThin(rootState: GameState, aiPlayer: Player, pool: AIAction[]): AIAction[] {
  const safe = pool.filter((action) => !createsVoluntaryThinGroup(rootState, aiPlayer, action));
  return safe.length > 0 ? safe : pool;
}

/** Worst-case liberty count, one opponent reply deep, that counts as "this
 * extension was a trap." Not an atari test — the point is to catch a group
 * heading for real trouble before it gets there, the same way a human
 * player reads "if they just answer here, I'm in real trouble" without
 * needing the full forced-capture proof captureSearch.ts insists on. */
const LOOKAHEAD_TRAP_LIBERTIES = 2;
/** Only worth the extra opponent-reply read when the group this move
 * produces is already in the range where one more squeeze could matter —
 * a group with room to spare isn't worth reading this deep for. */
const LOOKAHEAD_LIBERTY_CEILING = 4;

/**
 * Would `action` extend one of the mover's own groups into a shape that
 * still *looks* fine right now — plenty of liberties, nothing thin, nothing
 * createsVoluntaryThinGroup would flag — but where the single most
 * damaging opponent reply already drops it to near-atari or worse?
 *
 * This is the gap createsVoluntaryThinGroup can't close on its own: a real
 * loss extended a group that read as 4 liberties after the move (safe by
 * every check that only looks at the position the move produces), and the
 * opponent's very next move at one of those four liberties took it straight
 * to 2 — because every remaining liberty bordered the opponent already, so
 * none of the four were ever independent escape routes, just four ways to
 * reach the same dead end one ply later. Reading one more ply on the
 * group's own liberties is cheap (at most a handful of replies to try) and
 * catches exactly that shape without needing a real forced-capture proof.
 */
function createsOneMoveTrap(rootState: GameState, aiPlayer: Player, action: AIAction): boolean {
  if (action.type !== "PLACE") return false;
  const { row, col } = action;

  let touchesOwnGroup = false;
  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (inBounds(r, c) && rootState.board[r][c] === playerCell(aiPlayer)) touchesOwnGroup = true;
  }
  if (!touchesOwnGroup) return false;

  const afterMove = applyAction(rootState, action);
  if (afterMove.winner) return false;

  const group = getConnectedGroup(afterMove.board, row, col);
  const liberties = getGroupLiberties(afterMove.board, group);
  if (liberties.size === 0 || liberties.size > LOOKAHEAD_LIBERTY_CEILING) return false;

  const ownTerritory = new Set(rootState.territories[aiPlayer].map((c) => `${c.row},${c.col}`));
  if ([...liberties].some((l) => ownTerritory.has(l))) return false;

  const opponentPlayer = opponent(aiPlayer);
  const anchor = group[0];

  for (const libertyKey of liberties) {
    const [r, c] = libertyKey.split(",").map(Number);
    if (!isLegalMove(afterMove, r, c, opponentPlayer)) continue;
    const afterReply = applyMove(afterMove, r, c);
    if (afterReply.winner === opponentPlayer) return true;
    if (afterReply.winner) continue;
    if (afterReply.board[anchor.row][anchor.col] !== playerCell(aiPlayer)) continue;

    const groupAfter = getConnectedGroup(afterReply.board, anchor.row, anchor.col);
    const libsAfter = getGroupLiberties(afterReply.board, groupAfter);
    if (libsAfter.size <= LOOKAHEAD_TRAP_LIBERTIES) return true;
  }
  return false;
}

/** Same graceful-narrowing pattern as avoidSelfInflictedThin, for
 * createsOneMoveTrap. */
function avoidOneMoveTraps(rootState: GameState, aiPlayer: Player, pool: AIAction[]): AIAction[] {
  const safe = pool.filter((action) => !createsOneMoveTrap(rootState, aiPlayer, action));
  return safe.length > 0 ? safe : pool;
}

/** How many empty cells the flood-fill below is willing to explore before
 * giving up and calling the space open. A group backed by this much room
 * has somewhere to go regardless of how the border stones split. */
const POCKET_BFS_CAP = 20;
/** A reachable region at or under this size, once the fill has actually
 * terminated (not just hit the cap), is small enough that who owns its
 * border matters. */
const SMALL_POCKET_MAX_CELLS = 8;
/** How much the opponent's border stones must outnumber the mover's own for
 * a small pocket to count as theirs rather than genuinely contested. */
const POCKET_DOMINANCE_MARGIN = 2;

/**
 * Floods the empty cells reachable from `starts` (a group's liberties,
 * typically), stopping at any stone of either colour, up to `cap` cells.
 * Reports the region size, whether the fill was cut off by the cap rather
 * than running out of room on its own, and how many distinct stones of each
 * colour border what it found.
 */
function pocketRoom(
  board: Board,
  starts: Iterable<string>,
  aiPlayer: Player,
  cap: number,
): { size: number; capped: boolean; mineBorder: number; theirsBorder: number } {
  const mineCell = playerCell(aiPlayer);
  const theirsCell = playerCell(opponent(aiPlayer));
  const seen = new Set<string>();
  const queue: Array<[number, number]> = [];
  for (const s of starts) {
    const [row, col] = s.split(",").map(Number);
    const key = `${row},${col}`;
    if (!seen.has(key)) {
      seen.add(key);
      queue.push([row, col]);
    }
  }

  let regionSize = 0;
  let mineBorder = 0;
  let theirsBorder = 0;
  const borderSeen = new Set<string>();

  while (queue.length > 0 && regionSize < cap) {
    const [row, col] = queue.shift()!;
    if (board[row][col] !== "EMPTY") continue;
    regionSize += 1;
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      const key = `${r},${c}`;
      if (board[r][c] === "EMPTY") {
        if (!seen.has(key)) {
          seen.add(key);
          queue.push([r, c]);
        }
      } else if (!borderSeen.has(key)) {
        borderSeen.add(key);
        if (board[r][c] === mineCell) mineBorder += 1;
        else if (board[r][c] === theirsCell) theirsBorder += 1;
      }
    }
  }

  return { size: regionSize, capped: queue.length > 0, mineBorder, theirsBorder };
}

/**
 * Would `action` extend one of the mover's own groups so its only room to
 * grow is a small pocket the opponent's stones already dominate the border
 * of? Neither createsVoluntaryThinGroup nor createsOneMoveTrap catch this:
 * both only read liberty *counts*, and a group can hold a perfectly
 * respectable four liberties while every one of them opens onto the same
 * four-cell dead end. A traced real loss extended into exactly that shape —
 * the position right after the move looked fine by every count-based
 * measure, and it took several more plies of actual play before the
 * liberties themselves started dropping, by which point nothing left to
 * read could undo it. Measured on that exact position: the reachable region
 * was 4 cells, bordered by five of the opponent's stones and two of the
 * mover's own — a pocket already lost before the last stone in it was even
 * placed.
 */
function extendsIntoDominatedPocket(rootState: GameState, aiPlayer: Player, action: AIAction): boolean {
  if (action.type !== "PLACE") return false;
  const { row, col } = action;

  let touchesOwnGroup = false;
  for (const [dr, dc] of DIRECTIONS) {
    const r = row + dr;
    const c = col + dc;
    if (inBounds(r, c) && rootState.board[r][c] === playerCell(aiPlayer)) touchesOwnGroup = true;
  }
  if (!touchesOwnGroup) return false;

  const next = applyAction(rootState, action);
  if (next.winner) return false;

  const group = getConnectedGroup(next.board, row, col);
  const liberties = getGroupLiberties(next.board, group);
  if (liberties.size === 0) return false;

  const ownTerritory = new Set(rootState.territories[aiPlayer].map((c) => `${c.row},${c.col}`));
  if ([...liberties].some((l) => ownTerritory.has(l))) return false;

  const room = pocketRoom(next.board, liberties, aiPlayer, POCKET_BFS_CAP);
  if (room.capped || room.size > SMALL_POCKET_MAX_CELLS) return false;
  return room.theirsBorder >= room.mineBorder + POCKET_DOMINANCE_MARGIN;
}

/** Same graceful-narrowing pattern as the other two screens, for
 * extendsIntoDominatedPocket. */
function avoidDominatedPockets(rootState: GameState, aiPlayer: Player, pool: AIAction[]): AIAction[] {
  const safe = pool.filter((action) => !extendsIntoDominatedPocket(rootState, aiPlayer, action));
  return safe.length > 0 ? safe : pool;
}

/** Ceiling on a group's own liberty count for pocketSealDanger to bother
 * checking it. Above this the group has enough independent liberties that
 * no single opponent move could plausibly matter — the whole point of this
 * check is groups that read as safe by count but aren't, and a wide-open
 * six-liberty group is genuinely safe by count. */
const POCKET_SEAL_LIBERTY_CEILING = 6;

/**
 * Is one of the mover's own groups sitting in space that still *reads* fine
 * — better liberty count than thinGroupDanger's ≤3 ceiling, nothing any
 * count-based check would flag — but where a single opponent move, played
 * anywhere on the rim of that space rather than on one of the group's own
 * liberties, would seal its whole reachable pocket into something small and
 * one-sided?
 *
 * A traced real loss: a lone stone held four liberties, completely
 * untouched, for twenty-five moves. Its owner never reinforced it because
 * nothing ever said it needed to — four liberties is exactly what a brand
 * new stone starts with. Then a single opponent move, played on a cell that
 * was not even one of that stone's four liberties, shrank its whole
 * reachable empty region from wide open to exactly the four cells it
 * already had, with the opponent now bordering seven of them to the
 * mover's one. The liberty count did not move at all across that one move —
 * before and after, it read exactly four — so nothing that watches liberty
 * counts, including every other check in this file, could have told the
 * difference. One move earlier, though, two different replies from the
 * mover would have kept the pocket wide open; checked directly, neither
 * reply raised the group's own liberty count, so libertyGainingMoves alone
 * would not have surfaced them either — what made them work was keeping the
 * *outside* space open, not the group's own breath.
 */
/**
 * Off until measured. See `unionWithSeals`.
 */
export let pocketSealTerritoryUnionEnabled = false;
export function setPocketSealTerritoryUnionEnabled(value: boolean): void {
  pocketSealTerritoryUnionEnabled = value;
}

/**
 * Adds the ground-taking moves to a defensive shortlist, without removing any
 * of the defence.
 *
 * Stage 1.85 sits ahead of every territorial stage, so whenever it fires the
 * engine defends. Counted over 32 recorded games it fires on 11% of engine
 * turns and in 78% of games, while the engine loses a group in 19% of them, and
 * 52% of its firings happen with a seal of two cells or more sitting on the
 * table. Re-deciding the seals the engine walked past put 10 of 38 positions
 * here, and it took the seal in none.
 *
 * Removing the guard is not the answer the arena supports: over 186 games it
 * costs 0.37 +/- 0.35 cells but the side without it lost 63 groups against 56,
 * so it is doing something, and the capture difference is well inside noise
 * either way. What the numbers do not support is the guard being the *only*
 * thing on the list. So this is the same union the eye-making defence uses:
 * the guard's job is to make sure its answer is available, not to be the only
 * answer available.
 *
 * Seals that would themselves thin the group are left out, for the reason
 * `pocketSealDenialFilterEnabled` exists — a shortlist that offers a losing
 * move undifferentiated is how a traced loss happened once already.
 */
function unionWithSeals(
  rootState: GameState,
  aiPlayer: Player,
  defence: AIAction[],
): AIAction[] {
  const out = [...defence];
  const have = new Set(
    defence.map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS")),
  );
  for (const { move } of findSealingMoves(rootState, aiPlayer)) {
    const key = `${move.row},${move.col}`;
    if (have.has(key)) continue;
    const action: AIAction = { type: "PLACE", row: move.row, col: move.col };
    if (createsVoluntaryThinGroup(rootState, aiPlayer, action)) continue;
    have.add(key);
    out.push(action);
  }
  return out;
}

// Exported so its firing rate can be counted against what it is defending
// against, rather than argued about.
export function pocketSealDanger(rootState: GameState, aiPlayer: Player): AIAction[] {
  const opponentPlayer = opponent(aiPlayer);
  const ownTerritory = new Set(rootState.territories[aiPlayer].map((c) => `${c.row},${c.col}`));
  const moves: AIAction[] = [];
  const seen = new Set<string>();

  for (const group of getAllGroups(rootState.board, aiPlayer)) {
    const liberties = getGroupLiberties(rootState.board, group);
    if (liberties.size === 0 || liberties.size > POCKET_SEAL_LIBERTY_CEILING) continue;
    if ([...liberties].some((l) => ownTerritory.has(l))) continue;

    // The cells a single opposing move could plausibly matter on: the
    // group's own liberties, plus the empty cells one step beyond them —
    // the same reach captureSearch's focusAround gives a capture race,
    // because that is exactly the reach a single move has on this shape.
    const rim = new Set<string>();
    for (const lib of liberties) {
      rim.add(lib);
      const [row, col] = lib.split(",").map(Number);
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (inBounds(r, c) && rootState.board[r][c] === "EMPTY") rim.add(`${r},${c}`);
      }
    }

    const sealingCells: string[] = [];
    for (const key of rim) {
      const [row, col] = key.split(",").map(Number);
      if (!isLegalMove(rootState, row, col, opponentPlayer)) continue;

      const hypothetical: GameState = { ...rootState, currentPlayer: opponentPlayer };
      const afterOpponent = applyMove(hypothetical, row, col);
      if (afterOpponent.winner) continue; // not this check's business
      if (afterOpponent.board[group[0].row][group[0].col] !== playerCell(aiPlayer)) continue;

      const groupAfter = getConnectedGroup(afterOpponent.board, group[0].row, group[0].col);
      const libsAfter = getGroupLiberties(afterOpponent.board, groupAfter);
      const after = pocketRoom(afterOpponent.board, libsAfter, aiPlayer, POCKET_BFS_CAP);
      if (
        !after.capped &&
        after.size <= SMALL_POCKET_MAX_CELLS &&
        after.theirsBorder >= after.mineBorder + POCKET_DOMINANCE_MARGIN
      ) {
        sealingCells.push(key);
      }
    }
    if (sealingCells.length === 0) continue;

    // Two kinds of answer: raise the group's own liberty count right now,
    // or occupy the very cell the opponent would have sealed it with —
    // denying the seal even when it doesn't raise the count itself. Denying
    // it is only a real answer if taking that cell doesn't itself thin the
    // group the same way createsVoluntaryThinGroup already screens for
    // elsewhere — a traced real loss offered exactly this group's own four
    // liberties as "denial" candidates undifferentiated, and the search
    // picked the one of the four that createsVoluntaryThinGroup would have
    // vetoed outright had it ever been asked, because this path builds its
    // own candidate list straight from the group's liberties instead of
    // going through the guarded pool the general search uses.
    const candidates = [
      ...libertyGainingMoves(rootState, aiPlayer, liberties, liberties.size),
      ...sealingCells
        .filter((key) => {
          const [row, col] = key.split(",").map(Number);
          if (!isLegalMove(rootState, row, col, aiPlayer)) return false;
          if (!pocketSealDenialFilterEnabled) return true;
          return !createsVoluntaryThinGroup(rootState, aiPlayer, { type: "PLACE", row, col });
        })
        .map((key) => {
          const [row, col] = key.split(",").map(Number);
          return { type: "PLACE" as const, row, col };
        }),
    ];

    for (const action of candidates) {
      const dedupeKey = action.type === "PLACE" ? `${action.row},${action.col}` : "PASS";
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      moves.push(action);
    }
  }

  return moves;
}

/** Budget for reading whether a near-complete corner cut is actually secure
 * — cheap relative to the move budget, since there are at most four corners
 * to check and most positions have none worth reading at all. */
const FRAMEWORK_READ_BUDGET_MS = 300;
/** A cut needing more gaps than this is outside the "corner is cheap" range
 * candidateFrameworks itself already enforces (see its own MAX_CUT) — this
 * exists so a framework that's still barely started doesn't get bumped to
 * the front of the search just because it happens to rank first among a
 * handful of far-off options. */
const FRAMEWORK_MAX_GAPS = 3;

/**
 * Cells that would finish one of the mover's own corner cuts — but only
 * once frameworks.ts's own security test has passed: every invasion killable,
 * and either no closing move left to contest or more than one way to make
 * it. That test is what makes this safe to prioritize outright rather than
 * merely score: a secure, one-or-two-gap corner is ground nobody can still
 * take away, so playing to finish it is never a wasted move the way scoring
 * a raw evaluation term for "corner-shaped ground" could be.
 *
 * This exists because the raw shape was tried as an evaluation term twice
 * before (see frameworkTerm's own history) and made the engine measurably
 * worse both times — a plain per-cell credit rewards a claim whether or not
 * it can actually be kept, which is exactly backwards from how a strong
 * player treats an unfinished corner. Feeding the *verified* frames into
 * candidate generation instead, as that history's own postscript suggested,
 * sidesteps the problem: nothing here is scored, only offered, and only once
 * it has already passed the same test a human would use to decide a corner
 * is really theirs.
 */
function frameworkCompletionMoves(rootState: GameState, aiPlayer: Player): AIAction[] {
  const verdicts = rankFrameworks(rootState, aiPlayer, FRAMEWORK_READ_BUDGET_MS);
  const moves: AIAction[] = [];
  const seen = new Set<string>();

  for (const verdict of verdicts) {
    if (!verdict.secure) continue;
    if (verdict.movesToClose === 0 || verdict.movesToClose > FRAMEWORK_MAX_GAPS) continue;

    for (const cell of verdict.frame.missing) {
      const key = `${cell.row},${cell.col}`;
      if (seen.has(key)) continue;
      if (!isLegalMove(rootState, cell.row, cell.col, aiPlayer)) continue;
      seen.add(key);
      moves.push({ type: "PLACE", row: cell.row, col: cell.col });
    }
  }

  return moves;
}

/**
 * Cells that would deny one of the OPPONENT's corner cuts — the same
 * question as frameworkCompletionMoves above, just asked from the other
 * side of the board. rankFrameworks tells the mover about frames they
 * themselves could finish; nothing before this ever asked whether the
 * opponent has one instead, so a frame the opponent had already secured
 * against invasion could keep closing turn after turn with nothing here
 * ever contesting it — the search only ever helps finish this engine's own
 * ground, never threatens someone else's.
 *
 * The target here is the frame's missing *wall* point, not its enclosed
 * interior. That distinction matters: judgeFramework's own security test
 * only tries invading the enclosed cells, because that is where a stone
 * would have to live to break the claim from inside, and a secure frame by
 * definition kills anything planted there. The wall line is different — it
 * is the frontier of the cut, still connected to the open board outside the
 * frame, so a stone played there does not need to survive *inside*
 * surrounded territory, only survive at all. That is exactly what
 * searchVerified's tactical check already confirms for every candidate
 * handed to it, the same way it does for this engine's own completion
 * moves — nothing extra is assumed safe here.
 *
 * Only frames the opponent has already secured are worth denying at all: an
 * insecure one is still contestable by the ordinary search (an invasion has
 * somewhere to live, or another closing point exists), so acting early on it
 * would just be guessing. A secure one a handful of moves from done is the
 * one case where waiting has a real cost — every turn spent elsewhere is a
 * turn closer to ground nothing here will ever be able to touch again.
 */
function opponentFrameworkDenialMoves(rootState: GameState, aiPlayer: Player): AIAction[] {
  const foe = opponent(aiPlayer);
  const verdicts = rankFrameworks(rootState, foe, FRAMEWORK_READ_BUDGET_MS);
  const moves: AIAction[] = [];
  const seen = new Set<string>();

  for (const verdict of verdicts) {
    if (!verdict.secure) continue;
    if (verdict.movesToClose === 0 || verdict.movesToClose > FRAMEWORK_MAX_GAPS) continue;

    for (const cell of verdict.frame.missing) {
      const key = `${cell.row},${cell.col}`;
      if (seen.has(key)) continue;
      if (!isLegalMove(rootState, cell.row, cell.col, aiPlayer)) continue;
      seen.add(key);
      moves.push({ type: "PLACE", row: cell.row, col: cell.col });
    }
  }

  return moves;
}

/**
 * Seals the opponent can materially take away.
 *
 * Screened through the safe pool: a seal that hands back a capture is not
 * ground gained, and every other override here draws from the same pool for
 * the same reason. Left in `findSealingMoves` order rather than sorted by
 * size — the shortlist goes to a real search, which picks on its own score,
 * and ordering here would only move a tiebreak the arena has not measured.
 */
function urgentSealingMoves(rootState: GameState, aiPlayer: Player): AIAction[] {
  const { pool } = getSafeActions(rootState, aiPlayer);
  const safe = new Set(
    pool
      .filter((action): action is Extract<AIAction, { type: "PLACE" }> => action.type === "PLACE")
      .map((action) => `${action.row},${action.col}`),
  );

  return findSealingMoves(rootState, aiPlayer)
    .filter((seal) => safe.has(`${seal.move.row},${seal.move.col}`))
    .filter((seal) => sealingUrgency(rootState, aiPlayer, seal) >= tuning.urgentSealUrgency)
    .map((seal): AIAction => ({ type: "PLACE", row: seal.move.row, col: seal.move.col }));
}

/**
 * VERY_HARD. Adds a life-and-death reader on top of the general search:
 * it first tries to prove a forced capture, and otherwise discards every
 * candidate that lets the opponent prove one against it. Only what survives
 * is handed to the positional search.
 */
export function findBestMoveVeryHard(
  rootState: GameState,
  aiPlayer: Player,
  timeLimitMs: number,
): AIAction {
  const opening = openingMove(rootState, aiPlayer);
  if (opening) return opening;

  // One forward pass for the position being played, reused by every leaf
  // beneath it. Running the net per leaf would cost more than the search it is
  // meant to inform; at weight zero this does nothing at all.
  primeRootOwnership(rootState, tuning.ownershipWeight > 0);

  const deadline = Date.now() + timeLimitMs;

  const { winningMove, pool: rawPool } = getSafeActions(rootState, aiPlayer);
  if (winningMove) return winningMove;
  if (rawPool.length <= 1) return rawPool[0] ?? { type: "PASS" };
  const thinGuardedPool = selfInflictedThinGuardEnabled
    ? avoidSelfInflictedThin(rootState, aiPlayer, rawPool)
    : rawPool;
  const trapGuardedPool = oneMoveTrapGuardEnabled
    ? avoidOneMoveTraps(rootState, aiPlayer, thinGuardedPool)
    : thinGuardedPool;
  const pool = dominatedPocketGuardEnabled
    ? avoidDominatedPockets(rootState, aiPlayer, trapGuardedPool)
    : trapGuardedPool;

  // Work out whether a large enclosure is about to happen *before* spending any
  // of the budget on reading fights. The plan is pure enumeration and costs
  // 5-45ms against a budget of seconds, so asking early is nearly free — and
  // asking late turned out to lose games. On a phone the reading stages below
  // consume the whole budget before the territorial answer is ever considered:
  // in a game lost 11-22, the opponent had a move settling ten cells, this
  // engine could see it, and it played on the far side of the board instead.
  // Reproduced at a small budget, fixed by not letting the reads go first.
  const plan = planTerritory(rootState, aiPlayer);

  // 1. Can we kill something outright? A forced capture wins the game there and
  //    then, so it still outranks any amount of ground.
  const kill = findForcedCapture(
    rootState,
    aiPlayer,
    CAPTURE_READ_DEPTH,
    timeLimitMs * ATTACK_READ_SHARE,
  );
  if (kill) {
    note("1 forced capture", 1, pool.length);
    return kill.move;
  }

  // 1.5. Is one of my own existing groups already facing a forced capture,
  //    whatever I play elsewhere this turn? The screening in step 2 below
  //    only asks "does *this* candidate create a problem" — it was never
  //    going to notice a problem already sitting on the board that a
  //    candidate simply ignores. Once that's true, defending is the only
  //    question worth asking: the game ends on the next capture regardless
  //    of what else got settled in the meantime, so no amount of ground is
  //    actually a competing option.
  const dangerMoves = existingGroupDanger(rootState, aiPlayer, EXISTING_DANGER_BUDGET_MS);
  if (dangerMoves.length > 0) {
    const dangerBudget = Math.max(300, deadline - Date.now());
    note("1.5 group in danger", dangerMoves.length, pool.length);
    return searchVerified(rootState, aiPlayer, dangerMoves, dangerBudget, pool);
  }

  // 1.75. Nothing is provably forced yet, but is one of my own groups already
  //    thin (three liberties or fewer) with the opponent bordering it, and is
  //    there a move here that actually buys it more room? Catches the gap one
  //    step before existingGroupDanger can prove anything — see
  //    thinGroupDanger's own comment for the traced loss this closes.
  const thinMoves = thinGroupGuardEnabled ? thinGroupDanger(rootState, aiPlayer) : [];
  if (thinMoves.length > 0) {
    const thinBudget = Math.max(300, deadline - Date.now());
    note("1.75 thin group", thinMoves.length, pool.length);
    return searchVerified(rootState, aiPlayer, thinMoves, thinBudget, pool);
  }

  // 1.85. Nothing is thin by liberty count either, but is one of my own
  //    groups sitting in space a single opponent move could seal into a
  //    small, one-sided pocket? Liberty count alone never signals this — see
  //    pocketSealDanger's own comment for the traced loss this closes.
  const pocketSealMoves = pocketSealDangerGuardEnabled ? pocketSealDanger(rootState, aiPlayer) : [];
  if (pocketSealMoves.length > 0) {
    const sealBudget = Math.max(300, deadline - Date.now());
    const withGround = pocketSealTerritoryUnionEnabled
      ? unionWithSeals(rootState, aiPlayer, pocketSealMoves)
      : pocketSealMoves;
    note("1.85 pocket seal danger", withGround.length, pool.length);
    return searchVerified(rootState, aiPlayer, withGround, sealBudget, pool);
  }

  // 1.86. Nothing is in danger. Is there ground here that will not still be
  //    here next turn? `findSealingMoves` has always known how much a move
  //    settles; what it could not say is whether the move keeps. A seal the
  //    opponent can block into something materially smaller is one of the few
  //    territorial moves with a real clock on it, and measured over 20 recorded
  //    games the engine walked past 12 of them for 24 cells while the human
  //    walked past none. Postponable seals are deliberately not offered here —
  //    banking ground that was not going anywhere is what made an earlier
  //    territory term convert nine plies sooner and finish with less.
  const urgentSeals = tuning.urgentSealUrgency > 0 ? urgentSealingMoves(rootState, aiPlayer) : [];
  if (urgentSeals.length > 0) {
    const sealBudget = Math.max(300, deadline - Date.now());
    note("1.86 urgent seal", urgentSeals.length, pool.length);
    return searchVerified(rootState, aiPlayer, urgentSeals, sealBudget, pool);
  }

  // 1.88. Nothing is in danger and nothing is on a clock. Early on, is there a
  //    corner nobody has opened yet, with its professional point still free?
  //
  //    The opening book covers move one and the search decides the rest, and the
  //    two disagree about where to play: over 34 recorded games the human puts
  //    3.32 of their first six stones on the (1,2) point and the engine 1.03,
  //    scattering instead across (1,3), (2,2) and (1,4). Both sides already take
  //    the same number of corners in that span — 2.88 — so what differs is the
  //    point, not the corner.
  //
  //    Placed here rather than beside the book so it can never pre-empt a
  //    tactic: everything above has already declined to fire, so nothing is in
  //    atari, nothing is being sealed into a pocket, and no seal is expiring.
  //
  //    The book move is verified before it is returned. Every other stage that
  //    answers with a shortlist goes through `searchVerified`, which refuses a
  //    choice the opponent can force a capture against; this one returned its
  //    move directly, so it was the one place in the ladder where a move nobody
  //    had read for safety could reach the board. That matters more here than
  //    anywhere else, because the book walks into corners holding up to two
  //    enemy stones by design — it is the stage whose whole job is to enter.
  //    `pool` only screens thin shapes, one-move traps and dominated pockets;
  //    the forced-capture screen is stage 2, below this.
  const cornerPoint = cornerBookEnabled ? cornerBookMove(rootState, aiPlayer, pool) : null;
  if (cornerPoint) {
    const after = applyAction(rootState, cornerPoint);
    const cornerBudget = Math.min(CORNER_BOOK_VERIFY_MS, Math.max(150, deadline - Date.now()));
    if (after.winner || !opponentCanForceCapture(after, aiPlayer, CAPTURE_READ_DEPTH, cornerBudget)) {
      note("1.88 corner point", 1, pool.length);
      return cornerPoint;
    }
  }

  // 1.87. Nothing is in danger. Does the opponent have a corner cut that has
  //    already passed their own security test and is a handful of moves from
  //    done? Unlike my own near-complete frame below, this one has a real
  //    clock on it: theirs stays deniable only until they close it, whereas
  //    mine stays mine (that's what secure means) whether I finish it this
  //    turn or later. So contesting theirs comes first.
  const opponentFrameworkMoves = opponentFrameworkGuardEnabled
    ? opponentFrameworkDenialMoves(rootState, aiPlayer)
    : [];
  if (opponentFrameworkMoves.length > 0) {
    const opponentFrameworkBudget = Math.max(300, deadline - Date.now());
    note("1.87 deny their framework", opponentFrameworkMoves.length, pool.length);
    return searchVerified(rootState, aiPlayer, opponentFrameworkMoves, opponentFrameworkBudget, pool);
  }

  // 1.9. Nothing is in danger. Is there a corner cut of my own that is one or
  //    two cats from done and has already passed the security test — every
  //    invasion killable, no single point the opponent can take it away
  //    with? That is free, keepable ground; finishing it outranks the
  //    ordinary positional search the same way an imminent seal does.
  const frameworkMoves = frameworkGuardEnabled ? frameworkCompletionMoves(rootState, aiPlayer) : [];
  if (frameworkMoves.length > 0) {
    const frameworkBudget = Math.max(300, deadline - Date.now());
    note("1.9 finish my framework", frameworkMoves.length, pool.length);
    return searchVerified(rootState, aiPlayer, frameworkMoves, frameworkBudget, pool);
  }

  // 2. Drop moves that let the opponent kill one of ours by force. Screened in
  //    local-score order so the budget goes to the moves we'd actually play.
  const ranked = [...pool].sort((a, b) => {
    const sa = a.type === "PLACE" ? localMoveScore(rootState.board, a.row, a.col, aiPlayer) : -Infinity;
    const sb = b.type === "PLACE" ? localMoveScore(rootState.board, b.row, b.col, aiPlayer) : -Infinity;
    return sb - sa;
  });

  const screened = ranked.slice(0, DEFEND_SCREEN_LIMIT);
  const screenDeadline = Date.now() + timeLimitMs * DEFEND_READ_SHARE;
  const perMoveMs = Math.max(30, (timeLimitMs * DEFEND_READ_SHARE) / Math.max(1, screened.length));

  // Screening only ever *removes* candidates. A move that was never examined
  // is unproven, not refuted, so it stays in — dropping everything below the
  // screening limit would discard most of the pool untested.
  const refuted = new Set<AIAction>();
  for (const action of screened) {
    if (Date.now() >= screenDeadline) break;
    const next = applyAction(rootState, action);
    if (next.winner === aiPlayer) {
      note("2 wins on the spot", 1, pool.length);
      return action;
    }
    if (next.winner) {
      refuted.add(action); // this move loses on the spot
      continue;
    }
    if (opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, perMoveMs)) {
      refuted.add(action);
    }
  }

  const survivors = ranked.filter((action) => !refuted.has(action));
  // If literally everything is refuted, play the best try rather than nothing.
  const finalPool = survivors.length > 0 ? survivors : ranked;

  const remaining = Math.max(300, deadline - Date.now());

  // 3. Nothing is forced either way, so the game is being decided by who maps
  //    out the bigger share of the board. When the opponent is about to settle
  //    a large area, answering it outranks whatever the general evaluation
  //    would have drifted towards.
  const territorial = territorialCandidates(rootState, aiPlayer, plan, finalPool, remaining);
  if (territorial.length > 0) {
    note("3 territorial answer", territorial.length, finalPool.length);
    return searchVerified(rootState, aiPlayer, territorial, remaining, finalPool);
  }

  // 4. Otherwise the pool is already the right one to hand over: it holds all
  //    but a handful of the legal moves, every contesting move among them.
  //    Whether this plays greedily or quietly is settled by the evaluation, not
  //    by which moves are on offer — measured on a real position, the safe pool
  //    held 67 of 68 legal moves and every move the territory planner wanted,
  //    so adding "contesting" candidates to it changed nothing at all.
  note("4 full search", finalPool.length, finalPool.length);
  return searchVerified(rootState, aiPlayer, finalPool, remaining);
}

/** Share of the remaining budget spent proving invasions are not suicidal. */
const INVASION_CHECK_MS = 60;
const MAX_TERRITORIAL_CANDIDATES = 12;
/** Budget for checking the seal point itself. Only one such check ever runs
 * per call, so it can afford more than the per-candidate budget above —
 * which matters, because a read that thin missed a real forced capture on a
 * real lost game (67ms said safe, 100ms said forced, same position). */
const SEAL_POINT_CHECK_MS = 150;

/**
 * Blocking and expanding moves drawn from the whole-board plan, filtered down
 * to those that are actually playable and don't walk into a forced capture.
 * Returns an empty list when nothing territorial is pressing, letting the
 * ordinary search decide.
 */
function territorialCandidates(
  rootState: GameState,
  aiPlayer: Player,
  plan: TerritoryPlan,
  pool: AIAction[],
  budgetMs: number,
): AIAction[] {
  // Only a concrete, imminent enclosure justifies narrowing the search to
  // territorial answers. Merely trailing on open ground is already priced into
  // the evaluation, and forcing the search to pick from a shortlist in that
  // case cost far more than it gained — VERY_HARD dropped from 75% to 42%
  // against HARD when this fired on nearly half of all moves.
  if (!plan.imminent) return [];

  // Blocking their area comes before finishing mine: their gain is settled
  // ground I can never take back, whereas my own area usually keeps.
  //
  // That ordering used to be expressed by listing the blocking moves first and
  // handing the lot to the search, which is not an ordering at all — the search
  // picks by evaluation, and at shallow depth it happily takes a move settling
  // one cell of its own over one denying ten. That is not hypothetical: in a
  // game lost 11-22, the opponent had a move settling ten cells, this list
  // contained the answer to it, and the engine played an expanding move from
  // the same list instead. So when their threat is the bigger one, it is the
  // only thing on offer.
  const theirGain = plan.theirBestSeal?.gained.length ?? 0;
  const myGain = plan.myBestSeal?.gained.length ?? 0;
  const wanted =
    theirGain > myGain ? plan.blockingMoves : [...plan.blockingMoves, ...plan.expansionMoves];
  if (wanted.length === 0) return [];

  // `pool` has already had the refuted moves removed, so membership in it is
  // itself the "survived screening" test.
  const poolKeys = new Set(
    pool.filter((a) => a.type === "PLACE").map((a) => `${a.row},${a.col}`),
  );

  const deadline = Date.now() + Math.min(budgetMs / 2, INVASION_CHECK_MS * MAX_TERRITORIAL_CANDIDATES);
  const chosen: AIAction[] = [];

  // Occupying the point they need is not an invasion — it is a normal move on a
  // normal empty cell, already vetted by the shared safety check — except that
  // check only ever catches a capture the opponent can finish in one move.
  // Sealing a big enclosure often means planting a stone right where the
  // opponent's wall is thickest, and that is exactly the shape a multi-move
  // forced capture preys on: a real lost game played the seal point straight
  // into one. So it still gets the same tactical read every other candidate
  // here does, just on its own more generous budget, since there is only ever
  // one of it to check and it is the single most important candidate on offer.
  const sealPoint = plan.theirBestSeal?.move;
  if (sealPoint && poolKeys.has(`${sealPoint.row},${sealPoint.col}`)) {
    const sealAction: AIAction = { type: "PLACE", row: sealPoint.row, col: sealPoint.col };
    const next = applyAction(rootState, sealAction);
    if (next.winner === aiPlayer) return [sealAction];
    if (next.winner) {
      // loses on the spot — fall through to whatever else is on offer
    } else if (!opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, SEAL_POINT_CHECK_MS)) {
      chosen.push(sealAction);
    }
  }

  for (const action of wanted) {
    if (chosen.length >= MAX_TERRITORIAL_CANDIDATES || Date.now() >= deadline) break;
    if (action.type !== "PLACE") continue;
    if (!poolKeys.has(`${action.row},${action.col}`)) continue;
    if (sealPoint && action.row === sealPoint.row && action.col === sealPoint.col) continue;

    const next = applyAction(rootState, action);
    if (next.winner === aiPlayer) return [action];
    if (next.winner) continue;
    // An invasion that just gets surrounded is worse than not invading.
    if (opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, INVASION_CHECK_MS)) continue;
    chosen.push(action);
  }

  return chosen;
}

/** Iterative-deepening alpha-beta search, time-boxed to `timeLimitMs`.
 * Blocking/synchronous — run it inside aiWorker.ts so the main thread never
 * stalls on it. */
export function findBestMoveMinimax(
  rootState: GameState,
  aiPlayer: Player,
  timeLimitMs: number,
): AIAction {
  // Start from the same tactical floor every difficulty uses. Search then
  // only has to choose *among safe moves*, so running out of time degrades
  // to NORMAL's standard instead of to a blunder.
  const { winningMove, pool } = getSafeActions(rootState, aiPlayer);
  if (winningMove) return winningMove;
  if (pool.length <= 1) return pool[0] ?? { type: "PASS" };

  return searchWithin(rootState, aiPlayer, pool, timeLimitMs);
}

/** Iterative-deepening root search over an already-chosen candidate pool. */
function searchWithin(
  rootState: GameState,
  aiPlayer: Player,
  pool: AIAction[],
  timeLimitMs: number,
  sharedTt?: TranspositionTable,
): AIAction {
  const deadline = Date.now() + timeLimitMs;
  const tt = sharedTt ?? new TranspositionTable();

  // Rank the pool locally once; deeper iterations reorder via the TT.
  const rootActions = [...pool].sort((a, b) => {
    const sa = a.type === "PLACE" ? localMoveScore(rootState.board, a.row, a.col, aiPlayer) : -Infinity;
    const sb = b.type === "PLACE" ? localMoveScore(rootState.board, b.row, b.col, aiPlayer) : -Infinity;
    return sb - sa;
  });

  let bestAction: AIAction = rootActions[0];
  lastSearchDepth = 0;
  lastSearchScore = 0;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    if (Date.now() >= deadline) break;

    let bestScore = -Infinity;
    let bestAtThisDepth = rootActions[0];
    let completed = true;

    // Try the previous iteration's choice first — it is usually still best,
    // which makes alpha tight immediately and prunes the rest hard.
    const ordered = [bestAction, ...rootActions.filter((a) => a !== bestAction)];

    for (const action of ordered) {
      if (Date.now() >= deadline) {
        completed = false;
        break;
      }

      const child = applyAction(rootState, action);
      // Pass the running best as alpha so later root moves can be pruned;
      // searching every root move from -Infinity throws away all the
      // cutoffs alpha-beta exists to provide.
      const score = child.winner
        ? evaluateState(child, aiPlayer)
        : minimax(child, opponent(aiPlayer), depth - 1, bestScore, Infinity, deadline, tt, aiPlayer);

      if (score > bestScore) {
        bestScore = score;
        bestAtThisDepth = action;
      }
    }

    // A depth cut short by the clock has only looked at a prefix of the move
    // list, so its "best" can be worse than the previous depth's fully
    // searched answer — discard it and keep the older, complete result.
    if (!completed) break;

    bestAction = bestAtThisDepth;
    lastSearchDepth = depth;
    lastSearchScore = bestScore;
    if (bestScore >= WIN_SCORE) break; // forced win found, no need to search deeper
  }

  return bestAction;
}
