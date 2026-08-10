/**
 * Why the region curve did not promote the dividing move.
 *
 * Pricing open ground by region size changed 18% of the engine's moves and cost
 * nothing in depth, but the rate at which it plays a dividing move went from 35%
 * to 30% — down, not up — and the room it is left holding did not shrink.
 *
 * The likely reason is a mismatch of definitions, and it is cheap to check. A
 * "split" was defined on dominated rooms: connected empty cells whose boundary
 * is mostly the mover's. The curve is applied to influence regions: connected
 * cells the distance field says the mover reaches first. Those are two different
 * partitions of the same board, and a stone that divides one need not divide the
 * other. If splits do not raise the weighted influence, no weighting of it can
 * make the search prefer them.
 *
 *   npx vite-node split-scores.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import {
  influenceCountFromMap,
  influenceCountWeightedFromMap,
  influenceOwnerMap,
} from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

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

const splitPlain: number[] = [];
const splitCurve: number[] = [];
const otherPlain: number[] = [];
const otherCurve: number[] = [];
let positions = 0;

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

      const baseOwners = influenceOwnerMap(before.board);
      const basePlain = influenceCountFromMap(baseOwners);
      const baseCurve = influenceCountWeightedFromMap(baseOwners);
      let any = false;
      for (const mv of getLegalMoves(before, ai)) {
        const board = before.board.map((r) => [...r]);
        board[mv.row][mv.col] = playerCell(ai);
        const after = dominatedRooms(board, ai);
        const isSplit = after.length >= 2 && after[0] < rooms[0] && after[1] >= MIN_HALF;
        const owners = influenceOwnerMap(board);
        const plain = influenceCountFromMap(owners)[ai] - basePlain[ai];
        const curve = influenceCountWeightedFromMap(owners)[ai] - baseCurve[ai];
        if (isSplit) { splitPlain.push(plain); splitCurve.push(curve); any = true; }
        else { otherPlain.push(plain); otherCurve.push(curve); }
      }
      if (any) positions += 1;
    }
  }
}

void tuning;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`change in the mover's own open-ground score, per candidate move\n${positions} positions with an oversized room and a split available\n`);
console.log(`${"move".padEnd(10)}${"n".padStart(8)}${"flat count".padStart(14)}${"region curve".padStart(15)}`);
console.log(`${"split".padEnd(10)}${String(splitPlain.length).padStart(8)}${mean(splitPlain).toFixed(2).padStart(14)}${mean(splitCurve).toFixed(2).padStart(15)}`);
console.log(`${"other".padEnd(10)}${String(otherPlain.length).padStart(8)}${mean(otherPlain).toFixed(2).padStart(14)}${mean(otherCurve).toFixed(2).padStart(15)}`);
console.log(
  `\nsplit minus other: flat ${(mean(splitPlain) - mean(otherPlain)).toFixed(2)}, ` +
    `curve ${(mean(splitCurve) - mean(otherCurve)).toFixed(2)}`,
);
console.log(`  the curve helps the dividing move only if that second number is the larger one`);
