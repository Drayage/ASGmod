/**
 * The player's follow-up: it is not only that a deeper frame takes n-1 moves
 * before it confirms anything, it is that the number of stones needed before it
 * cannot be killed grows too — and with one capture ending the game, a shape
 * that can still be killed is not a shape you are allowed to own.
 *
 * That is a different quantity from the last measurement. frame-building asked
 * whether an invader lives. This asks whether the defender dies.
 *
 * Safe here means the capture search, moving for the opponent and reading as
 * deep as the engine ever does, finds no forced capture anywhere in the corner.
 * The bill is then the fewest reinforcing stones that buy it, played back to
 * back with the opponent passing — an upper bound on the real cost, and the
 * cheapest way to compare depths on equal terms.
 *
 *   npx vite-node frame-safety.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 9);
const BUDGET = Number(process.env.BUDGET ?? 1500);
const MAX_BILL = Number(process.env.MAX_BILL ?? 2);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

function build(mine: Array<[number, number]>, theirs: Array<[number, number]>, toMove: Player): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

const localMoves = (state: GameState, side: Player, reach: number) =>
  getLegalMoves(state, side).filter((m) => m.row + m.col <= reach);

/** Can the opponent, to move, force a capture anywhere from here? */
const killable = (state: GameState) =>
  findForcedCapture({ ...state, currentPlayer: "B" }, "B", DEPTH, BUDGET) !== null;

/** Fewest liberties any of A's groups in the corner is down to. */
function thinnest(state: GameState): number {
  let least = Infinity;
  const seen = new Set<string>();
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (state.board[row][col] !== playerCell("A")) continue;
      const key = `${row},${col}`;
      if (seen.has(key)) continue;
      const group = getConnectedGroup(state.board, row, col);
      for (const c of group) seen.add(`${c.row},${c.col}`);
      least = Math.min(least, getGroupLiberties(state.board, group).size);
    }
  }
  return least === Infinity ? 0 : least;
}

/** Fewest back-to-back A stones that make the position unkillable, or -1. */
function bill(state: GameState, reach: number): { cost: number; line: string } {
  if (!killable(state)) return { cost: 0, line: "-" };
  let frontier: Array<{ state: GameState; line: string[] }> = [{ state, line: [] }];
  for (let cost = 1; cost <= MAX_BILL; cost += 1) {
    const next: Array<{ state: GameState; line: string[] }> = [];
    for (const node of frontier) {
      for (const mv of localMoves(node.state, "A", reach)) {
        const board = node.state.board.map((r) => [...r]);
        board[mv.row][mv.col] = playerCell("A");
        const after: GameState = {
          ...node.state,
          board,
          territories: calculateTerritories(board),
        };
        const line = [...node.line, nm(mv.row, mv.col)];
        if (!killable(after)) return { cost, line: line.join(" ") };
        next.push({ state: after, line });
      }
    }
    frontier = next;
  }
  return { cost: -1, line: "-" };
}

console.log(`what the shape costs before it cannot be killed — capture read ${DEPTH} deep\n`);
console.log(
  `${"stones".padStart(7)}${"state".padStart(12)}${"groups".padStart(8)}${"thinnest".padStart(10)}` +
    `${"killable".padStart(10)}${"stones to safe".padStart(16)}${"line".padStart(14)}`,
);

for (let n = 2; n <= 6; n += 1) {
  const line: Array<[number, number]> = [];
  for (let a = 0; a <= n - 1; a += 1) line.push([a, n - 1 - a]);
  const reach = n;

  for (const [label, stones] of [
    ["complete", line],
    ["one short", line.slice(0, n - 1)],
  ] as Array<[string, Array<[number, number]>]>) {
    const bare = build(stones, [], "B");
    const groups = new Set<string>();
    for (const [r, c] of stones) {
      const g = getConnectedGroup(bare.board, r, c);
      groups.add(g.map((x) => `${x.row},${x.col}`).sort().join("|"));
    }

    // The shape alone is never under threat — nobody is attacking it. So every
    // stone the opponent could have put in the corner gets tried as the first
    // move of the attack, and what is counted is how many of those leave the
    // defender killable, and what the worst of them costs to answer.
    let checked = 0;
    let exposed = 0;
    let worstCost = 0;
    let worstLine = "-";
    for (const mv of localMoves(bare, "B", reach)) {
      checked += 1;
      const state = build(stones, [[mv.row, mv.col]], "B");
      if (!killable(state)) continue;
      exposed += 1;
      const { cost, line: how } = bill(state, reach);
      if (cost < 0 || cost > worstCost) {
        worstCost = cost;
        worstLine = `${nm(mv.row, mv.col)} -> ${how}`;
      }
    }

    console.log(
      `${String(n).padStart(7)}${label.padStart(12)}${String(groups.size).padStart(8)}` +
        `${String(thinnest(bare)).padStart(10)}` +
        `${`${exposed}/${checked}`.padStart(10)}` +
        `${(worstCost < 0 ? `>${MAX_BILL}` : String(worstCost)).padStart(16)}${worstLine.padStart(20)}`,
    );
  }
}
