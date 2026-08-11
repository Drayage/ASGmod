/**
 * Which stage was answering when the engine walked past six cells?
 *
 * §72 counted it: on turns where a safe seal of three or more cells was on the
 * board, the engine closed nothing on 67% of them, and in one game it passed the
 * same six-cell point five times. Two very different repairs follow depending on
 * why:
 *
 *   - the stage that knows about ground never fired, because something above it
 *     in the ladder answered first — a repair to the ladder's order;
 *   - it did fire and preferred a different move, or the full search ran and
 *     valued something else above six settled cells — a repair to what things
 *     are worth.
 *
 * So this replays the engine on exactly those positions, with the variant the
 * game was played under, and records the stage that answered and whether the
 * move it picks now closes anything.
 *
 *   npx vite-node seal-declined.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const LEAST = Number(process.env.LEAST ?? 3);
const THINK = Number(process.env.THINK ?? 1500);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

const stages = new Map<string, { turns: number; nowTakes: number; cells: number }>();
const examples: string[] = [];
const seen = new Set<string>();
let looked = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      ply += 1;
      if (mover === engine && m.type === "PLACE") {
        const seals = findSealingMoves(state, engine);
        const best = seals[0];
        if (best && best.gained.length >= LEAST) {
          const mine = seals.find((s) => s.move.row === m.row && s.move.col === m.col);
          const took = mine ? mine.gained.length : 0;
          if (best.gained.length - took >= LEAST) {
            const after = applyAction(state, { type: "PLACE", ...best.move });
            const safe = !after.winner && !opponentCanForceCapture(after, engine, 7, 300);
            if (safe) {
              looked += 1;
              const pick = findBestMoveVeryHard(state, engine, THINK);
              const stage = lastDecision.stage;
              const nowSeal =
                pick.type === "PLACE"
                  ? seals.find((s) => s.move.row === pick.row && s.move.col === pick.col)
                  : undefined;
              const entry = stages.get(stage) ?? { turns: 0, nowTakes: 0, cells: 0 };
              entry.turns += 1;
              entry.cells += best.gained.length;
              if (nowSeal && nowSeal.gained.length >= best.gained.length) entry.nowTakes += 1;
              stages.set(stage, entry);
              if (examples.length < 10) {
                examples.push(
                  `  ply ${String(ply).padStart(3)}  ${stage.padEnd(24)}` +
                    `passed ${nm(best.move.row, best.move.col)} worth ${best.gained.length}` +
                    `, now plays ${pick.type === "PLACE" ? nm(pick.row, pick.col) : "PASS"}` +
                    ` closing ${nowSeal ? nowSeal.gained.length : 0}`,
                );
              }
            }
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

console.log(`turns where the engine passed a safe seal of ${LEAST}+ cells: ${looked}\n`);
console.log(
  `${"stage that answered".padEnd(26)}${"turns".padStart(7)}${"share".padStart(8)}` +
    `${"seal it passed".padStart(16)}${"takes it on replay".padStart(20)}`,
);
for (const [stage, e] of [...stages.entries()].sort((a, b) => b[1].turns - a[1].turns)) {
  console.log(
    `${stage.padEnd(26)}${String(e.turns).padStart(7)}` +
      `${`${Math.round((100 * e.turns) / looked)}%`.padStart(8)}` +
      `${(e.cells / e.turns).toFixed(1).padStart(16)}` +
      `${`${e.nowTakes} (${Math.round((100 * e.nowTakes) / e.turns)}%)`.padStart(20)}`,
  );
}
console.log(`\nthe first few, as they happened\n`);
for (const line of examples) console.log(line);
