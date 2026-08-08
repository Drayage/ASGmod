/**
 * Does the term reduce the behaviour it was built for, on the positions that
 * showed the behaviour?
 *
 * The arena came back neutral, but 47 of its 68 games ended in a capture
 * against 2 of 21 in the recorded human games. Chasing pays there and does not
 * here, so a term that prices chasing down has almost nothing to act on in the
 * arena. This asks the same question where the defect was measured: replay each
 * recorded AI turn, run the real search at both weights, and count how often
 * the move it picks is a squeeze the opponent walks out of for no gain.
 *
 *   npx vite-node escp-effect.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { getSafeActions } from "./src/games/alley-boss-cats/ai";
import { influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { AIAction, GameState, Player } from "./src/games/alley-boss-cats/ai";

const BUDGET = Number(process.env.BUDGET ?? 800);
const gkey = (g: Array<{ row: number; col: number }>) =>
  g.map((s) => `${s.row},${s.col}`).sort().join("|");

/** The move's own verdict: an escapable squeeze that gains the mover nothing. */
function isEmptyChase(state: GameState, move: AIAction, mover: Player): boolean {
  if (move.type !== "PLACE") return false;
  const foe = opponent(mover);
  const before = new Map<string, number>();
  for (const g of getAllGroups(state.board, foe)) before.set(gkey(g), getGroupLiberties(state.board, g).size);
  const reachBefore = influenceCountFromMap(influenceOwnerMap(state.board))[mover];

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

  const reachAfter = influenceCountFromMap(influenceOwnerMap(after.board))[mover];
  const settled = after.territories[mover].length > state.territories[mover].length;
  return reachAfter <= reachBefore && !settled;
}

const byStage = new Map<string, number>();
const result = new Map<number, { turns: number; chases: number; changed: number }>();
for (const weight of [1, 0]) result.set(weight, { turns: 0, chases: 0, changed: 0 });
let differ = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        const picks: Record<number, AIAction> = {} as never;
        for (const weight of [1, 0]) {
          tuning.escapablePressureWeight = weight;
          const mv = findBestMoveVeryHard(state, ai, BUDGET);
          picks[weight] = mv;
          const stage = lastDecision.stage;
          const r = result.get(weight)!;
          r.turns += 1;
          if (isEmptyChase(state, mv, ai)) {
            r.chases += 1;
            // Which stage picked it. If a guard did, no evaluation weight can
            // stop it — that is what the thin-group finding looked like too.
            byStage.set(`${weight}|${stage}`, (byStage.get(`${weight}|${stage}`) ?? 0) + 1);
          }
        }
        tuning.escapablePressureWeight = 1;
        const a = picks[1], b = picks[0];
        const same = a.type === b.type && (a.type !== "PLACE" || (a.row === (b as any).row && a.col === (b as any).col));
        if (!same) differ += 1;
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(`real search at ${BUDGET}ms, replaying recorded AI turns\n`);
for (const weight of [1, 0]) {
  const r = result.get(weight)!;
  console.log(
    `  escapablePressureWeight ${weight}:  empty chases ${r.chases}/${r.turns}` +
      `  (${((r.chases / r.turns) * 100).toFixed(1)}%)`,
  );
}
console.log(`\n  the two weights chose a different move on ${differ} turns`);
console.log(`\n  which stage picked the empty chases:`);
for (const [k, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
  const [w, stage] = k.split("|");
  console.log(`    weight ${w}  ${stage.padEnd(26)} ${n}`);
}
