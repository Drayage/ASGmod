/**
 * When does the human get a big room and the engine not?
 *
 * At the moment of declining a seal, the human's pocket opens onto a room of 46
 * empty cells at the median and the engine's onto 4. That is the same move in
 * two different situations: the human is holding an option on a large frame,
 * the engine is leaving a two-cell corner in a four-cell hole where nothing can
 * grow. It also explains the region gap — the engine makes 0.18 regions of six
 * cells or more a game because it never owns the space one would come from.
 *
 * So this drops the seals and asks the prior question directly: turn by turn,
 * how large is the biggest empty room each side dominates? A room is a
 * connected patch of empty cells; a side dominates it when its own stones and
 * the board edge make up more of the boundary than the opponent's do.
 *
 *   npx vite-node room-timeline.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const BANDS = [1, 11, 21, 31, 41, 51] as const;

/** The largest empty room whose boundary is mostly this side's, and its size. */
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
      let size = 0;
      let ours = 0;
      let enemy = 0;
      while (stack.length) {
        const cur = stack.pop()!;
        size += 1;
        for (const [dr, dc] of DIRECTIONS) {
          const r = cur.row + dr, c = cur.col + dc;
          if (!inBounds(r, c)) { ours += 1; continue; } // the edge walls for whoever is there
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

const bandOf = (turn: number) => {
  for (let i = BANDS.length - 1; i >= 0; i -= 1) if (turn >= BANDS[i]) return i;
  return 0;
};
const human: number[][] = BANDS.map(() => []);
const ai: number[][] = BANDS.map(() => []);

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;
    const aiSide = opponent(humanSide);

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      turn += 1;
      const b = bandOf(turn);
      human[b].push(biggestRoom(state.board, humanSide));
      ai[b].push(biggestRoom(state.board, aiSide));
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const label = (i: number) => (i === BANDS.length - 1 ? `${BANDS[i]}+` : `${BANDS[i]}-${BANDS[i + 1] - 1}`);
console.log(`biggest empty room each side dominates, over ${games} games decided by the count\n`);
console.log(`${"turns".padEnd(10)}${BANDS.map((_, i) => label(i).padStart(9)).join("")}`);
const row = (name: string, data: number[][]) =>
  console.log(`${name.padEnd(10)}${data.map((xs) => (xs.length ? mean(xs).toFixed(1) : "-").padStart(9)).join("")}`);
row("human", human);
row("AI", ai);
console.log(
  `${"gap".padEnd(10)}` +
    human.map((xs, i) => (xs.length && ai[i].length ? (mean(xs) - mean(ai[i])).toFixed(1) : "-").padStart(9)).join(""),
);
