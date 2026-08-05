/**
 * Final-ownership labelling for the territory evaluation dataset.
 *
 * The engine's territory signal today is `influenceCount`: how much open ground
 * each side is closer to. Measured on real games that reach counting, it is a
 * poor stand-in for what the ground becomes — the engine turned 46 cells of
 * reach into 4 of territory while its opponent turned 9 into 17. Reach is not
 * securability, and nothing in the evaluation tells the two apart.
 *
 * What a learned term needs instead is a label for the real thing: for each
 * point, who ends up holding it once the game is actually counted. This module
 * produces that label, and the baselines any model has to beat before it is
 * worth wiring in.
 *
 * Nothing here runs during play. It is dataset and measurement code only.
 */
import { applyAction, getSafeActions, rankByStaticEval } from "./ai";
import type { AIAction } from "./ai";
import { influenceOwnerMap } from "./engine/territoryPlanner";
import { BOARD_SIZE, DIRECTIONS, inBounds, playerCell } from "./types";
import type { Board, GameState, Player } from "./types";

/** Row-major ownership verdict per point: null where nobody holds it. */
export type Ownership = ReadonlyArray<Player | null>;

export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/**
 * Who holds each point in a finished position.
 *
 * Only confirmed territory counts, because only confirmed territory decides the
 * game: a point carrying a cat is not territory for anyone, and open ground
 * nobody walled in is nobody's. That makes the label exactly the quantity the
 * win condition is written in.
 */
export function ownershipFromState(state: GameState): Ownership {
  const owners: Array<Player | null> = new Array(CELL_COUNT).fill(null);
  for (const side of ["A", "B"] as const) {
    for (const { row, col } of state.territories[side]) owners[row * BOARD_SIZE + col] = side;
  }
  return owners;
}

/** Final territory margin from `player`'s side, in cells. */
export function territoryMargin(state: GameState, player: Player): number {
  const other = player === "A" ? "B" : "A";
  return state.territories[player].length - state.territories[other].length;
}

export interface ScoringPlayout {
  state: GameState;
  /** Plies the completion itself added. Zero when the game already counted. */
  addedPlies: number;
  /** True when the completion hit its ply cap rather than both sides passing. */
  cappedOut: boolean;
}

/**
 * Play a position out until the board can be counted, never ending it on a
 * capture.
 *
 * A capture wins outright here, so most games stop long before the ground is
 * settled — 71% of engine self-play by measurement. Those games carry no final
 * ownership to learn from, and the ones that do are exactly the games the
 * engine keeps losing. So the completion declines capture wins: it asks how the
 * ground would divide if the game were counted, which is the question the
 * evaluation term needs answered.
 *
 * Declining a win is a counterfactual, and worth being honest about — a
 * position reached because one side blundered into a lost group is not a
 * position strong play produces. Generating with `suppressCaptureWins` from the
 * first ply avoids that splice entirely and is the default for that reason;
 * completing an already-captured game is offered for comparison.
 *
 * Moves come from the shared safety pool ranked by static evaluation rather
 * than from a search. The completion decides how already-drawn borders resolve,
 * not how the game is played, and a search here would cost more than generating
 * the games did.
 */
export function completeToScoring(start: GameState, maxPlies = 200): ScoringPlayout {
  // A game that already reached a count needs nothing: its territory is the
  // label. Only a capture finish has to be set aside, and doing that means
  // clearing the win a finished game would otherwise refuse to play on from.
  // Passes reset with it, so the pair that ended the game cannot immediately
  // end the continuation too.
  if (start.winner && start.winReason !== "CAPTURE") {
    return { state: start, addedPlies: 0, cappedOut: false };
  }
  let state: GameState = start.winner
    ? { ...start, winner: null, winReason: null, capturedGroup: undefined, consecutivePasses: 0 }
    : start;

  let addedPlies = 0;
  while (!state.winner && addedPlies < maxPlies) {
    const player = state.currentPlayer;
    const { pool } = getSafeActions(state, player);
    const scoring = pool.filter((action) => !endsOnCapture(state, action));
    // Everything left wins by capture: nothing can be declined, so let it end.
    const usable = scoring.length > 0 ? scoring : pool;
    const [best] = rankByStaticEval(state, player, usable);
    if (!best) break;
    state = applyAction(state, best);
    addedPlies += 1;
  }

  return { state, addedPlies, cappedOut: !state.winner };
}

