/**
 * What a corner pays back, by how many stones each side spent on it.
 *
 * The player's question about the matching rule: if they put three stones in a
 * corner, does answering need three of mine — or does three against their four
 * already do the job? Matching one for one is only right if the last stone is
 * still buying as much as the first, and nothing so far has checked that.
 *
 * So this counts, for every corner of every finished game, the stones each side
 * spent inside it and the cells each side finally held there. The table is
 * indexed by their stones and mine, which is exactly the decision the book makes:
 * they have N here, I have k, is another one worth it.
 *
 * Reads both shapes — the app's exported records and the arena's own output, so
 * the same question can be asked of 25 recorded games or 960 arena corners.
 *
 *   npx vite-node corner-invest.mts <export.json | arena.json ...>
 *
 * SIDE=human   only the recorded player's corners (exports only)
 * SIDE=engine  only the engine's
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** A cell belongs to a corner when both its edge distances are 3 or less — the
 *  frame line and everything inside it, which is what the book is buying. */
const CORNER_DEPTH = Number(process.env.DEPTH ?? 3);
const SIDE = process.env.SIDE ?? "both";

interface Cell { stones: number; cells: number; n: number }
/** key `${theirs},${mine}` */
const table = new Map<string, Cell>();

const quadrant = (row: number, col: number, size: number): string | null => {
  const dr = Math.min(row, size - 1 - row);
  const dc = Math.min(col, size - 1 - col);
  if (dr > CORNER_DEPTH || dc > CORNER_DEPTH) return null;
  return `${row < size / 2 ? "T" : "B"}${col < size / 2 ? "L" : "R"}`;
};

const record = (theirs: number, mine: number, cells: number) => {
  const key = `${theirs},${mine}`;
  const cur = table.get(key) ?? { stones: 0, cells: 0, n: 0 };
  cur.stones += mine;
  cur.cells += cells;
  cur.n += 1;
  table.set(key, cur);
};

let games = 0;
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const exported: any[] = raw.records ?? [];
  const arena: any[] = raw.matches ? raw.matches.flatMap((m: any) => m.games) : (raw.games ?? []);

  for (const rec of [...exported, ...arena]) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    // Exports name the human's side; arena games have no human at all, so both
    // sides count and SIDE is ignored for them.
    const human: Player | null = rec.playerSide ?? null;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory ?? []) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
    games += 1;

    const size = state.board.length;
    const territories = calculateTerritories(state.board);
    const stones: Record<string, Record<Player, number>> = {};
    const cells: Record<string, Record<Player, number>> = {};
    const bump = (
      into: Record<string, Record<Player, number>>,
      q: string,
      side: Player,
    ) => {
      into[q] ??= { A: 0, B: 0 };
      into[q][side] += 1;
    };

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const q = quadrant(row, col, size);
        if (!q) continue;
        const cell = state.board[row][col];
        if (cell === "PLAYER_A") bump(stones, q, "A");
        if (cell === "PLAYER_B") bump(stones, q, "B");
      }
    }
    for (const side of ["A", "B"] as Player[]) {
      for (const c of territories[side]) {
        const q = quadrant(c.row, c.col, size);
        if (q) bump(cells, q, side);
      }
    }

    for (const q of new Set([...Object.keys(stones), ...Object.keys(cells)])) {
      for (const side of ["A", "B"] as Player[]) {
        if (human && SIDE === "human" && side !== human) continue;
        if (human && SIDE === "engine" && side === human) continue;
        record(
          stones[q]?.[opponent(side)] ?? 0,
          stones[q]?.[side] ?? 0,
          cells[q]?.[side] ?? 0,
        );
      }
    }
  }
}

const maxN = 6;
console.log(`${games} games, corner = both edge distances ${CORNER_DEPTH} or less, side ${SIDE}\n`);
console.log("cells finally held, by their stones in the corner (rows) and mine (columns)\n");
const head = ["theirs\\mine", ...Array.from({ length: maxN + 1 }, (_, k) => String(k))];
console.log(head.map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(9))).join(""));
for (let theirs = 0; theirs <= maxN; theirs += 1) {
  const row = [`${theirs}`.padEnd(12)];
  for (let mine = 0; mine <= maxN; mine += 1) {
    const c = table.get(`${theirs},${mine}`);
    row.push(c && c.n >= 5 ? (c.cells / c.n).toFixed(1).padStart(9) : "·".padStart(9));
  }
  console.log(row.join(""));
}

console.log("\nsamples behind each\n");
console.log(head.map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(9))).join(""));
for (let theirs = 0; theirs <= maxN; theirs += 1) {
  const row = [`${theirs}`.padEnd(12)];
  for (let mine = 0; mine <= maxN; mine += 1) {
    const c = table.get(`${theirs},${mine}`);
    row.push(String(c?.n ?? 0).padStart(9));
  }
  console.log(row.join(""));
}

console.log("\nwhat the next stone bought, at each of their counts\n");
console.log(`${"theirs".padEnd(8)}${"mine".padStart(6)}${"cells".padStart(8)}${"gain".padStart(8)}${"n".padStart(7)}`);
for (let theirs = 0; theirs <= maxN; theirs += 1) {
  let prev: number | null = null;
  for (let mine = 0; mine <= maxN; mine += 1) {
    const c = table.get(`${theirs},${mine}`);
    if (!c || c.n < 5) continue;
    const mean = c.cells / c.n;
    console.log(
      `${String(theirs).padEnd(8)}${String(mine).padStart(6)}${mean.toFixed(2).padStart(8)}` +
        `${(prev === null ? "" : (mean - prev >= 0 ? "+" : "") + (mean - prev).toFixed(2)).padStart(8)}` +
        `${String(c.n).padStart(7)}`,
    );
    prev = mean;
  }
}
