/**
 * Which evaluation term attracts the engine to a chase that gains nothing?
 *
 * The atari bonus was the obvious suspect and turned out not to be it: zeroing
 * it entirely left 17 of 18 such moves unchanged. Rather than name another
 * suspect, this asks the position.
 *
 * At every turn where the real search picks an escapable squeeze that wins the
 * engine no reach, denies the opponent none, and settles nothing, each legal
 * move is scored term by term. The chase move's rank among all moves is taken
 * per term. A term the chase consistently tops is a term pulling towards it; a
 * term where it sits mid-field is not involved.
 *
 * Stated as what it is: an attribution at one ply of a choice made at five to
 * eight. It cannot prove a cause, only point at one worth testing.
 *
 *   npx vite-node attribute.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { AIAction, GameState, Player } from "./src/games/alley-boss-cats/ai";

const BUDGET = Number(process.env.BUDGET ?? 800);
const gkey = (g: Array<{ row: number; col: number }>) =>
  g.map((s) => `${s.row},${s.col}`).sort().join("|");

/** Escapable squeeze, no reach won, none denied, nothing settled. */
function isWastedChase(state: GameState, move: AIAction, mover: Player): boolean {
  if (move.type !== "PLACE") return false;
  const foe = opponent(mover);
  const before = new Map<string, number>();
  for (const g of getAllGroups(state.board, foe)) before.set(gkey(g), getGroupLiberties(state.board, g).size);
  const infBefore = influenceCountFromMap(influenceOwnerMap(state.board));

  const after = applyAction(state, move);
  if (after.winner) return false;
  let target: Array<{ row: number; col: number }> | null = null;
  for (const g of getAllGroups(after.board, foe)) {
    const was = before.get(gkey(g));
    const now = getGroupLiberties(after.board, g).size;
    if (was !== undefined && now < was && now <= 2) { target = g; break; }
  }
  if (!target) return false;

  const anchor = target[0];
  let escapes = false;
  for (const act of getSafeActions(after, foe).pool) {
    if (act.type !== "PLACE") continue;
    const next = applyAction(after, act);
    if (next.winner) continue;
    const g = getConnectedGroup(next.board, anchor.row, anchor.col);
    if (g.length > 0 && getGroupLiberties(next.board, g).size >= 3) { escapes = true; break; }
  }
  if (!escapes) return false;

  const infAfter = influenceCountFromMap(influenceOwnerMap(after.board));
  const settled = after.territories[mover].length > state.territories[mover].length;
  return infAfter[mover] <= infBefore[mover] && infAfter[foe] >= infBefore[foe] && !settled;
}

const ranks = new Map<string, number[]>();
const stages = new Map<string, number>();
let found = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        const chosen = findBestMoveVeryHard(state, ai, BUDGET);
        const stage = lastDecision.stage;
        if (isWastedChase(state, chosen, ai)) {
          found += 1;
          stages.set(stage, (stages.get(stage) ?? 0) + 1);
          const { pool } = getSafeActions(state, ai);
          const scored = pool.map((a) => ({ a, parts: evaluateComponents(applyAction(state, a), ai) }));
          const names = new Set<string>();
          for (const s of scored) for (const k of Object.keys(s.parts)) names.add(k);
          for (const name of names) {
            const values = scored.map((s) => ({ a: s.a, v: s.parts[name] ?? 0 }));
            values.sort((x, y) => y.v - x.v);
            const at = values.findIndex(
              (v) => v.a.type === "PLACE" && chosen.type === "PLACE" &&
                v.a.row === chosen.row && v.a.col === chosen.col,
            );
            if (at < 0) continue;
            // 100 = this term likes the chase best of every move available.
            const pct = values.length > 1 ? ((values.length - 1 - at) / (values.length - 1)) * 100 : 50;
            (ranks.get(name) ?? ranks.set(name, []).get(name)!).push(pct);
          }
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`wasted chases found by the real search at ${BUDGET}ms: ${found}\n`);
console.log(`  picked by: ${[...stages].map(([s, n]) => `${s} x${n}`).join(", ")}\n`);
console.log(`  where the chase move ranks among all legal moves, per term`);
console.log(`  (100 = this term likes it best of everything on offer, 50 = mid-field)\n`);
for (const [name, xs] of [...ranks.entries()].sort((a, b) => mean(b[1]) - mean(a[1]))) {
  console.log(`    ${name.padEnd(18)}${mean(xs).toFixed(0).padStart(5)}   (n=${xs.length})`);
}