function endsOnCapture(state: GameState, action: AIAction): boolean {
  const next = applyAction(state, action);
  return next.winner !== null && next.winReason === "CAPTURE";
}

/**
 * The move a data-generation game plays when capture wins are being declined
 * from the start, or null when the caller's own engine should choose.
 *
 * Returns null unless the engine's pick would end the game on a capture, so the
 * generated game is the engine's own play everywhere it does not hinge on
 * taking a win.
 */
export function withoutCaptureWin(
  state: GameState,
  player: Player,
  chosen: AIAction,
): AIAction | null {
  if (!endsOnCapture(state, chosen)) return null;
  const { pool } = getSafeActions(state, player);
  const scoring = pool.filter((action) => !endsOnCapture(state, action));
  if (scoring.length === 0) return null;
  return rankByStaticEval(state, player, scoring)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Baselines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the shipped signal predicts, read as an ownership map: the side heading
 * towards each point. This is the bar a learned term has to clear — it is the
 * territory judgement the evaluation makes today.
 */
export function predictByInfluence(board: Board): Ownership {
  return influenceOwnerMap(board);
}

/**
 * Nearest cat through open ground, with no reach limit.
 *
 * `influenceOwnerMap` stops looking three steps out, which is deliberate for an
 * evaluation term but means it calls the middle of an open board contested. A
 * baseline without that cap separates "the cap is costing us" from "distance to
 * the nearest cat is the wrong idea".
 */
export function predictByNearestCat(board: Board): Ownership {
  const distA = openDistanceField(board, "A");
  const distB = openDistanceField(board, "B");
  const owners: Array<Player | null> = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== "EMPTY") {
        owners.push(null);
        continue;
      }
      const a = distA[row][col];
      const b = distB[row][col];
      owners.push(a === b ? null : a < b ? "A" : "B");
    }
  }
  return owners;
}

/** Territory already confirmed at this position, and nothing else. */
export function predictBySettledTerritory(state: GameState): Ownership {
  return ownershipFromState(state);
}

/** Nobody holds anything. The floor every other predictor must beat. */
export function predictNeutral(): Ownership {
  return new Array(CELL_COUNT).fill(null);
}

function openDistanceField(board: Board, player: Player): number[][] {
  const dist: number[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array<number>(BOARD_SIZE).fill(Number.POSITIVE_INFINITY),
  );
  const own = playerCell(player);
  const queue: Array<[number, number]> = [];
  const open = (r: number, c: number) => inBounds(r, c) && board[r][c] === "EMPTY";

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== own) continue;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (!open(r, c) || dist[r][c] <= 1) continue;
        dist[r][c] = 1;
        queue.push([r, c]);
      }
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const [row, col] = queue[head];
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!open(r, c) || dist[r][c] <= dist[row][col] + 1) continue;
      dist[r][c] = dist[row][col] + 1;
      queue.push([r, c]);
    }
  }

  return dist;
}

export interface OwnershipAccuracy {
  /** Every point, including the ones carrying a cat. */
  allCells: { correct: number; total: number; percent: number };
  /**
   * Only points still open at the position being judged.
   *
   * The honest number. An occupied point can never become territory, so
   * predicting "nobody" there is free, and on a busy board that free credit is
   * most of the score.
   */
  openCells: { correct: number; total: number; percent: number };
}

export function ownershipAccuracy(
  board: Board,
  predicted: Ownership,
  actual: Ownership,
): OwnershipAccuracy {
  let allCorrect = 0;
  let openCorrect = 0;
  let openTotal = 0;

  for (let index = 0; index < CELL_COUNT; index++) {
    const hit = predicted[index] === actual[index];
    if (hit) allCorrect += 1;
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
    if (board[row][col] === "EMPTY") {
      openTotal += 1;
      if (hit) openCorrect += 1;
    }
  }

  return {
    allCells: {
      correct: allCorrect,
      total: CELL_COUNT,
      percent: percent(allCorrect, CELL_COUNT),
    },
    openCells: { correct: openCorrect, total: openTotal, percent: percent(openCorrect, openTotal) },
  };
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Number(((part / whole) * 100).toFixed(4));
}

