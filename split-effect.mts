/**
 * Does pricing open ground by region size change what the engine plays?
 *
 * The term is an evaluation change, not a candidate one, so there is no firing
 * rate to count — it is consulted at every leaf. What there is to check, in the
 * order this branch learned to check things: whether the engine's move actually
 * changes, what it costs in search depth, and whether the rooms it ends up
 * holding get smaller, which is the thing the change is for.
 *
 *   STRIDE=4 npx vite-node split-effect.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions, tuning } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastSearchDepth } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const BUDGET = Number(process.env.BUDGET ?? 3000);
const STRIDE = Number(process.env.STRIDE ?? 4);
const FROM_TURN = Number(process.env.FROM_TURN ?? 1);

/** Largest empty room this side walls more of than the other. */
function biggestRoom(board: Board, side: Player): number {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set<string>();
  let best = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== "EMPTY" || seen.has(`${row},${col}`)) continue;
      const stack = [{ row, col }];
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
      if (ours > enemy && size > best) best = size;
    }
  }
  return best;
}

const positions: Array<{ state: GameState; player: Player }> = [];
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
      turn += 1;
      if (state.currentPlayer === ai && turn >= FROM_TURN) positions.push({ state, player: ai });
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const key = (a: any) => (a.type === "PLACE" ? `${a.row},${a.col}` : "PASS");
const depths: Record<string, number[]> = { true: [], false: [] };
const roomAfter: Record<string, number[]> = { true: [], false: [] };
let changed = 0;
let considered = 0;

positions.forEach(({ state, player }, i) => {
  if (i % STRIDE !== 0) return;
  if (getSafeActions(state, player).winningMove) return;
  considered += 1;
  const runs = i % 2 === 0 ? [false, true] : [true, false];
  const got: Record<string, string> = {};
  for (const on of runs) {
    tuning.influenceRegionCurve = on;
    const chosen = findBestMoveVeryHard(state, player, BUDGET);
    got[String(on)] = key(chosen);
    depths[String(on)].push(lastSearchDepth);
    roomAfter[String(on)].push(biggestRoom(applyAction(state, chosen).board, player));
  }
  if (got["true"] !== got["false"]) changed += 1;
  if (considered % 25 === 0) console.log(`  ...${considered} decided, ${changed} changed`);
});
tuning.influenceRegionCurve = false;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`\nat ${BUDGET}ms over ${considered} positions from turn ${FROM_TURN}`);
console.log(`  move changed        : ${changed} (${pct(changed, considered)})`);
console.log(`  search depth  off ${mean(depths["false"]).toFixed(2)}  on ${mean(depths["true"]).toFixed(2)}  (${(mean(depths["true"]) - mean(depths["false"])).toFixed(2)} ply)`);
console.log(`  largest own room after the move  off ${mean(roomAfter["false"]).toFixed(1)}  on ${mean(roomAfter["true"]).toFixed(1)}`);
