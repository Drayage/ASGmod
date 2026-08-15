/**
 * The engine never once played inside the region the player wins with, across
 * eleven games and about ten of its own turns per game while the ground was
 * still open (`big-region-timing.mts`). Why not?
 *
 * Three candidates, and they need different fixes:
 *   - the pool guards throw the move out before anything looks at it;
 *   - the move survives to the search and the search scores it badly;
 *   - the ladder answers at an earlier stage and never reaches a search at all.
 *
 * So at every engine turn where the region was still open, this asks what
 * happened to the best entry into it: was it in the guarded pool, what did the
 * leaf evaluation think of it against the move actually played, and which stage
 * decided the turn.
 *
 *   npx vite-node invasion-why.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { DIRECTIONS, opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
const THINK = Number(process.env.THINK ?? 1500);

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
        if (hit) { left.delete(nk); region.push(hit); queue.push(hit); }
      }
    }
    out.push(region);
  }
  return out;
}

let turns = 0;
let inPool = 0;
let leafPrefersEntry = 0;
const gaps: number[] = [];
const stages = new Map<string, number>();
const seen = new Set<string>();
const lines: string[] = [];

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

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

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      ply += 1;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        const entries = biggest.filter((c) => isLegalMove(state, c.row, c.col, engine));
        if (entries.length > 0) {
          turns += 1;
          // Best entry by leaf evaluation.
          let best = { cell: entries[0], score: -Infinity };
          for (const c of entries) {
            const s = evaluateState(applyAction(state, { type: "PLACE", row: c.row, col: c.col }), engine);
            if (s > best.score) best = { cell: c, score: s };
          }
          const played = evaluateState(applyAction(state, { type: "PLACE", row: m.row!, col: m.col! }), engine);
          const gap = (best.score - played) / 100;
          gaps.push(gap);
          if (gap > 0) leafPrefersEntry += 1;

          const { pool } = getSafeActions(state, engine);
          const survives = pool.some(
            (a) => a.type === "PLACE" && a.row === best.cell.row && a.col === best.cell.col,
          );
          if (survives) inPool += 1;

          findBestMoveVeryHard(state, engine, THINK);
          stages.set(lastDecision.stage, (stages.get(lastDecision.stage) ?? 0) + 1);

          if (lines.length < 10) {
            lines.push(
              `  ply ${String(ply).padStart(3)}  best entry ${nm(best.cell.row, best.cell.col)} ` +
                `${survives ? "in pool" : "CUT from pool"}, leaf gap vs played ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} cells` +
                `  [${lastDecision.stage}]`,
            );
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`engine turns with the region still open: ${turns}`);
console.log(`best entry survived the pool guards: ${inPool} (${((100 * inPool) / Math.max(1, turns)).toFixed(0)}%)`);
console.log(`leaf evaluation preferred entering over the move played: ${leafPrefersEntry} (${((100 * leafPrefersEntry) / Math.max(1, turns)).toFixed(0)}%)`);
console.log(`mean leaf gap (entry - played): ${mean(gaps).toFixed(2)} cells\n`);
console.log("stage that decided those turns");
for (const [s, n] of [...stages.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(28)}${String(n).padStart(5)}`);
}
console.log(`\nthe first few\n`);
for (const l of lines) console.log(l);
