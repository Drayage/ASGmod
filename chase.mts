/**
 * Chasing a group the opponent can simply walk out of.
 *
 * The player's hypothesis, in their terms: the engine goes after any capture
 * that appears. Worth taking only when the point also grows its own ground, or
 * when the opponent cannot just escape in one move, or when leaving it costs
 * little because the opponent cannot expand there anyway.
 *
 * A first attempt defined an attack as any move reducing an enemy group's
 * liberties and found every attack "fruitless" — 156 of 156. That definition
 * catches ordinary contact play, so it measured nothing. This one is the
 * player's: a move that drives an enemy group to two liberties or fewer, where
 * the opponent has a reply that lifts it back to three or more. The chase gains
 * nothing by construction, and the only question left is whether the move was
 * worth playing for another reason.
 *
 *   npx vite-node chase.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { influenceOwnerMap, influenceCountFromMap, findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Side {
  moves: number;
  squeezes: number;
  escapable: number;
  /** Escapable squeezes that gained the mover no reach and settled nothing. */
  pureLoss: number;
  /** ...and a 2+ seal was available instead on that same turn. */
  sealWasAvailable: number;
}
const blank = (): Side => ({ moves: 0, squeezes: 0, escapable: 0, pureLoss: 0, sealWasAvailable: 0 });
const stats = new Map<string, { ai: Side; human: Side; games: number }>();
const gkey = (g: Array<{ row: number; col: number }>) =>
  g.map((s) => `${s.row},${s.col}`).sort().join("|");

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const build = rec.appVersion ?? "?";
    const s = stats.get(build) ?? { ai: blank(), human: blank(), games: 0 };
    stats.set(build, s);
    s.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const foe = opponent(mover);
      const side = mover === ai ? s.ai : s.human;
      side.moves += 1;
      if (m.type !== "PLACE") { state = applyAction(state, { type: "PASS" }); continue; }

      const before = new Map<string, number>();
      for (const g of getAllGroups(state.board, foe)) before.set(gkey(g), getGroupLiberties(state.board, g).size);
      const reachBefore = influenceCountFromMap(influenceOwnerMap(state.board))[mover];
      const sealHere = findSealingMoves(state, mover).some((x) => x.gained.length >= 2);

      const after = applyAction(state, { type: "PLACE", row: m.row, col: m.col });
      if (after.winner) { state = after; continue; }

      // A squeeze: some enemy group is now at <=2 liberties, fewer than before.
      let target: Array<{ row: number; col: number }> | null = null;
      for (const g of getAllGroups(after.board, foe)) {
        const was = before.get(gkey(g));
        const now = getGroupLiberties(after.board, g).size;
        if (was !== undefined && now < was && now <= 2) { target = g; break; }
      }
      if (!target) { state = after; continue; }
      side.squeezes += 1;

      // Can the opponent lift it back to three or more in one move?
      const anchor = target[0];
      let escapes = false;
      for (const act of getSafeActions(after, foe).pool) {
        if (act.type !== "PLACE") continue;
        const next = applyAction(after, act);
        if (next.winner) continue;
        const g = getConnectedGroup(next.board, anchor.row, anchor.col);
        if (g.length === 0) continue;
        if (getGroupLiberties(next.board, g).size >= 3) { escapes = true; break; }
      }
      if (!escapes) { state = after; continue; }
      side.escapable += 1;

      // Did the move do anything else for the mover?
      const reachAfter = influenceCountFromMap(influenceOwnerMap(after.board))[mover];
      const settled = after.territories[mover].length > state.territories[mover].length;
      if (reachAfter <= reachBefore && !settled) {
        side.pureLoss += 1;
        if (sealHere) side.sealWasAvailable += 1;
      }
      state = after;
    }
  }
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);
for (const [build, s] of [...stats.entries()].sort((a, b) => a[1].games - b[1].games)) {
  console.log(`\n=== ${build}  (${s.games} games)`);
  console.log(
    `${"".padEnd(8)}${"moves".padStart(7)}${"squeeze".padStart(9)}${"escapable".padStart(11)}` +
      `${"gained nothing".padStart(16)}${"per game".padStart(10)}${"seal was there".padStart(16)}`,
  );
  for (const [who, d] of [["AI", s.ai], ["human", s.human]] as const) {
    console.log(
      `${who.padEnd(8)}${String(d.moves).padStart(7)}${String(d.squeezes).padStart(9)}` +
        `${String(d.escapable).padStart(11)}${String(d.pureLoss).padStart(16)}` +
        `${(d.pureLoss / s.games).toFixed(1).padStart(10)}${String(d.sealWasAvailable).padStart(16)}`,
    );
  }
}
