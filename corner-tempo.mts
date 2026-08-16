/**
 * Which corner is worth playing in — priced on the whole board.
 *
 * The corner solver answers questions inside one corner. It cannot answer the
 * question that comes before that one: with a stone of my own in an empty
 * corner and an opponent's stone in another, do I finish my pair, answer their
 * corner, or start a third? Those are moves in different corners, so no
 * single-corner model can compare them — the whole point of the choice is what
 * the rest of the board is worth.
 *
 * Each candidate is played out to a count on the full 9x9 many times with play
 * allowed to vary, and every candidate runs on the same seeds, so the
 * comparison is paired and the between-game spread differences away. The
 * numbers are what *this engine* does from the position, which is the right
 * question when the choice is what to teach this engine.
 *
 *   SETUP=B:C2,A:G8 TOMOVE=A CANDIDATES=H7,A2,G2 npx vite-node corner-tempo.mts
 *   ... PLAYOUTS=600 npx vite-node corner-tempo.mts
 */
import { seededRandom } from "./src/games/alley-boss-cats/labelPlayout";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import type { AIAction } from "./src/games/alley-boss-cats/ai";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { FIRST_PLAYER_MARGIN, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/**
 * Play to the end with captures live.
 *
 * `playoutToCount` declines every capture on purpose — it exists to produce a
 * count, and a captured game has nothing to count. That makes it the wrong
 * instrument for choosing a move: in this game one capture ends it, so a move
 * whose stone dies scores there as though it survived. It priced entering a
 * corner the opponent had paired in at +0.51 cells; the engine's own capture
 * reader says every entry into that corner is caught.
 *
 * Returns the result from A's side: a margin when the game is counted, or a
 * win/loss when it ends on a capture.
 */
function playoutWithCaptures(
  start: GameState,
  random: () => number,
  topK: number,
  maxPlies = 220,
): { captured: Player | null; margin: number } {
  let state = start;
  for (let ply = 0; ply < maxPlies && !state.winner; ply += 1) {
    const player = state.currentPlayer;
    const { pool } = getSafeActions(state, player);
    const scored = (pool as AIAction[]).map((action) => {
      const next = applyAction(state, action);
      // A capture wins outright, so it is not one candidate among many.
      const score = next.winner === player ? Infinity : evaluateState(next, player);
      return { next, score };
    });
    if (scored.length === 0) break;
    const limit = Math.min(topK, scored.length);
    for (let slot = 0; slot < limit; slot += 1) {
      let pick = slot;
      for (let i = slot + 1; i < scored.length; i += 1) if (scored[i].score > scored[pick].score) pick = i;
      [scored[slot], scored[pick]] = [scored[pick], scored[slot]];
    }
    // Never sample away a win that is on the board.
    state = scored[0].score === Infinity ? scored[0].next : scored[Math.floor(random() * limit)].next;
  }
  if (state.winner && state.winReason === "CAPTURE") {
    return { captured: state.winner, margin: 0 };
  }
  const t = calculateTerritories(state.board);
  return { captured: null, margin: t.A.length - t.B.length };
}

const COLS = "ABCDEFGHI";
const SIZE = 9;

/** "C2" anywhere on the 9x9, not just inside a study corner. */
function point(name: string): { row: number; col: number } {
  const col = COLS.indexOf(name[0].toUpperCase());
  const row = Number(name.slice(1)) - 1;
  if (col < 0 || !Number.isInteger(row) || row < 0 || row >= SIZE) {
    throw new Error(`not a point on the board: ${name}`);
  }
  return { row, col };
}

/** Corner reference for a point: sorted edge distances, so all four corners read alike. */
function corner(row: number, col: number): string {
  const dr = Math.min(row, SIZE - 1 - row);
  const dc = Math.min(col, SIZE - 1 - col);
  const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
  const side = `${row < SIZE / 2 ? "위" : "아래"}${col < SIZE / 2 ? "왼" : "오"}`;
  return `${side} (${a},${b})`;
}

const SETUP = (process.env.SETUP ?? "B:C2,A:G8").split(",").map((s) => s.trim()).filter(Boolean);
const TOMOVE = (process.env.TOMOVE ?? "A") as Player;
const CANDIDATES = (process.env.CANDIDATES ?? "H7,A2").split(",").map((s) => s.trim()).filter(Boolean);
const PLAYOUTS = Number(process.env.PLAYOUTS ?? 400);
const TOPK = Number(process.env.TOPK ?? 3);

// Stones are placed directly rather than played in turn: the setup describes a
// position, and forcing it into a legal move order would constrain which
// positions can be studied.
const base: GameState = (() => {
  const start = createInitialState();
  const board = start.board.map((r) => [...r]);
  for (const entry of SETUP) {
    const [side, name] = entry.split(":");
    const { row, col } = point(name);
    board[row][col] = playerCell(side.trim().toUpperCase() as Player);
  }
  return { ...start, board, territories: calculateTerritories(board), currentPlayer: TOMOVE };
})();

console.log(`corner tempo — ${PLAYOUTS} playouts each, topK ${TOPK}`);
console.log(`position: ${SETUP.join("  ")}   ${TOMOVE} to move`);
console.log(`win% is ${TOMOVE} winning, captures included; 잡힘 = ${TOMOVE} lost a group, 잡음 = ${TOMOVE} took one.\n`);

/** A won by count when the margin clears the first player's handicap. */
const wonByCount = (marginFromA: number) =>
  TOMOVE === "A" ? marginFromA > FIRST_PLAYER_MARGIN : -marginFromA >= -FIRST_PLAYER_MARGIN;

const results = CANDIDATES.map((name) => {
  const { row, col } = point(name);
  if (!isLegalMove(base, row, col, TOMOVE)) throw new Error(`illegal candidate: ${name}`);
  const start = applyMove({ ...base, currentPlayer: TOMOVE }, row, col);
  const wins: number[] = [];
  let caught = 0;
  let killed = 0;
  for (let run = 0; run < PLAYOUTS; run += 1) {
    const out = playoutWithCaptures(start, seededRandom(1_000_003 + run * 7919), TOPK);
    if (out.captured) {
      if (out.captured === TOMOVE) killed += 1;
      else caught += 1;
      wins.push(out.captured === TOMOVE ? 1 : 0);
    } else {
      wins.push(wonByCount(out.margin) ? 1 : 0);
    }
  }
  const mean = wins.reduce((s, v) => s + v, 0) / wins.length;
  const se = Math.sqrt((mean * (1 - mean)) / wins.length);
  return { name, where: corner(row, col), mean, se, wins, caught, killed };
});

const ranked = [...results].sort((x, y) => y.mean - x.mean);
console.log(
  `${"move".padEnd(7)}${"corner".padEnd(14)}${"win%".padStart(8)}${"± 95%".padStart(8)}${"잡힘".padStart(7)}${"잡음".padStart(7)}`,
);
for (const r of ranked) {
  console.log(
    `${r.name.padEnd(7)}${r.where.padEnd(14)}${(r.mean * 100).toFixed(1).padStart(8)}` +
      `${(1.96 * r.se * 100).toFixed(1).padStart(8)}${String(r.caught).padStart(7)}${String(r.killed).padStart(7)}`,
  );
}

console.log("\npaired differences against the best:");
const top = ranked[0];
for (const other of ranked.slice(1)) {
  const diffs = top.wins.map((v, k) => v - other.wins[k]);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  console.log(
    `  ${top.name} - ${other.name} = ${(mean * 100).toFixed(1)}%p +- ${(1.96 * se * 100).toFixed(1)}` +
      `${Math.abs(mean) > 1.96 * se ? "" : "   — not separated"}`,
  );
}
