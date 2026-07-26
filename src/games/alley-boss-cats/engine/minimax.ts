import { applyAction, candidateActions, evaluateState, getSafeActions } from "../ai";
import type { AIAction } from "../ai";
import { getConnectedGroup, getGroupLiberties } from "../groups";
import { isLegalMove } from "../rules";
import { opponent } from "../types";
import type { Board, GameState, Player } from "../types";
import { findForcedCapture, opponentCanForceCapture } from "./captureSearch";
import { localMoveScore, orderedCandidates } from "./moveOrdering";
import { planTerritory } from "./territoryPlanner";
import type { TerritoryPlan } from "./territoryPlanner";
import { TranspositionTable } from "./transpositionTable";

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
function branchLimit(remainingDepth: number): number {
  if (remainingDepth >= 5) return 14;
  if (remainingDepth === 4) return 12;
  if (remainingDepth === 3) return 10;
  if (remainingDepth === 2) return 8;
  return 6;
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
  const actions = orderedCandidates(
    state,
    playerToMove,
    branchLimit(remainingDepth),
    tt.getBestMoveKey(key),
  );
  if (actions.length === 0) return evaluateState(state, rootPlayer);

  const maximizing = playerToMove === rootPlayer;
  let best = maximizing ? -Infinity : Infinity;
  let bestActionKey: string | null = null;

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
    if (Date.now() >= deadline) break;
  }

  if (bestActionKey) tt.setBestMoveKey(key, bestActionKey);
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
  const candidates: AIAction[] = [];
  for (const liberty of liberties) {
    const [row, col] = liberty.split(",").map(Number);
    if (isLegalMove(rootState, row, col, aiPlayer)) candidates.push({ type: "PLACE", row, col });
  }
  return candidates;
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

  for (let attempt = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
    if (candidates.length === 0) {
      if (hasWidened || !widenTo || widenTo.length === 0) break;
      candidates = widenTo;
      hasWidened = true;
    }

    const timeLeft = Math.max(150, deadline - Date.now());
    const verifyBudget = Math.min(VERIFY_BUDGET_CAP_MS, Math.max(VERIFY_BUDGET_FLOOR_MS, timeLeft * VERIFY_SHARE));
    const searchBudget = Math.max(150, timeLeft - verifyBudget);

    choice = searchWithin(rootState, aiPlayer, candidates, searchBudget);
    const next = applyAction(rootState, choice);
    if (next.winner || !opponentCanForceCapture(next, aiPlayer, CAPTURE_READ_DEPTH, verifyBudget)) {
      return choice;
    }
    candidates = candidates.filter((action) => action !== choice);
  }

  // Every attempt was refuted — nothing left to offer but the last one tried.
  return choice;
}

/** Tolerance for treating two opening scores as the same move, not a strictly
 * better/worse one. Exact equality would do given these are computed from
 * the same deterministic board, but a tiny epsilon guards against float
 * drift ever splitting what should be one tied group into near-duplicates. */
const OPENING_TIE_EPSILON = 1e-6;

/**
 * On a genuinely empty board the position is rotationally and reflectively
 * symmetric, so a corner-ish point always ties three mirror images of
 * itself — there is no principled reason the search should keep answering
 * with the same one of the four every game. Ranks every legal opening by
 * the same one-ply evaluation the rest of the engine trusts, then picks
 * uniformly among whatever actually ties for best, the same way EASY
 * already randomises among its own top candidates. Only fires on move one:
 * past that the board is no longer symmetric, and the real search should
 * decide.
 */
function openingMove(rootState: GameState, aiPlayer: Player): AIAction | null {
  const boardIsEmpty = rootState.board.every((row) =>
    row.every((cell) => cell !== "PLAYER_A" && cell !== "PLAYER_B"),
  );
  if (!boardIsEmpty) return null;

  const placements = candidateActions(rootState, aiPlayer).filter(
    (action): action is Extract<AIAction, { type: "PLACE" }> => action.type === "PLACE",
  );
  if (placements.length === 0) return null;

  const ranked = placements
    .map((action) => ({ action, score: evaluateState(applyAction(rootState, action), aiPlayer) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0].score;
  const top = ranked.filter((r) => Math.abs(r.score - best) < OPENING_TIE_EPSILON);
  return top[Math.floor(Math.random() * top.length)].action;
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

  const deadline = Date.now() + timeLimitMs;

  const { winningMove, pool } = getSafeActions(rootState, aiPlayer);
  if (winningMove) return winningMove;
  if (pool.length <= 1) return pool[0] ?? { type: "PASS" };

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
  if (kill) return kill.move;

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
    return searchVerified(rootState, aiPlayer, dangerMoves, dangerBudget, pool);
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
    if (next.winner === aiPlayer) return action;
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
    return searchVerified(rootState, aiPlayer, territorial, remaining, finalPool);
  }

  // 4. Otherwise the pool is already the right one to hand over: it holds all
  //    but a handful of the legal moves, every contesting move among them.
  //    Whether this plays greedily or quietly is settled by the evaluation, not
  //    by which moves are on offer — measured on a real position, the safe pool
  //    held 67 of 68 legal moves and every move the territory planner wanted,
  //    so adding "contesting" candidates to it changed nothing at all.
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
): AIAction {
  const deadline = Date.now() + timeLimitMs;
  const tt = new TranspositionTable();

  // Rank the pool locally once; deeper iterations reorder via the TT.
  const rootActions = [...pool].sort((a, b) => {
    const sa = a.type === "PLACE" ? localMoveScore(rootState.board, a.row, a.col, aiPlayer) : -Infinity;
    const sb = b.type === "PLACE" ? localMoveScore(rootState.board, b.row, b.col, aiPlayer) : -Infinity;
    return sb - sa;
  });

  let bestAction: AIAction = rootActions[0];
  lastSearchDepth = 0;

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
    if (bestScore >= WIN_SCORE) break; // forced win found, no need to search deeper
  }

  return bestAction;
}
