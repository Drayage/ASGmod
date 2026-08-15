/**
 * `planTerritory` computes two signals and stage 3 reads only one.
 *
 *   imminent          — they can confirm a large area within a move or two
 *   behindOnInfluence — they are simply ahead on the ground both sides are
 *                       heading towards, by INFLUENCE_DEFICIT or more
 *
 * `plan.urgent` is `imminent || behindOnInfluence`, and nothing anywhere reads
 * it — `territorialCandidates` gates on `imminent` alone. The planner's own
 * comment says why that matters: a player mapping out the board with loose
 * stones confirms nothing for many moves, so `imminent` stays false while the
 * region grows.
 *
 * This counts, on the recorded games, how often each signal was true at an
 * engine turn — i.e. how much the ladder would have to work with if stage 3
 * read the signal that already exists.
 *
 *   npx vite-node urgent-firing.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { planTerritory } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

let turns = 0;
let imminent = 0;
let urgentOnly = 0;
let blockingAvailable = 0;
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        turns += 1;
        const plan = planTerritory(state, engine);
        if (plan.imminent) imminent += 1;
        else if (plan.urgent) {
          urgentOnly += 1;
          if (plan.blockingMoves.length > 0) blockingAvailable += 1;
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (n: number) => `${((100 * n) / Math.max(1, turns)).toFixed(0)}%`;
console.log(`engine turns: ${turns}`);
console.log(`  imminent (stage 3 fires today):        ${imminent} (${pct(imminent)})`);
console.log(`  urgent but not imminent (ignored):     ${urgentOnly} (${pct(urgentOnly)})`);
console.log(`    ...of those, with a blocking move:   ${blockingAvailable}`);