export interface OwnershipClassScore {
  /** Points the label says this side holds. */
  actual: number;
  /** Points the predictor claimed for this side. */
  predicted: number;
  /** Claimed and held. */
  hit: number;
  /** Of the points this side really holds, the share the predictor found. */
  recallPercent: number;
  /** Of the points it claimed for this side, the share that were really theirs. */
  precisionPercent: number;
}

/**
 * Per-side precision and recall over open points, which plain accuracy hides.
 *
 * Roughly five in six points end up nobody's — most of the board is carrying a
 * cat by the time the game is counted — so a predictor that never claims
 * anything already scores well above 80%. Accuracy alone therefore cannot tell
 * a useful territory signal from a silent one, and it is the claims that the
 * evaluation actually spends moves on. Recall says how much of the real
 * territory a signal saw; precision says how much of what it claimed was ever
 * going to be held. The shipped `influenceCount` is generous on the first and
 * poor on the second, which is the sprawl it rewards, stated per point.
 */
export function ownershipClassScores(
  board: Board,
  predicted: Ownership,
  actual: Ownership,
): Record<Player, OwnershipClassScore> {
  const blank = (): OwnershipClassScore => ({
    actual: 0,
    predicted: 0,
    hit: 0,
    recallPercent: 0,
    precisionPercent: 0,
  });
  const scores: Record<Player, OwnershipClassScore> = { A: blank(), B: blank() };

  for (let index = 0; index < CELL_COUNT; index++) {
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
    if (board[row][col] !== "EMPTY") continue;
    for (const side of ["A", "B"] as const) {
      const isActual = actual[index] === side;
      const isPredicted = predicted[index] === side;
      if (isActual) scores[side].actual += 1;
      if (isPredicted) scores[side].predicted += 1;
      if (isActual && isPredicted) scores[side].hit += 1;
    }
  }

  for (const side of ["A", "B"] as const) {
    scores[side].recallPercent = percent(scores[side].hit, scores[side].actual);
    scores[side].precisionPercent = percent(scores[side].hit, scores[side].predicted);
  }
  return scores;
}

/* -------------------------------------------------------------------------- */
/* Symmetry                                                                    */
/* -------------------------------------------------------------------------- */

/** The eight ways a square board maps onto itself. */
export const SYMMETRY_COUNT = 8;

/** Where the point at (row, col) lands under symmetry `sym`. */
export function mapCoord(row: number, col: number, sym: number): [number, number] {
  const last = BOARD_SIZE - 1;
  switch (sym & 7) {
    case 0:
      return [row, col];
    case 1:
      return [col, last - row];
    case 2:
      return [last - row, last - col];
    case 3:
      return [last - col, row];
    case 4:
      return [row, last - col];
    case 5:
      return [last - row, col];
    case 6:
      return [col, row];
    default:
      return [last - col, last - row];
  }
}

export function transformBoard(board: Board, sym: number): Board {
  const out: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill("EMPTY"),
  ) as Board;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const [r, c] = mapCoord(row, col, sym);
      out[r][c] = board[row][col];
    }
  }
  return out;
}

export function transformOwnership(owners: Ownership, sym: number): Ownership {
  const out: Array<Player | null> = new Array(CELL_COUNT).fill(null);
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const [r, c] = mapCoord(row, col, sym);
      out[r * BOARD_SIZE + c] = owners[row * BOARD_SIZE + col];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/** One character per point: `.` open, `A`/`B` a cat, `N` a neutral point. */
export function encodeBoard(board: Board): string {
  let out = "";
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cell = board[row][col];
      out += cell === "EMPTY" ? "." : cell === "PLAYER_A" ? "A" : cell === "PLAYER_B" ? "B" : "N";
    }
  }
  return out;
}

/** One character per point: `A`/`B` for the holder, `.` for nobody. */
export function encodeOwnership(owners: Ownership): string {
  let out = "";
  for (const owner of owners) out += owner ?? ".";
  return out;
}

export function decodeOwnership(encoded: string): Ownership {
  const owners: Array<Player | null> = [];
  for (const character of encoded) {
    owners.push(character === "A" ? "A" : character === "B" ? "B" : null);
  }
  return owners;
}
