/**
 * Does the region curve make the engine play the dividing move?
 *
 * `split-effect.mts` measured the largest room right after the move and saw
 * nothing — 29.5 cells against 29.6. That is too blunt a test: one stone rarely
 * moves the largest room at all unless it happens to divide it, and most of the
 * sampled positions had no division available in the first place.
 *
 * So this asks the behavioural question directly, on the positions where the
 * question exists: the mover holds an oversized room, some legal move splits it
 * into two it still dominates, and the engine chooses with the curve off and
 * then on. Recorded play puts that rate at 31% against the human's 63%.
 *
 *   STRIDE=3 npx vite-node split-rate.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions, tuning } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const STRIDE = Number(process.env.STRIDE ?? 3);
const OVERSIZED = Number(process.env.OVERSIZED ?? 13);
const MIN_HALF = Number(process.env.MIN_HALF ?? 4);
const FROM_TURN = Number(process.env.FROM_TURN ?? 21);

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

function splitKeys(state: GameState, mover: Player, current: number): Set<string> {
  const keys = new Set<string>();
  for (const mv of getLegalMoves(state, mover)) {
    const board = state.board.map((r) => [...r]);
    board[mv.row][mv.col] = playerCell(mover);
    const after = dominatedRooms(board, mover);
    if (after.length < 2 || after[0] >= current || after[1] < MIN_HALF) continue;
    keys.add(`${mv.row},${mv.col}`);
  }
  return keys;
}

const cases: Array<{ state: GameState; player: Player; splits: Set<string>; top: number }> = [];
const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
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
      const splits = splitKeys(before, ai, rooms[0]);
      if (splits.size === 0) continue;
      cases.push({ state: before, player: ai, splits, top: rooms[0] });
    }
  }
}

const key = (a: any) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS");
const tookSplit: Record<string, number> = { true: 0, false: 0 };
const newTop: Record<string, number[]> = { true: [], false: [] };
let considered = 0;
cases.forEach((c, i) => {
  if (i % STRIDE !== 0) return;
  if (getSafeActions(c.state, c.player).winningMove) return;
  considered += 1;
  for (const on of i % 2 === 0 ? [false, true] : [true, false]) {
    tuning.influenceRegionCurve = on;
    const chosen = findBestMoveVeryHard(c.state, c.player, BUDGET);
    if (c.splits.has(key(chosen))) tookSplit[String(on)] += 1;
    newTop[String(on)].push(dominatedRooms(applyAction(c.state, chosen).board, c.player)[0] ?? 0);
  }
  if (considered % 15 === 0) {
    console.log(`  ...${considered} decided — off ${tookSplit["false"]}, on ${tookSplit["true"]}`);
  }
});
tuning.influenceRegionCurve = false;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`\npositions with an oversized room and a split available: ${cases.length}, decided ${considered} at ${BUDGET}ms`);
console.log(`  played a split   off ${tookSplit["false"]} (${pct(tookSplit["false"], considered)})   on ${tookSplit["true"]} (${pct(tookSplit["true"], considered)})`);
console.log(`  largest room after  off ${mean(newTop["false"]).toFixed(1)}   on ${mean(newTop["true"]).toFixed(1)}`);
console.log(`  (recorded play: engine 31%, human 63%)`);
