/**
 * Do humans stake out corners early, and how many?
 *
 * The player's proposal: after the opening, if the opponent takes a corner, go
 * to a different one, so the game starts with at least two corners held on the
 * professional point. Before building that, the records can say whether it is
 * what people actually do.
 *
 * A cell's class is the sorted pair of its distances to the nearest horizontal
 * and vertical edge, so the opening point the book now uses is class (1,2). A
 * corner is a quadrant: both coordinates on the same side of the centre line.
 *
 *   npx vite-node corners.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const FIRST = Number(process.env.FIRST ?? 6);

const cornerOf = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;
const classOf = (row: number, col: number) => {
  const dr = Math.min(row, 8 - row);
  const dc = Math.min(col, 8 - col);
  return dr <= dc ? `(${dr},${dc})` : `(${dc},${dr})`;
};

interface Side {
  games: number;
  corners: number[];
  proPoints: number[];
  /** Of the mover's first FIRST stones, how many opened a corner nobody held. */
  fresh: number[];
  /** Turn on which the mover first had two different corners of their own. */
  secondCornerTurn: number[];
}
const blank = (): Side => ({ games: 0, corners: [], proPoints: [], fresh: [], secondCornerTurn: [] });
const sides: Record<string, Side> = { human: blank(), ai: blank() };
const classCount: Record<string, Map<string, number>> = { human: new Map(), ai: new Map() };

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const mine: Record<string, Set<string>> = { human: new Set(), ai: new Set() };
    const theirs: Record<string, Set<string>> = { human: new Set(), ai: new Set() };
    const count: Record<string, number> = { human: 0, ai: 0 };
    const pro: Record<string, number> = { human: 0, ai: 0 };
    const fresh: Record<string, number> = { human: 0, ai: 0 };
    const second: Record<string, number> = { human: 0, ai: 0 };

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;
      const name = mover === human ? "human" : "ai";
      const other = name === "human" ? "ai" : "human";
      if (count[name] >= FIRST) continue;
      count[name] += 1;

      const corner = cornerOf(m.row, m.col);
      const cls = classOf(m.row, m.col);
      classCount[name].set(cls, (classCount[name].get(cls) ?? 0) + 1);
      if (cls === "(1,2)") pro[name] += 1;
      if (corner) {
        const isNew = !mine[name].has(corner);
        if (isNew && !theirs[name].has(corner)) fresh[name] += 1;
        mine[name].add(corner);
        theirs[other].add(corner);
        if (mine[name].size === 2 && second[name] === 0) second[name] = turn;
      }
    }
    for (const name of ["human", "ai"]) {
      const s = sides[name];
      s.games += 1;
      s.corners.push(mine[name].size);
      s.proPoints.push(pro[name]);
      s.fresh.push(fresh[name]);
      if (second[name] > 0) s.secondCornerTurn.push(second[name]);
    }
  }
}

void opponent;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`the first ${FIRST} stones of each side, ${sides.human.games} games\n`);
console.log(
  `${"side".padEnd(8)}${"corners held".padStart(14)}${"(1,2) points".padStart(14)}` +
    `${"corners opened".padStart(16)}${"reached 2 corners".padStart(19)}${"on turn".padStart(9)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${mean(s.corners).toFixed(2).padStart(14)}${mean(s.proPoints).toFixed(2).padStart(14)}` +
      `${mean(s.fresh).toFixed(2).padStart(16)}` +
      `${pct(s.secondCornerTurn.length, s.games).padStart(19)}` +
      `${(s.secondCornerTurn.length ? mean(s.secondCornerTurn).toFixed(1) : "-").padStart(9)}`,
  );
}
console.log(`\nwhere those stones land, by class`);
for (const name of ["human", "ai"]) {
  const total = [...classCount[name].values()].reduce((a, b) => a + b, 0);
  const parts = [...classCount[name].entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k} ${pct(v, total)}`);
  console.log(`  ${name.padEnd(8)}${parts.join("   ")}`);
}
