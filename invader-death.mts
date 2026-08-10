/**
 * The player's account: it walks into their area, they squeeze, it dies.
 *
 * That is a different claim from the one §54 measured. The slow squeeze there
 * was about the defence being unable to see the net closing. This is about the
 * decision to be there at all — and if it is right, the stones that die should
 * have been played into ground the opponent already owned, and some stage of the
 * ladder should be the one putting them there.
 *
 * So this takes every group the engine lost, finds the ply each of its stones
 * was played, and asks two things at that moment: whose influence did the cell
 * belong to, and which stage of the ladder chose it. The engine is replayed on
 * the real position with its own variant, so the stage is the one that actually
 * answered rather than a guess.
 *
 *   npx vite-node invader-death.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 3000);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

/** Chebyshev distance to the nearest stone of `side`, or 9 if it has none. */
function nearest(state: GameState, side: Player, row: number, col: number): number {
  const mine = side === "A" ? "PLAYER_A" : "PLAYER_B";
  let best = 9;
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (state.board[r][c] !== mine) continue;
      best = Math.min(best, Math.max(Math.abs(r - row), Math.abs(c - col)));
    }
  }
  return best;
}

const seen = new Set<string>();
const stages = new Map<string, number>();
let entered = 0;
let total = 0;

console.log(`every stone of every group the engine lost, as it was played\n`);
console.log(
  `${"variant".padEnd(18)}${"ply".padStart(5)}${"stone".padStart(7)}` +
    `${"influence".padStart(11)}${"to theirs".padStart(11)}${"to ours".padStart(9)}` +
    `${"stage that chose it".padStart(24)}`,
);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    if (rec.winReason !== "CAPTURE" || rec.winner !== human) continue;
    const variant = (rec.aiVariant ?? "EYE") as AIVariant;
    applyAIVariant(variant);

    // Replay once to find the group that died, then again to catch the moment
    // each of its stones was played.
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const group = (state.capturedGroup ?? []) as Array<{ row: number; col: number }>;
    if (group.length === 0) continue;
    const doomed = new Set(group.map((c) => `${c.row},${c.col}`));

    state = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      ply += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;
      if (mover !== engine) continue;
      if (!doomed.has(`${m.row},${m.col}`)) continue;

      const owners = influenceOwnerMap(before.board);
      const owner = owners[m.row! * 9 + m.col!];
      const theirs = nearest(before, human, m.row!, m.col!);
      const ours = nearest(before, engine, m.row!, m.col!);

      findBestMoveVeryHard(before, engine, THINK);
      const stage = lastDecision.stage;
      stages.set(stage, (stages.get(stage) ?? 0) + 1);
      total += 1;
      if (owner === human) entered += 1;

      console.log(
        `${variant.padEnd(18)}${String(ply).padStart(5)}${nm(m.row!, m.col!).padStart(7)}` +
          `${(owner === null ? "-" : owner === human ? "theirs" : "ours").padStart(11)}` +
          `${String(theirs).padStart(11)}${String(ours).padStart(9)}${stage.padStart(24)}`,
      );
    }
  }
}

console.log(
  `\n${entered} of ${total} stones that died were played into ground the opponent's` +
    `\ninfluence already owned.\n`,
);
console.log(`which stage chose them\n`);
for (const [stage, n] of [...stages.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stage.padEnd(24)}${String(n).padStart(4)} (${Math.round((100 * n) / total)}%)`);
}
