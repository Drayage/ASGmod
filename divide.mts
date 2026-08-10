/**
 * Is there a move that divides the oversized room, and does anyone play it?
 *
 * Conversion is a steep function of room size, for both sides alike: a room of
 * six cells or fewer at turn 37 becomes its owner's territory essentially in
 * full, a room of nineteen or more converts at a quarter. What separates the two
 * players is which rooms they are holding by then — the human's largest is 11.1
 * cells and the engine's 18.6.
 *
 * That suggests dividing rather than holding, which would be a move-generation
 * target and not a sixth evaluation term. But it is only a target if the move
 * exists. So this counts, at every position where the mover's largest dominated
 * room is oversized, how many legal moves split it into two dominated rooms that
 * are both worth having — and whether the mover played one.
 *
 *   AT_LEAST=13 npx vite-node divide.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getSafeActions } from "./src/games/alley-boss-cats/ai";
import { orderedCandidates } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
/** A room at or above this size converts badly enough to be worth splitting. */
const OVERSIZED = Number(process.env.OVERSIZED ?? 13);
/** Each half has to be worth keeping, or the split is just a wasted stone. */
const MIN_HALF = Number(process.env.MIN_HALF ?? 4);
const FROM_TURN = Number(process.env.FROM_TURN ?? 21);

/** Sizes of every empty room this side dominates, largest first. */
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

interface Side {
  positions: number;
  withSplit: number;
  splitMoves: number[];
  played: number;
  /** Whether any split reached the engine's own move list — the same question
   * that decided the edge finding, since a move nobody generates is a move
   * nobody can choose. */
  inTop14: number;
  inPool: number;
}
const blank = (): Side => ({ positions: 0, withSplit: 0, splitMoves: [], played: 0, inTop14: 0, inPool: 0 });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;

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
      if (m.type !== "PLACE" || turn < FROM_TURN) continue;

      const rooms = dominatedRooms(before.board, mover);
      if (rooms.length === 0 || rooms[0] < OVERSIZED) continue;
      const side = sides[mover === humanSide ? "human" : "ai"];
      side.positions += 1;

      // A split: after the move, the biggest room is gone and in its place are
      // two the mover still dominates, each worth keeping.
      const splits: string[] = [];
      for (const mv of getLegalMoves(before, mover)) {
        const board = before.board.map((r) => [...r]);
        board[mv.row][mv.col] = playerCell(mover);
        const after = dominatedRooms(board, mover);
        if (after.length < 2) continue;
        if (after[0] >= rooms[0]) continue;
        if (after[1] < MIN_HALF) continue;
        splits.push(`${mv.row},${mv.col}`);
      }
      if (splits.length === 0) continue;
      side.withSplit += 1;
      side.splitMoves.push(splits.length);
      if (splits.includes(`${m.row},${m.col}`)) side.played += 1;
      const top = orderedCandidates(before, mover, 14, undefined, false)
        .map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS"));
      if (splits.some((k) => top.includes(k))) side.inTop14 += 1;
      const pool = getSafeActions(before, mover).pool
        .map((a) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS"));
      if (splits.some((k) => pool.includes(k))) side.inPool += 1;
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(
  `positions from turn ${FROM_TURN} where the mover's largest dominated room is ${OVERSIZED}+ cells,\n` +
    `and a legal move splits it into two dominated rooms of ${MIN_HALF}+ — ${games} games\n`,
);
console.log(
  `${"side".padEnd(8)}${"positions".padStart(11)}${"a split existed".padStart(17)}` +
    `${"splits available".padStart(18)}${"played one".padStart(12)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.positions).padStart(11)}` +
      `${`${s.withSplit} (${pct(s.withSplit, s.positions)})`.padStart(17)}` +
      `${mean(s.splitMoves).toFixed(1).padStart(18)}` +
      `${`${s.played} (${pct(s.played, s.withSplit)})`.padStart(12)}` +
      `${pct(s.inPool, s.withSplit).padStart(14)}${pct(s.inTop14, s.withSplit).padStart(12)}`,
  );
}
