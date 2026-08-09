/**
 * How a large region actually gets built, for each side.
 *
 * Per counted game the human takes 10.3 cells from regions of four or more and
 * the engine 4.4 — 5.9 of the 8.4-cell gap. Five terms that told the engine to
 * value territory all measured zero, so this asks the prior question instead:
 * what does building one look like as a sequence of moves?
 *
 * For every final region of four cells or more, find the owner's stones that
 * wall it, look up when each was played, and describe the sequence — how many
 * stones, how much of the wall is board edge, when they started and finished,
 * and how far apart consecutively played wall stones are.
 *
 *   npx vite-node big-regions.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

interface Built {
  size: number;
  stones: number;
  edgeShare: number;
  firstTurn: number;
  lastTurn: number;
  span: number;
  /** Chebyshev distance between wall stones in the order they were played. */
  steps: number[];
}
const bySide = new Map<string, Built[]>();

function regions(cells: Coord[]): Coord[][] {
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  const seen = new Set<string>();
  const out: Coord[][] = [];
  for (const c of cells) {
    const start = `${c.row},${c.col}`;
    if (seen.has(start)) continue;
    const group: Coord[] = [];
    const stack = [c];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const [dr, dc] of DIRECTIONS) {
        const r = cur.row + dr, cc = cur.col + dc;
        const k = `${r},${cc}`;
        if (inBounds(r, cc) && set.has(k) && !seen.has(k)) { seen.add(k); stack.push({ row: r, col: cc }); }
      }
    }
    out.push(group);
  }
  return out;
}

const seenGames = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seenGames.has(rec.id)) continue;
    if (rec.id) seenGames.add(rec.id);
    if (rec.winReason !== "TERRITORY") continue;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    // When each point was played, and the final board.
    const playedAt = new Map<string, number>();
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (m.type === "PLACE") playedAt.set(`${m.row},${m.col}`, m.turn);
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const finalT = calculateTerritories(state.board);

    for (const [who, side] of [["human", human], ["AI", ai]] as const) {
      const list = bySide.get(who) ?? [];
      bySide.set(who, list);
      const own = playerCell(side);
      for (const region of regions(finalT[side])) {
        if (region.length < 4) continue;
        // The wall: own stones orthogonally touching the region, plus how much
        // of the boundary is board edge rather than stone.
        const wall = new Set<string>();
        let edge = 0;
        let boundary = 0;
        for (const cell of region) {
          for (const [dr, dc] of DIRECTIONS) {
            const r = cell.row + dr, c = cell.col + dc;
            if (!inBounds(r, c)) { edge += 1; boundary += 1; continue; }
            if (state.board[r][c] === own) { wall.add(`${r},${c}`); boundary += 1; }
          }
        }
        const turns = [...wall].map((k) => playedAt.get(k) ?? 0).filter((t) => t > 0).sort((a, b) => a - b);
        if (turns.length < 2) continue;
        const order = [...wall]
          .map((k) => ({ k, t: playedAt.get(k) ?? 0 }))
          .filter((x) => x.t > 0)
          .sort((a, b) => a.t - b.t)
          .map((x) => x.k.split(",").map(Number));
        const steps: number[] = [];
        for (let i = 1; i < order.length; i += 1) {
          steps.push(Math.max(Math.abs(order[i][0] - order[i - 1][0]), Math.abs(order[i][1] - order[i - 1][1])));
        }
        list.push({
          size: region.length,
          stones: wall.size,
          edgeShare: boundary ? edge / boundary : 0,
          firstTurn: turns[0],
          lastTurn: turns[turns.length - 1],
          span: turns[turns.length - 1] - turns[0],
          steps,
        });
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`regions of four cells or more, and the wall that made each\n`);
console.log(
  `${"side".padEnd(8)}${"regions".padStart(9)}${"cells".padStart(8)}${"wall stones".padStart(13)}` +
    `${"cells/stone".padStart(13)}${"edge share".padStart(12)}${"start turn".padStart(12)}${"span".padStart(8)}`,
);
for (const [who, list] of bySide) {
  console.log(
    `${who.padEnd(8)}${String(list.length).padStart(9)}${mean(list.map((b) => b.size)).toFixed(1).padStart(8)}` +
      `${mean(list.map((b) => b.stones)).toFixed(1).padStart(13)}` +
      `${mean(list.map((b) => b.size / b.stones)).toFixed(2).padStart(13)}` +
      `${`${(mean(list.map((b) => b.edgeShare)) * 100).toFixed(0)}%`.padStart(12)}` +
      `${mean(list.map((b) => b.firstTurn)).toFixed(1).padStart(12)}` +
      `${mean(list.map((b) => b.span)).toFixed(1).padStart(8)}`,
  );
}
console.log(`\nspacing between wall stones in the order they were played:`);
for (const [who, list] of bySide) {
  const all = list.flatMap((b) => b.steps);
  const hist = new Map<number, number>();
  for (const s of all) hist.set(Math.min(s, 5), (hist.get(Math.min(s, 5)) ?? 0) + 1);
  const parts = [...hist.keys()].sort((a, b) => a - b)
    .map((k) => `${k === 5 ? "5+" : k}:${((hist.get(k)! / all.length) * 100).toFixed(0)}%`);
  console.log(`  ${who.padEnd(8)} ${parts.join("  ")}   (n=${all.length}, mean ${mean(all).toFixed(2)})`);
}
