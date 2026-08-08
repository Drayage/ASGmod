/**
 * When the search says it is winning a group, does it actually win it?
 *
 * Of 17 moves my metric called wasted chases, six were scored at 400,000 or
 * above by the search and two at 1,000,000, which is the score for a position
 * already won. Those cannot both be right: either the metric mislabelled a real
 * attack, or the search believes in a capture that does not happen.
 *
 * The metric has a known weakness that would produce the first — when more than
 * one enemy group is squeezed it checks whether the *first* one can escape,
 * which need not be the group the search is after. So this settles it by
 * playing the position out instead of reasoning about it: make the move, then
 * let a full-strength search answer for the defender, for as long as the attack
 * lasts, and see whether anything is actually captured.
 *
 *   npx vite-node verify-chase.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastSearchScore } from "./src/games/alley-boss-cats/engine/minimax";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { AIAction, GameState, Player } from "./src/games/alley-boss-cats/ai";

const BUDGET = Number(process.env.BUDGET ?? 800);
const PLAYOUT = Number(process.env.PLAYOUT ?? 10);
const gkey = (g: Array<{ row: number; col: number }>) =>
  g.map((s) => `${s.row},${s.col}`).sort().join("|");

/** Same test as before, and it keeps the same known weakness on purpose — the
 * point is to check the moves it flags, not to change what it flags. */
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

let flagged = 0;
const outcomes = new Map<string, number>();
const bucket = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const ai: Player = opponent(rec.playerSide);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        const chosen = findBestMoveVeryHard(state, ai, BUDGET);
        const score = lastSearchScore;
        if (isWastedChase(state, chosen, ai)) {
          flagged += 1;
          // Play it out: both sides at full strength, for a handful of plies.
          let play = applyAction(state, chosen);
          let captured: Player | null = play.winner ?? null;
          for (let ply = 0; ply < PLAYOUT && !captured; ply += 1) {
            const mv = findBestMoveVeryHard(play, play.currentPlayer, BUDGET);
            play = applyAction(play, mv);
            if (play.winner) { captured = play.winner; break; }
          }
          const band = score >= 1_000_000 ? "search says won"
            : score >= 400_000 ? "search says near-decisive"
            : "search says nothing special";
          const got = captured === ai ? "capture happened"
            : captured ? "engine got captured instead"
            : "nobody captured";
          bucket(`${band}  ->  ${got}`);
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(`moves my metric flagged as wasted chases: ${flagged}`);
console.log(`played out ${PLAYOUT} plies at ${BUDGET}ms with both sides searching\n`);
for (const [k, n] of [...outcomes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(52)} ${n}`);
}
