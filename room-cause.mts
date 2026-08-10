/**
 * Is holding a large room a cause of being behind, or a symptom of it?
 *
 * §26 read the engine's 18.6-cell room at turn 37, against the human's 11.1, as
 * the thing to fix. Two interventions aimed at fixing it — reshaping the open
 * ground term and rescaling it five-fold — both returned exactly zero, which is
 * what a symptom does when you treat it.
 *
 * The reverse reading is that a large room means a lot of ground still unsettled,
 * and having a lot still unsettled is what being behind looks like. If that is
 * right, then two players level on settled ground should be holding rooms of the
 * same size, and the whole difference is the score talking.
 *
 * So this conditions on the score. For every position it records each side's
 * settled lead and their largest dominated room, and compares human against
 * engine inside bands of lead and game phase, where both start level.
 *
 *   npx vite-node room-cause.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const PHASES = [20, 30, 40] as const;
const LEADS = [-99, -6, -2, 2, 6] as const;
const leadLabel = (i: number) =>
  i === 0 ? "behind 6+" : i === LEADS.length - 1 ? "ahead 6+" : `${LEADS[i]} to ${LEADS[i + 1] - 1}`;

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

const bandOf = (bounds: readonly number[], v: number) => {
  for (let i = bounds.length - 1; i >= 0; i -= 1) if (v >= bounds[i]) return i;
  return 0;
};

/** rooms[phase][lead][side] */
const rooms: number[][][] = PHASES.map(() => LEADS.map(() => []) as unknown as number[][]).map(
  () => LEADS.map(() => []),
) as unknown as number[][][];
const store: Record<string, number[][][]> = { human: [], ai: [] };
for (const k of ["human", "ai"]) {
  store[k] = PHASES.map(() => LEADS.map(() => [] as number[]));
}
void rooms;

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
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });

      let stones = 0;
      for (const row of state.board) for (const cell of row) if (cell !== "EMPTY") stones += 1;
      if (stones < PHASES[0]) continue;
      const phase = bandOf(PHASES, stones);

      for (const side of ["A", "B"] as Player[]) {
        const lead = state.territories[side].length - state.territories[opponent(side)].length;
        const name = side === humanSide ? "human" : "ai";
        store[name][phase][bandOf(LEADS, lead)].push(biggestRoom(state.board, side));
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const phaseLabel = (i: number) =>
  i === PHASES.length - 1 ? `${PHASES[i]}+ stones` : `${PHASES[i]}-${PHASES[i + 1] - 1} stones`;

console.log(
  `largest dominated room, held at the same settled lead — ${games} games decided by the count\n`,
);
for (let p = 0; p < PHASES.length; p += 1) {
  console.log(`${phaseLabel(p)}`);
  console.log(`  ${"settled lead".padEnd(16)}${LEADS.map((_, i) => leadLabel(i).padStart(14)).join("")}`);
  for (const name of ["human", "ai"]) {
    console.log(
      `  ${name.padEnd(16)}` +
        store[name][p]
          .map((xs) => (xs.length ? `${mean(xs).toFixed(1)} (${xs.length})` : "-").padStart(14))
          .join(""),
    );
  }
  console.log(
    `  ${"ai minus human".padEnd(16)}` +
      LEADS.map((_, i) => {
        const a = store["ai"][p][i];
        const h = store["human"][p][i];
        if (a.length < 8 || h.length < 8) return "-".padStart(14);
        const d = mean(a) - mean(h);
        const ci = 1.96 * Math.sqrt(sd(a) ** 2 / a.length + sd(h) ** 2 / h.length);
        return `${d.toFixed(1)} +/-${ci.toFixed(1)}`.padStart(14);
      }).join(""),
  );
  console.log();
}
