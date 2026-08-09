/**
 * How far short of the cut does a human edge move fall?
 *
 * `edge-candidate.mts` found that 81% of the human's first-line moves never
 * enter the engine's 14-move candidate list. This sizes the shortfall: the gap
 * in `localMoveScore` between the move the human played and the 14th-best move
 * at the same position, so any bonus proposed for the edge can be set against
 * what it would actually have to overcome — and against how many non-edge moves
 * the same bonus would drag in with it.
 *
 *   npx vite-node edge-gap.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { localMoveScore } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const ROOT_LIMIT = 14;
const gaps: number[] = [];
/** For each candidate bonus, how many of the missed edge moves it recovers. */
const BONUSES = [2, 4, 6, 8, 12, 20];
const recovered = new Array(BONUSES.length).fill(0);
let missed = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (m.type === "PLACE" && state.currentPlayer === human) {
        const line = Math.min(m.row, m.col, 8 - m.row, 8 - m.col);
        if (line === 0) {
          const scored = getLegalMoves(state, human)
            .map((mv) => ({
              key: `${mv.row},${mv.col}`,
              line: Math.min(mv.row, mv.col, 8 - mv.row, 8 - mv.col),
              score: localMoveScore(state.board, mv.row, mv.col, human),
            }))
            .sort((a, b) => b.score - a.score);
          const played = scored.find((s) => s.key === `${m.row},${m.col}`)!;
          const cut = scored[Math.min(ROOT_LIMIT, scored.length) - 1].score;
          if (played.score < cut) {
            missed += 1;
            gaps.push(cut - played.score);
            // Re-rank with the bonus applied to every first-line move, so the
            // count reflects the competition it also promotes, not just itself.
            BONUSES.forEach((bonus, i) => {
              const withBonus = scored
                .map((s) => ({ ...s, score: s.score + (s.line === 0 ? bonus : 0) }))
                .sort((a, b) => b.score - a.score);
              if (withBonus.slice(0, ROOT_LIMIT).some((s) => s.key === played.key)) recovered[i] += 1;
            });
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

gaps.sort((a, b) => a - b);
const q = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
console.log(`human first-line moves that missed the top ${ROOT_LIMIT}: ${missed}`);
console.log(`shortfall in localMoveScore — median ${q(0.5)}, 75th ${q(0.75)}, 90th ${q(0.9)}, max ${gaps[gaps.length - 1]}`);
console.log(`\nfirst-line bonus   recovers`);
BONUSES.forEach((b, i) => {
  console.log(`${String(`+${b}`).padStart(16)}${`${recovered[i]} / ${missed} (${((recovered[i] / missed) * 100).toFixed(0)}%)`.padStart(20)}`);
});
