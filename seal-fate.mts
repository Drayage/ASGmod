/**
 * When the engine declines a seal, does it actually lose anything?
 *
 * A 26% take rate is only a defect if the declined ground goes away. The player
 * described their own habit as the opposite: a seal that survives a blocking
 * move is not urgent, so they leave it and play elsewhere. By that standard a
 * low take rate is correct play, and the count of declines says nothing on its
 * own.
 *
 * So follow each opportunity to its end instead of counting it once. For every
 * point that is a 2+ cell seal for the engine on some turn, record what
 * eventually happened to it:
 *
 *   taken       the engine played it later — declining cost nothing but tempo
 *   lost        the opponent played it, or it stopped being a seal
 *   unplayed    still available when the game ended — cells left on the board
 *
 *   npx vite-node seal-fate.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const C = "ABCDEFGHI";
const key = (r: number, c: number) => `${C[c]}${r + 1}`;

interface Opp { size: number; firstTurn: number; fate: string; lostTo?: string; }
const byBuild = new Map<string, Opp[]>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    const build = rec.appVersion ?? "?";
    const list = byBuild.get(build) ?? [];
    byBuild.set(build, list);
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    /** Seal points seen for the AI, by point, with the largest size seen. */
    const seen = new Map<string, Opp>();
    let state: GameState = createInitialState();

    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;

      if (mover === ai) {
        for (const s of findSealingMoves(state, ai)) {
          if (s.gained.length < 2) continue;
          const k = key(s.move.row, s.move.col);
          const prev = seen.get(k);
          if (!prev) {
            seen.set(k, { size: s.gained.length, firstTurn: m.turn, fate: "unplayed" });
          } else if (prev.fate === "unplayed" && s.gained.length > prev.size) {
            prev.size = s.gained.length;
          }
        }
      }

      if (m.type === "PLACE") {
        const k = key(m.row, m.col);
        const o = seen.get(k);
        if (o && o.fate === "unplayed") {
          o.fate = mover === ai ? "taken" : "lost";
          if (mover !== ai) o.lostTo = "opponent played it";
        }
      }

      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }

    // Anything still "unplayed": was it still a seal at the end, or had the
    // region simply stopped being sealable without anyone playing the point?
    for (const [k, o] of seen) {
      if (o.fate !== "unplayed") continue;
      const still = findSealingMoves(state, ai).some(
        (s) => key(s.move.row, s.move.col) === k && s.gained.length >= 2,
      );
      if (!still) { o.fate = "lost"; o.lostTo = "region stopped being sealable"; }
    }
    list.push(...seen.values());
  }
}

for (const [build, opps] of [...byBuild.entries()].sort((a, b) => a[1].length - b[1].length)) {
  const n = opps.length;
  const cells = (f: string) => opps.filter((o) => o.fate === f).reduce((s, o) => s + o.size, 0);
  const count = (f: string) => opps.filter((o) => o.fate === f).length;
  console.log(`\n=== ${build}: ${n} distinct seal opportunities for the AI`);
  for (const f of ["taken", "lost", "unplayed"]) {
    console.log(
      `  ${f.padEnd(10)}${String(count(f)).padStart(4)}  (${((count(f) / n) * 100).toFixed(0)}%)` +
        `   ${String(cells(f)).padStart(4)} cells`,
    );
  }
  const why = new Map<string, number>();
  for (const o of opps) if (o.fate === "lost") why.set(o.lostTo!, (why.get(o.lostTo!) ?? 0) + 1);
  for (const [w, c] of why) console.log(`     lost because: ${w} — ${c}`);
}
