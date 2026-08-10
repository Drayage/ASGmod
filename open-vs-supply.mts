/**
 * Does opening on the professional point actually buy the seal supply?
 *
 * The human plays 3.32 of their first six stones on the (1,2) point and the
 * engine 1.03, and the human has a four-cell seal on the table on 13% of level
 * middle-game turns against the engine's 0%. Two differences between the same
 * two players is not a link — pooling them would only rediscover which player is
 * which. So this correlates them *within* each side: across that side's own
 * games, does opening on the point more often go with more seal supply later?
 *
 *   npx vite-node open-vs-supply.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const FIRST = Number(process.env.FIRST ?? 6);
const FROM = Number(process.env.FROM ?? 21);
const TO = Number(process.env.TO ?? 30);

const classOf = (row: number, col: number) => {
  const dr = Math.min(row, 8 - row);
  const dc = Math.min(col, 8 - col);
  return dr <= dc ? `(${dr},${dc})` : `(${dc},${dr})`;
};

interface Point { pro: number; supply: number }
const points: Record<string, Point[]> = { human: [], ai: [] };

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const count: Record<string, number> = { human: 0, ai: 0 };
    const pro: Record<string, number> = { human: 0, ai: 0 };
    const supply: Record<string, number[]> = { human: [], ai: [] };

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
      if (m.type !== "PLACE") continue;
      const name = mover === human ? "human" : "ai";
      if (count[name] < FIRST) {
        count[name] += 1;
        if (classOf(m.row, m.col) === "(1,2)") pro[name] += 1;
      }
      if (turn >= FROM && turn <= TO) {
        supply[name].push(
          findSealingMoves(before, mover).reduce((n, s) => Math.max(n, s.gained.length), 0),
        );
      }
    }
    for (const name of ["human", "ai"]) {
      if (supply[name].length === 0) continue;
      points[name].push({
        pro: pro[name],
        supply: supply[name].reduce((a, b) => a + b, 0) / supply[name].length,
      });
    }
  }
}

void opponent;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function pearson(xs: number[], ys: number[]) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

console.log(
  `(1,2) stones in the first ${FIRST} moves against mean seal on offer, turns ${FROM}-${TO}\n` +
    `correlated inside each side, so the answer cannot just be which player it is\n`,
);
for (const name of ["human", "ai"]) {
  const p = points[name];
  const xs = p.map((q) => q.pro);
  const ys = p.map((q) => q.supply);
  const r = pearson(xs, ys);
  const t = r * Math.sqrt((p.length - 2) / (1 - r * r));
  console.log(
    `${name.padEnd(8)}${p.length} games   (1,2) mean ${mean(xs).toFixed(2)} (range ${Math.min(...xs)}-${Math.max(...xs)})   ` +
      `supply mean ${mean(ys).toFixed(2)}   r = ${r.toFixed(2)}, t = ${t.toFixed(2)}`,
  );
  // Split at the median so the shape is visible, not just the coefficient.
  const cut = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const low = p.filter((q) => q.pro < cut).map((q) => q.supply);
  const high = p.filter((q) => q.pro >= cut).map((q) => q.supply);
  if (low.length >= 3 && high.length >= 3) {
    console.log(
      `        fewer than ${cut}: supply ${mean(low).toFixed(2)} (${low.length} games)   ` +
        `${cut} or more: ${mean(high).toFixed(2)} (${high.length})`,
    );
  }
}
