/**
 * Did the corner budget change actually take effect?
 *
 * The threshold written down for it was the uncontested corner — stones in,
 * cells out. The batch that came back has no uncontested corners at all: the
 * player contested all sixteen. So that threshold cannot be read, and the
 * question has to be asked of the engine directly instead of the outcome.
 *
 * This replays each of the engine's opening turns and records which stage of the
 * ladder answered. The book only ever moves inside the first handful of stones,
 * so counting how often stage 1.88 fires per game says plainly whether the
 * raised budget is being spent — regardless of what the player then does to the
 * corner.
 *
 *   npx vite-node book-fired.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const TURNS = Number(process.env.TURNS ?? 10);
const THINK = Number(process.env.THINK ?? 1200);

const counts = new Map<string, Map<string, number>>();
const games = new Map<string, number>();
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    const variant = (rec.aiVariant ?? "EYE") as AIVariant;
    applyAIVariant(variant);
    games.set(variant, (games.get(variant) ?? 0) + 1);
    counts.set(variant, counts.get(variant) ?? new Map());

    let state: GameState = createInitialState();
    let own = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        own += 1;
        if (own > TURNS) break;
        findBestMoveVeryHard(state, engine, THINK);
        const tally = counts.get(variant)!;
        tally.set(lastDecision.stage, (tally.get(lastDecision.stage) ?? 0) + 1);
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

console.log(`which stage answers the engine's first ${TURNS} turns, by variant\n`);
for (const [variant, tally] of counts) {
  const n = games.get(variant)!;
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  console.log(`${variant}  (${n} game${n === 1 ? "" : "s"}, ${total} turns replayed)`);
  for (const [stage, hits] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `    ${stage.padEnd(26)}${String(hits).padStart(4)}` +
        `${`${(hits / n).toFixed(1)} per game`.padStart(16)}`,
    );
  }
  console.log();
}
