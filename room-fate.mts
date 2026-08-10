/**
 * The big middle-game room, followed to the end — who consumed it?
 *
 * At turns 31-40 the engine dominates 21.8 empty cells against the human's 14.0
 * and finishes with 1.5 cells in regions of six or more against 7.0. It is not
 * losing that space to the opponent's territory (declined cells never went to
 * the opponent), and spending it on its own stones costs about 1.5 cells once
 * the room-size confound is removed. So the accounting does not close, and this
 * closes it.
 *
 * At the marked turn, take the largest empty room the side dominates and hold
 * onto exactly those cells. Replay to the end, and put each of them in one of
 * five buckets: settled as the side's own territory, settled as the opponent's,
 * covered by the side's own stone, covered by the opponent's, or left as ground
 * nobody owns.
 *
 *   AT=31 npx vite-node room-fate.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const AT = Number(process.env.AT ?? 31);

/** The largest empty room this side walls more of than the other, as cells. */
function biggestRoom(board: Board, side: Player): Coord[] {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set<string>();
  let best: Coord[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== "EMPTY" || seen.has(`${row},${col}`)) continue;
      const cells: Coord[] = [];
      const stack = [{ row, col }];
      seen.add(`${row},${col}`);
      let ours = 0, enemy = 0;
      while (stack.length) {
        const cur = stack.pop()!;
        cells.push(cur);
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
      if (ours > enemy && cells.length > best.length) best = cells;
    }
  }
  return best;
}

/**
 * Rooms bucketed by size, both sides pooled. If conversion falls off above some
 * size for everyone, then holding an oversized room is the mistake rather than
 * failing to close one — and the engine's rooms are the bigger ones.
 */
const SIZE_BANDS = [1, 7, 13, 19, 27] as const;
const sizeBand = (n: number) => {
  for (let i = SIZE_BANDS.length - 1; i >= 0; i -= 1) if (n >= SIZE_BANDS[i]) return i;
  return 0;
};
const sizeLabel = (i: number) =>
  i === SIZE_BANDS.length - 1 ? `${SIZE_BANDS[i]}+` : `${SIZE_BANDS[i]}-${SIZE_BANDS[i + 1] - 1}`;
const bySize: Record<string, Array<{ n: number; converted: number; cells: number }>> = {
  human: SIZE_BANDS.map(() => ({ n: 0, converted: 0, cells: 0 })),
  ai: SIZE_BANDS.map(() => ({ n: 0, converted: 0, cells: 0 })),
};

const KINDS = ["my territory", "my stone", "their stone", "their territory", "nobody's"] as const;
type Kind = (typeof KINDS)[number];
const blank = () => ({ games: 0, roomCells: 0, counts: Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number> });
const sides: Record<string, ReturnType<typeof blank>> = { human: blank(), ai: blank() };

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    const humanSide: Player = rec.playerSide;

    const states: GameState[] = [createInitialState()];
    for (const m of rec.moveHistory) {
      const cur = states[states.length - 1];
      if (cur.winner) break;
      states.push(
        m.type === "PASS"
          ? applyAction(cur, { type: "PASS" })
          : applyAction(cur, { type: "PLACE", row: m.row!, col: m.col! }),
      );
    }
    if (states.length <= AT) continue;
    const at = states[AT];
    const final = states[states.length - 1];
    const finalT = calculateTerritories(final.board);

    for (const side of ["A", "B"] as Player[]) {
      const name = side === humanSide ? "human" : "ai";
      const room = biggestRoom(at.board, side);
      if (room.length === 0) continue;
      const entry = sides[name];
      entry.games += 1;
      entry.roomCells += room.length;

      const mine = new Set(finalT[side].map((c: Coord) => `${c.row},${c.col}`));
      const theirs = new Set(finalT[opponent(side)].map((c: Coord) => `${c.row},${c.col}`));
      for (const cell of room) {
        const key = `${cell.row},${cell.col}`;
        const occupant = final.board[cell.row][cell.col];
        let kind: Kind;
        if (occupant === playerCell(side)) kind = "my stone";
        else if (occupant === playerCell(opponent(side))) kind = "their stone";
        else if (mine.has(key)) kind = "my territory";
        else if (theirs.has(key)) kind = "their territory";
        else kind = "nobody's";
        entry.counts[kind] += 1;
        if (kind === "my territory") bySize[name][sizeBand(room.length)].converted += 1;
      }
      const band = bySize[name][sizeBand(room.length)];
      band.n += 1;
      band.cells += room.length;
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`the largest room each side dominates at turn ${AT}, followed to the end\n`);
console.log(
  `${"side".padEnd(8)}${"games".padStart(7)}${"room".padStart(8)}` +
    KINDS.map((k) => k.padStart(15)).join(""),
);
for (const [name, e] of Object.entries(sides)) {
  if (e.games === 0) continue;
  console.log(
    `${name.padEnd(8)}${String(e.games).padStart(7)}${(e.roomCells / e.games).toFixed(1).padStart(8)}` +
      KINDS.map((k) => `${(e.counts[k] / e.games).toFixed(1)} (${pct(e.counts[k], e.roomCells)})`.padStart(15)).join(""),
  );
}

console.log(`\nconversion into own territory, by how big the room was at turn ${AT}`);
console.log(`${"side".padEnd(8)}${SIZE_BANDS.map((_, i) => sizeLabel(i).padStart(14)).join("")}`);
for (const [name, bands] of Object.entries(bySize)) {
  console.log(
    `${name.padEnd(8)}` +
      bands
        .map((b) => (b.n ? `${pct(b.converted, b.cells)} (${b.n})` : "-").padStart(14))
        .join(""),
  );
}
