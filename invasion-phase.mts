/**
 * `invasion-why.mts` pooled every turn where the player's biggest region was
 * still open and found 56 of 106 decided by the corner book. But the book is
 * meant to be finished in eight moves — two stones in each of four corners —
 * so pooling the opening with the middlegame hides the question that matters.
 *
 * The player's framing: the book ends, and from then on the engine is supposed
 * to answer over-investment and cuts wherever it can do so without losing out.
 * So this splits the same turns by when the book actually stops, and reports
 * what decides the turns on each side of that line.
 *
 *   npx vite-node invasion-phase.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState } from "./src/games/alley-boss-cats/ai";
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

interface Phase { turns: number; stages: Map<string, number>; leafPrefers: number; regionSize: number[] }
const before: Phase = { turns: 0, stages: new Map(), leafPrefers: 0, regionSize: [] };
const after: Phase = { turns: 0, stages: new Map(), leafPrefers: 0, regionSize: [] };
const bookEndPlies: number[] = [];
const bookTurnsPerGame: number[] = [];
const seen = new Set<string>();

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
    const footprint = new Set(biggest.map((c) => `${c.row},${c.col}`));

    // First pass: replay and record which stage decided each engine turn, so
    // the last corner-book turn is known before the phases are counted.
    const decided: Array<{ ply: number; stage: string; state: GameState; played: { row: number; col: number } }> = [];
    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      ply += 1;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        findBestMoveVeryHard(state, engine, THINK);
        decided.push({ ply, stage: lastDecision.stage, state, played: { row: m.row!, col: m.col! } });
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }

    const bookTurns = decided.filter((d) => d.stage.startsWith("1.88"));
    bookTurnsPerGame.push(bookTurns.length);
    const bookEnd = bookTurns.length > 0 ? bookTurns[bookTurns.length - 1].ply : 0;
    bookEndPlies.push(bookEnd);

    for (const d of decided) {
      const entries = biggest.filter((c) => isLegalMove(d.state, c.row, c.col, engine));
      if (entries.length === 0) continue;
      const phase = d.ply <= bookEnd ? before : after;
      phase.turns += 1;
      phase.stages.set(d.stage, (phase.stages.get(d.stage) ?? 0) + 1);
      // How much of the region the human already holds at this point.
      phase.regionSize.push(
        calculateTerritories(d.state.board)[human].filter((c) => footprint.has(`${c.row},${c.col}`)).length,
      );
      let best = -Infinity;
      for (const c of entries) {
        const s = evaluateState(applyAction(d.state, { type: "PLACE", row: c.row, col: c.col }), engine);
        if (s > best) best = s;
      }
      const played = evaluateState(applyAction(d.state, { type: "PLACE", ...d.played }), engine);
      if (best > played) phase.leafPrefers += 1;
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`corner-book turns per game: ${mean(bookTurnsPerGame).toFixed(1)}`);
console.log(`book's last turn lands at ply: ${mean(bookEndPlies).toFixed(1)}\n`);

for (const [name, p] of [["while the book is still running", before], ["after the book is done", after]] as const) {
  console.log(`${name}: ${p.turns} turns with the region open`);
  console.log(`  leaf evaluation preferred entering: ${p.leafPrefers} (${((100 * p.leafPrefers) / Math.max(1, p.turns)).toFixed(0)}%)`);
  console.log(`  player already holds of it: ${mean(p.regionSize).toFixed(1)} cells`);
  for (const [s, n] of [...p.stages.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(28)}${String(n).padStart(5)}`);
  }
  console.log();
}
