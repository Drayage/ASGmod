/**
 * Forcing the split: does it actually end with more territory?
 *
 * The engine holds an oversized room and plays a dividing move in 31% of the
 * positions where one exists, against the human's 63%. The move is in its safe
 * pool 99% of the time, so it is generated and not chosen. That is a difference
 * in behaviour; whether it is a defect needs a causal test, and every candidate
 * in this branch that skipped one turned out not to be worth shipping.
 *
 * So: take the engine's positions where a split existed and it played something
 * else, and play the rest out twice from the same position with the same engine
 * on both sides — once from the move it actually chose, once from the split.
 * Nothing differs but the first move.
 *
 * The continuation is engine self-play, not the human's, so this answers
 * "is the split better against this engine". That is weaker than the real game
 * and stronger than the arena, which invents the positions too.
 *
 * IT DID NOT WORK. Every one of the 43 playouts ended in a capture at 300ms a
 * move, where real games at the shipped 3000ms reach a count 53% of the time.
 * A playout that never reaches a territory count cannot answer a question about
 * territory — the same failure as the arena, arrived at from the other side.
 * Reporting is fixed below so the win/loss split is at least visible, but the
 * territory line will stay empty until a playout can be made to finish by
 * counting, and raising the budget enough to do that costs more than the answer
 * is worth. The dividing move has to be judged in real games instead.
 *
 *   STRIDE=3 PLAYOUT_MS=300 npx vite-node divide-effect.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { AIAction, Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const OVERSIZED = Number(process.env.OVERSIZED ?? 13);
const MIN_HALF = Number(process.env.MIN_HALF ?? 4);
const FROM_TURN = Number(process.env.FROM_TURN ?? 21);
const STRIDE = Number(process.env.STRIDE ?? 3);
const PLAYOUT_MS = Number(process.env.PLAYOUT_MS ?? 300);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 90);

function dominatedRooms(board: Board, side: Player): number[] {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set<string>();
  const out: number[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== "EMPTY" || seen.has(`${row},${col}`)) continue;
      const stack: Coord[] = [{ row, col }];
      seen.add(`${row},${col}`);
      let size = 0, ours = 0, enemy = 0;
      while (stack.length) {
        const cur = stack.pop()!;
        size += 1;
        for (const [dr, dc] of DIRECTIONS) {
          const r = cur.row + dr, c = cur.col + dc;
          if (!inBounds(r, c)) { ours += 1; continue; }
          const cell = board[r][c];
          if (cell === mine) { ours += 1; continue; }
          if (cell === theirs) { enemy += 1; continue; }
          const k = `${r},${c}`;
          if (!seen.has(k)) { seen.add(k); stack.push({ row: r, col: c }); }
        }
      }
      if (ours > enemy) out.push(size);
    }
  }
  return out.sort((a, b) => b - a);
}

/** The split that leaves the smallest largest-room, since conversion falls off
 * with size; ties go to the one keeping more dominated cells overall. */
function bestSplit(state: GameState, mover: Player, current: number): AIAction | null {
  let best: { action: AIAction; top: number; total: number } | null = null;
  for (const mv of getLegalMoves(state, mover)) {
    const board = state.board.map((r) => [...r]);
    board[mv.row][mv.col] = playerCell(mover);
    const after = dominatedRooms(board, mover);
    if (after.length < 2 || after[0] >= current || after[1] < MIN_HALF) continue;
    const total = after.reduce((a, b) => a + b, 0);
    if (!best || after[0] < best.top || (after[0] === best.top && total > best.total)) {
      best = { action: { type: "PLACE", row: mv.row, col: mv.col }, top: after[0], total };
    }
  }
  return best?.action ?? null;
}

/** Play to the end with the same engine on both sides; return the mover's margin. */
function playOut(from: GameState, mover: Player): number {
  let state = from;
  let plies = 0;
  while (!state.winner && plies < MAX_PLIES) {
    const action = findBestMoveVeryHard(state, state.currentPlayer, PLAYOUT_MS);
    state = applyAction(state, action);
    plies += 1;
    if (state.consecutivePasses >= 2) break;
  }
  if (state.winner) return state.winner === mover ? 1000 : -1000;
  const t = calculateTerritories(state.board);
  return t[mover].length - t[opponent(mover)].length;
}

const played: number[] = [];
const split: number[] = [];
let capturedPlayed = 0;
let capturedSplit = 0;
let considered = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    const ai: Player = opponent(rec.playerSide);

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE" || mover !== ai || turn < FROM_TURN) continue;

      const rooms = dominatedRooms(before.board, ai);
      if (rooms.length === 0 || rooms[0] < OVERSIZED) continue;
      const alt = bestSplit(before, ai, rooms[0]);
      if (!alt || alt.type !== "PLACE") continue;
      // Only positions where the engine did something else — where forcing the
      // split actually changes the game.
      if (alt.row === m.row && alt.col === m.col) continue;

      considered += 1;
      if ((considered - 1) % STRIDE !== 0) continue;

      const a = playOut(state, ai);
      const b = playOut(applyAction(before, alt), ai);
      if (a === 1000 || a === -1000) capturedPlayed += 1;
      if (b === 1000 || b === -1000) capturedSplit += 1;
      played.push(a);
      split.push(b);
      if (played.length % 10 === 0) {
        console.log(`  ...${played.length} pairs played out`);
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
// Paired: the same position under both arms, so the difference is the statistic.
// Decided games have to come out of the territory comparison entirely — a pair
// where both arms ended in a capture for the same side differences to zero and
// would otherwise be counted as "level on territory", which it is not.
const decided = (x: number) => Math.abs(x) === 1000;
const counted = split
  .map((s, i) => ({ s, p: played[i] }))
  .filter(({ s, p }) => !decided(s) && !decided(p));
const diffs = counted.map(({ s, p }) => s - p);
const wins = split.filter((x, i) => decided(x) && decided(played[i]));
const splitWon = split.filter((x, i) => decided(x) && decided(played[i]) && x > played[i]).length;
const playedWon = split.filter((x, i) => decided(x) && decided(played[i]) && x < played[i]).length;
console.log(`\npositions where a split existed and the engine played otherwise: ${considered}`);
console.log(`played out (every ${STRIDE}${STRIDE === 1 ? "" : "rd/th"}): ${played.length} pairs at ${PLAYOUT_MS}ms a move`);
console.log(`  games decided by capture — engine's move ${capturedPlayed}, split ${capturedSplit}`);
console.log(
  `  both arms decided by capture: ${wins.length} pairs — split won ${splitWon}, ` +
    `its own move won ${playedWon}, same winner ${wins.length - splitWon - playedWon}`,
);
if (diffs.length <= 1) {
  console.log(`\nno pair reached a territory count: this instrument cannot answer the question`);
}
if (diffs.length > 1) {
  const ci = 1.96 * (sd(diffs) / Math.sqrt(diffs.length));
  const m = mean(diffs);
  console.log(`\nsplit minus the engine's own move: ${m.toFixed(2)} +/- ${ci.toFixed(2)} cells over ${diffs.length} counted pairs`);
  console.log(`  ${Math.abs(m) > ci ? "excludes zero" : "includes zero — no call either way"}`);
  console.log(`  split better in ${diffs.filter((d) => d > 0).length}, worse in ${diffs.filter((d) => d < 0).length}, level in ${diffs.filter((d) => d === 0).length}`);
}
