/**
 * The player's report: "내가 펼치는거 하나도 안막잖아."
 *
 * The first version of this measured engine moves *next to* the player's final
 * territory and got zero every game — which is not a finding, it is the rules.
 * Territory only forms inside a single-colour wall, so no engine stone is ever
 * adjacent to a cell the player ends up holding. The question has to be asked
 * about the ground while it was still open.
 *
 * So: take the biggest region the player finishes with, and count how many of
 * the engine's own turns went by while cells of that region were still empty
 * and still legal for it to play. Those are the turns it could have walked in
 * and did not. A region that was open to the engine for twenty of its turns
 * and never entered was not lost in a fight — it was handed over.
 *
 *   npx vite-node big-region-timing.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { DIRECTIONS, opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;

function regionsOf(cells: Coord[]): Coord[][] {
  const key = (c: Coord) => `${c.row},${c.col}`;
  const left = new Map(cells.map((c) => [key(c), c]));
  const out: Coord[][] = [];
  while (left.size > 0) {
    const [k0] = left.keys();
    const start = left.get(k0)!;
    left.delete(k0);
    const region = [start];
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [dr, dc] of DIRECTIONS) {
        const nk = `${cur.row + dr},${cur.col + dc}`;
        const hit = left.get(nk);
        if (hit) {
          left.delete(nk);
          region.push(hit);
          queue.push(hit);
        }
      }
    }
    out.push(region);
  }
  return out;
}

const seen = new Set<string>();
const rows: Array<{
  variant: string;
  size: number;
  openTurns: number;
  entered: number;
  engineTurns: number;
}> = [];

console.log(
  `${"variant".padEnd(16)}${"biggest".padStart(9)}${"engine turns it was open".padStart(26)}` +
    `${"engine went in".padStart(16)}`,
);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);

    let final: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (final.winner) break;
      final = m.type === "PASS"
        ? applyAction(final, { type: "PASS" })
        : applyAction(final, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const regions = regionsOf(calculateTerritories(final.board)[human]);
    if (regions.length === 0) continue;
    regions.sort((a, b) => b.length - a.length);
    const biggest = regions[0];

    let openTurns = 0;
    let entered = 0;
    let engineTurns = 0;
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        engineTurns += 1;
        // Was any cell of that region still available to the engine right now?
        const open = biggest.some((c) => isLegalMove(state, c.row, c.col, engine));
        if (open) openTurns += 1;
        if (biggest.some((c) => c.row === m.row && c.col === m.col)) entered += 1;
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }

    rows.push({ variant: rec.aiVariant ?? "(older)", size: biggest.length, openTurns, entered, engineTurns });
    console.log(
      `${(rec.aiVariant ?? "(older)").padEnd(16)}${String(biggest.length).padStart(9)}` +
        `${`${openTurns} of ${engineTurns}`.padStart(26)}${String(entered).padStart(16)}`,
    );
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\ngames: ${rows.length}`);
console.log(`mean biggest region: ${mean(rows.map((r) => r.size)).toFixed(1)} cells`);
console.log(
  `mean engine turns the region was still open to it: ${mean(rows.map((r) => r.openTurns)).toFixed(1)}` +
    ` of ${mean(rows.map((r) => r.engineTurns)).toFixed(1)}`,
);
console.log(`mean engine moves played inside it: ${mean(rows.map((r) => r.entered)).toFixed(2)}`);
console.log(`games where it never went in at all: ${rows.filter((r) => r.entered === 0).length} of ${rows.length}`);
