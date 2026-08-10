/**
 * When does the settled lead actually open up?
 *
 * Conditioning on the score dissolved the room-size finding: at equal settled
 * lead the two sides hold rooms of the same size in every phase where both
 * occur. What the same table shows instead is that they barely occupy the same
 * scores at all — by 30-39 stones the human is six or more ahead on settled
 * ground in 118 positions and the engine in none.
 *
 * So the divergence is in settled territory and it happens earlier. This tracks
 * it directly: settled cells per side against stones on the board, and the turn
 * each side first settles anything at all.
 *
 *   npx vite-node settle-timing.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const PHASES = [10, 20, 25, 30, 35, 40, 50] as const;
const phaseLabel = (i: number) =>
  i === PHASES.length - 1 ? `${PHASES[i]}+` : `${PHASES[i]}-${PHASES[i + 1] - 1}`;
const bandOf = (v: number) => {
  for (let i = PHASES.length - 1; i >= 0; i -= 1) if (v >= PHASES[i]) return i;
  return -1;
};

const settled: Record<string, number[][]> = {
  human: PHASES.map(() => []),
  ai: PHASES.map(() => []),
};
/** Turns on which a seal of 2+ cells was on offer, cumulative by phase. */
const offers: Record<string, number[][]> = {
  human: PHASES.map(() => []),
  ai: PHASES.map(() => []),
};
const firstSettle: Record<string, number[]> = { human: [], ai: [] };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;
    const first: Record<string, number | null> = { human: null, ai: null };
    const seenOffer: Record<string, number> = { human: 0, ai: 0 };

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });

      const moverName = mover === humanSide ? "human" : "ai";
      if (findSealingMoves(before, mover).some((s) => s.gained.length >= 2)) {
        seenOffer[moverName] += 1;
      }

      let stones = 0;
      for (const row of state.board) for (const cell of row) if (cell !== "EMPTY") stones += 1;
      const band = bandOf(stones);
      if (band < 0) continue;
      for (const side of ["A", "B"] as Player[]) {
        const name = side === humanSide ? "human" : "ai";
        const cells = state.territories[side].length;
        settled[name][band].push(cells);
        offers[name][band].push(seenOffer[name]);
        if (cells > 0 && first[name] === null) first[name] = turn;
      }
    }
    for (const name of ["human", "ai"]) {
      if (first[name] !== null) firstSettle[name].push(first[name]!);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`settled territory against stones on the board — ${games} games decided by the count\n`);
console.log(`${"stones".padEnd(16)}${PHASES.map((_, i) => phaseLabel(i).padStart(9)).join("")}`);
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, settled`.padEnd(16)}${settled[name].map((xs) => (xs.length ? mean(xs).toFixed(1) : "-").padStart(9)).join("")}`);
}
console.log(
  `${"gap".padEnd(16)}` +
    settled.human
      .map((xs, i) => (xs.length && settled.ai[i].length ? (mean(xs) - mean(settled.ai[i])).toFixed(1) : "-").padStart(9))
      .join(""),
);
console.log();
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, 2+ seals offered so far`.padEnd(30)}${offers[name].map((xs) => (xs.length ? mean(xs).toFixed(1) : "-").padStart(9)).join("")}`);
}
console.log(
  `\nfirst turn either side settles anything: human ${mean(firstSettle.human).toFixed(1)} ` +
    `(${firstSettle.human.length} games), ai ${mean(firstSettle.ai).toFixed(1)} (${firstSettle.ai.length} games)`,
);
