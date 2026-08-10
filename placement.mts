/**
 * Where each side puts a stone relative to its own.
 *
 * The seal supply peels back one layer at a time and each layer says the same
 * thing: the human is at distance zero or one from a four-cell seal on 58% of
 * middle-game turns and the engine on 21%, and when a threat-making move does
 * exist both sides play one about as often (29% against 21%). So the difference
 * is not any single choice — it is that the engine's stones do not arrive in
 * shapes that can be closed.
 *
 * That is a claim about placement, and placement can be measured directly:
 * for every stone, how far it lands from the nearest stone of its own, and how
 * many separate clusters each side is running. Conditioned on the settled score,
 * because that control is what separated a real finding from a symptom twice
 * now.
 *
 *   npx vite-node placement.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const BANDS = [1, 11, 21, 31, 41] as const;
const label = (i: number) => (i === BANDS.length - 1 ? `${BANDS[i]}+` : `${BANDS[i]}-${BANDS[i + 1] - 1}`);
const bandOf = (t: number) => {
  for (let i = BANDS.length - 1; i >= 0; i -= 1) if (t >= BANDS[i]) return i;
  return 0;
};

/** Diagonal-connected groups of one side's stones — how many separate lumps. */
function clusters(board: Board, side: Player): number {
  const own = playerCell(side);
  const seen = new Set<string>();
  let count = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== own || seen.has(`${row},${col}`)) continue;
      count += 1;
      const stack = [{ row, col }];
      seen.add(`${row},${col}`);
      while (stack.length) {
        const cur = stack.pop()!;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const r = cur.row + dr, c = cur.col + dc;
            if (!inBounds(r, c) || seen.has(`${r},${c}`)) continue;
            if (board[r][c] !== own) continue;
            seen.add(`${r},${c}`);
            stack.push({ row: r, col: c });
          }
        }
      }
    }
  }
  return count;
}

const dist: Record<string, number[][]> = { human: BANDS.map(() => []), ai: BANDS.map(() => []) };
const lumps: Record<string, number[][]> = { human: BANDS.map(() => []), ai: BANDS.map(() => []) };
const levelDist: Record<string, number[]> = { human: [], ai: [] };
const levelLumps: Record<string, number[]> = { human: [], ai: [] };
/**
 * And the distance to the nearest *enemy* stone. `localMoveScore` pays +6 for
 * every enemy stone a move touches and +130 or +900 for threatening one, so the
 * ordering pulls the engine towards the opponent. A side that always plays next
 * to the other side never gets to enclose anything, which would produce the seal
 * supply gap without any difference in how far it plays from its own.
 */
const levelEnemy: Record<string, number[]> = { human: [], ai: [] };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const human: Player = rec.playerSide;

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
      if (m.type !== "PLACE") continue;

      const own = playerCell(mover);
      let nearest = Infinity;
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          if (before.board[row][col] !== own) continue;
          nearest = Math.min(nearest, Math.max(Math.abs(row - m.row), Math.abs(col - m.col)));
        }
      }
      if (!Number.isFinite(nearest)) continue;

      const name = mover === human ? "human" : "ai";
      const b = bandOf(turn);
      dist[name][b].push(nearest);
      lumps[name][b].push(clusters(state.board, mover));
      const lead = before.territories[mover].length - before.territories[opponent(mover)].length;
      if (lead >= -2 && lead <= 1 && turn >= 11 && turn <= 40) {
        levelDist[name].push(nearest);
        levelLumps[name].push(clusters(state.board, mover));
        const foe = playerCell(opponent(mover));
        let nearestFoe = Infinity;
        for (let row = 0; row < BOARD_SIZE; row += 1) {
          for (let col = 0; col < BOARD_SIZE; col += 1) {
            if (before.board[row][col] !== foe) continue;
            nearestFoe = Math.min(nearestFoe, Math.max(Math.abs(row - m.row), Math.abs(col - m.col)));
          }
        }
        if (Number.isFinite(nearestFoe)) levelEnemy[name].push(nearestFoe);
      }
    }
  }
}

void DIRECTIONS;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`where a stone lands relative to its own — ${games} games decided by the count\n`);
console.log(`${"turns".padEnd(24)}${BANDS.map((_, i) => label(i).padStart(10)).join("")}`);
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, gap to nearest`.padEnd(24)}${dist[name].map((xs) => (xs.length ? mean(xs).toFixed(2) : "-").padStart(10)).join("")}`);
}
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, separate lumps`.padEnd(24)}${lumps[name].map((xs) => (xs.length ? mean(xs).toFixed(2) : "-").padStart(10)).join("")}`);
}
console.log(`\nturns 11-40 at a level settled score:`);
for (const name of ["human", "ai"]) {
  console.log(
    `  ${name.padEnd(8)}gap ${mean(levelDist[name]).toFixed(2)}   lumps ${mean(levelLumps[name]).toFixed(2)}   (${levelDist[name].length} turns)`,
  );
}
const hist = (xs: number[]) => {
  const h = new Map<number, number>();
  for (const x of xs) h.set(Math.min(x, 5), (h.get(Math.min(x, 5)) ?? 0) + 1);
  return [...h.keys()].sort((a, b) => a - b).map((k) => `${k === 5 ? "5+" : k}:${((h.get(k)! / xs.length) * 100).toFixed(0)}%`).join("  ");
};
console.log(`\ngap distribution at a level score`);
for (const name of ["human", "ai"]) console.log(`  ${name.padEnd(8)}${hist(levelDist[name])}`);

console.log(`\ndistance to the nearest enemy stone, same turns and same score`);
for (const name of ["human", "ai"]) {
  console.log(`  ${name.padEnd(8)}mean ${mean(levelEnemy[name]).toFixed(2)}   ${hist(levelEnemy[name])}`);
}
