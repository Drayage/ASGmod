/**
 * Not whether a seal is taken — whether one is there at all.
 *
 * Reading the collapse window of the 10 August game move by move: the human's
 * three big gains are all seals, I4 for four cells at turn 13, F1 for six at 15,
 * A4 for four at 23, and each drops the engine's own margin by four to six. The
 * engine agrees with two of them outright — asked from the human's seat it plays
 * the same move.
 *
 * What the engine never has is one of its own. Its largest available seal reads
 * "1 at G8" on turns 10, 12, 14, 18, 20 and 22 — six turns running, one cell
 * each.
 *
 * Every seal measurement so far asked what each side did with an offer. This
 * asks what was on the table, which is a property of the position before anyone
 * chooses, and therefore of the shapes each side has built.
 *
 *   npx vite-node seal-supply.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const BANDS = [1, 11, 21, 31, 41] as const;
const label = (i: number) => (i === BANDS.length - 1 ? `${BANDS[i]}+` : `${BANDS[i]}-${BANDS[i + 1] - 1}`);
const bandOf = (t: number) => {
  for (let i = BANDS.length - 1; i >= 0; i -= 1) if (t >= BANDS[i]) return i;
  return 0;
};

const best: Record<string, number[][]> = { human: BANDS.map(() => []), ai: BANDS.map(() => []) };
const big: Record<string, number[]> = { human: BANDS.map(() => 0), ai: BANDS.map(() => 0) };
const turns: Record<string, number[]> = { human: BANDS.map(() => 0), ai: BANDS.map(() => 0) };
/** The single largest seal each side was ever offered, per game. */
const peak: Record<string, number[]> = { human: [], ai: [] };
/**
 * The same thing conditioned on the score, because that is what dissolved the
 * room-size finding: holding a big frame turned out to mean nothing more than
 * being ahead. If having a four-cell seal on the table is also just what being
 * ahead looks like, this is another symptom and has to be called one.
 */
const LEADS = [-99, -6, -2, 2, 6] as const;
const leadLabel = (i: number) =>
  i === 0 ? "behind 6+" : i === LEADS.length - 1 ? "ahead 6+" : `${LEADS[i]} to ${LEADS[i + 1] - 1}`;
const leadBand = (v: number) => {
  for (let i = LEADS.length - 1; i >= 0; i -= 1) if (v >= LEADS[i]) return i;
  return 0;
};
const byLead: Record<string, number[][]> = {
  human: LEADS.map(() => []),
  ai: LEADS.map(() => []),
};

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const human: Player = rec.playerSide;
    const gamePeak: Record<string, number> = { human: 0, ai: 0 };

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

      const name = mover === human ? "human" : "ai";
      const b = bandOf(turn);
      const largest = findSealingMoves(before, mover).reduce((n, s) => Math.max(n, s.gained.length), 0);
      best[name][b].push(largest);
      turns[name][b] += 1;
      if (largest >= 4) big[name][b] += 1;
      gamePeak[name] = Math.max(gamePeak[name], largest);
      const lead =
        before.territories[mover].length - before.territories[opponent(mover)].length;
      byLead[name][leadBand(lead)].push(largest);
    }
    peak.human.push(gamePeak.human);
    peak.ai.push(gamePeak.ai);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`the largest seal on the table when each side moves — ${games} games decided by the count\n`);
console.log(`${"turns".padEnd(22)}${BANDS.map((_, i) => label(i).padStart(10)).join("")}`);
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, mean cells`.padEnd(22)}${best[name].map((xs) => (xs.length ? mean(xs).toFixed(2) : "-").padStart(10)).join("")}`);
}
for (const name of ["human", "ai"]) {
  console.log(`${`${name}, 4+ available`.padEnd(22)}${big[name].map((c, i) => pct(c, turns[name][i]).padStart(10)).join("")}`);
}
console.log(
  `\nlargest seal ever on offer in a game: human ${mean(peak.human).toFixed(1)} cells, ai ${mean(peak.ai).toFixed(1)}`,
);

console.log(`\nsame, conditioned on the mover's settled lead`);
console.log(`${"side".padEnd(18)}${LEADS.map((_, i) => leadLabel(i).padStart(15)).join("")}`);
for (const name of ["human", "ai"]) {
  console.log(
    `${`${name}, mean cells`.padEnd(18)}` +
      byLead[name].map((xs) => (xs.length ? `${mean(xs).toFixed(2)} (${xs.length})` : "-").padStart(15)).join(""),
  );
}
for (const name of ["human", "ai"]) {
  console.log(
    `${`${name}, 4+ available`.padEnd(18)}` +
      byLead[name]
        .map((xs) => (xs.length ? pct(xs.filter((n) => n >= 4).length, xs.length) : "-").padStart(15))
        .join(""),
  );
}
