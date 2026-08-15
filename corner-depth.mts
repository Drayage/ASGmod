/**
 * Who ends up on the inside of a contested corner?
 *
 * Tracing the fights by hand (`corner-fight-trace.mts`) the same picture keeps
 * appearing: the engine's stones sit on the frame line — edge distances summing
 * to three — and the player's sit one step nearer the corner, and the player
 * takes the cells even when the engine has more stones there. In this game the
 * corner itself is the cheapest ground on the board, so being outside the other
 * player's stones is being outside the territory.
 *
 * This measures it directly: for every contested corner, the mean depth of each
 * side's stones (0 = on the corner point itself) against the cells each side
 * finished with.
 *
 *   npx vite-node corner-depth.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 3);

function cornerOf(row: number, col: number, size: number): string | null {
  const dr = Math.min(row, size - 1 - row);
  const dc = Math.min(col, size - 1 - col);
  if (dr > DEPTH || dc > DEPTH) return null;
  return `${row < size / 2 ? "T" : "B"}${col < size / 2 ? "L" : "R"}`;
}
/** Distance from the corner point: 0 on the corner, 3 on the frame line. */
function depthOf(row: number, col: number, size: number): number {
  return Math.min(row, size - 1 - row) + Math.min(col, size - 1 - col);
}

interface Fight {
  engineStones: number;
  humanStones: number;
  engineDepth: number;
  humanDepth: number;
  engineCells: number;
  humanCells: number;
}
const fights: Fight[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const size = state.board.length;
    const terr = calculateTerritories(state.board);

    const byCorner = new Map<string, Fight & { eDepths: number[]; hDepths: number[] }>();
    const get = (q: string) => {
      const cur = byCorner.get(q) ?? {
        engineStones: 0, humanStones: 0, engineDepth: 0, humanDepth: 0,
        engineCells: 0, humanCells: 0, eDepths: [], hDepths: [],
      };
      byCorner.set(q, cur);
      return cur;
    };

    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const q = cornerOf(r, c, size);
        if (!q) continue;
        const cell = state.board[r][c];
        if (cell === playerCell(engine)) {
          const f = get(q);
          f.engineStones += 1;
          f.eDepths.push(depthOf(r, c, size));
        } else if (cell === playerCell(human)) {
          const f = get(q);
          f.humanStones += 1;
          f.hDepths.push(depthOf(r, c, size));
        }
      }
    }
    for (const side of [engine, human] as Player[]) {
      for (const cell of terr[side]) {
        const q = cornerOf(cell.row, cell.col, size);
        if (!q) continue;
        const f = get(q);
        if (side === engine) f.engineCells += 1;
        else f.humanCells += 1;
      }
    }

    for (const f of byCorner.values()) {
      if (f.engineStones === 0 || f.humanStones === 0) continue; // contested only
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      fights.push({
        engineStones: f.engineStones,
        humanStones: f.humanStones,
        engineDepth: mean(f.eDepths),
        humanDepth: mean(f.hDepths),
        engineCells: f.engineCells,
        humanCells: f.humanCells,
      });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`contested corners: ${fights.length}\n`);
console.log(`mean stone depth (0 = the corner point itself, 3 = the frame line)`);
console.log(`  engine ${mean(fights.map((f) => f.engineDepth)).toFixed(2)}`);
console.log(`  player ${mean(fights.map((f) => f.humanDepth)).toFixed(2)}\n`);

const inside = fights.filter((f) => f.engineDepth < f.humanDepth);
const outside = fights.filter((f) => f.engineDepth > f.humanDepth);
console.log(`corners where the engine was the one nearer the corner: ${inside.length}`);
console.log(`  engine cells ${mean(inside.map((f) => f.engineCells)).toFixed(1)}, player ${mean(inside.map((f) => f.humanCells)).toFixed(1)}`);
console.log(`corners where the player was nearer: ${outside.length}`);
console.log(`  engine cells ${mean(outside.map((f) => f.engineCells)).toFixed(1)}, player ${mean(outside.map((f) => f.humanCells)).toFixed(1)}`);

console.log(`\nengine cells by how much deeper the player sat (player depth - engine depth)\n`);
console.log(`${"gap".padEnd(12)}${"corners".padStart(9)}${"engine cells".padStart(15)}${"player cells".padStart(15)}`);
// The gap is (player depth - engine depth), so a negative gap means the
// player's stones sit nearer the corner than the engine's. Labelled the wrong
// way round at first, which inverts the entire conclusion — the reader should
// not have to recompute the sign to know who was inside.
for (const [lo, hi, label] of [
  [-99, -0.5, "player in"],
  [-0.5, 0.5, "level"],
  [0.5, 99, "engine in"],
] as const) {
  const g = fights.filter((f) => f.humanDepth - f.engineDepth > lo && f.humanDepth - f.engineDepth <= hi);
  if (g.length === 0) continue;
  console.log(
    `${label.padEnd(12)}${String(g.length).padStart(9)}` +
      `${mean(g.map((f) => f.engineCells)).toFixed(1).padStart(15)}${mean(g.map((f) => f.humanCells)).toFixed(1).padStart(15)}`,
  );
}
