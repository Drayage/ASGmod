/**
 * After declining a seal, does the mover come back to it?
 *
 * Both sides decline seals at about the same rate — 4.0 distinct cells a game
 * for the human, 4.7 for the engine — so declining is not the mistake. What
 * differs is what the decline is worth afterwards: the human keeps 88% of the
 * declined cells and the wait buys a bigger region 28% of the time, against the
 * engine's 71% and 15%.
 *
 * The stated human intent is to draw small, and take the larger frame when the
 * opponent does not contest it. That is an option, and an option only pays if
 * you come back to exercise it. So this measures the follow-up: after a decline,
 * how soon does the mover play a stone touching that pocket's frontier, and how
 * often never at all.
 *
 *   npx vite-node decline-followup.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { DIRECTIONS, inBounds, opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);
/** How near a later stone must land to count as working on that pocket. */
const NEAR = Number(process.env.NEAR ?? 2);

interface Side {
  declines: number;
  /** Own moves until the first one played near the declined pocket. */
  gaps: number[];
  never: number;
  /** Times the opponent got there first. */
  contested: number;
}
const blank = (): Side => ({ declines: 0, gaps: [], never: 0, contested: 0 });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const chebyshev = (a: Coord, b: Coord) =>
  Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    // Every placement in order, so a decline can look forward from its turn.
    const placements: Array<{ player: Player; at: Coord }> = [];
    for (const m of rec.moveHistory) {
      if (m.type === "PLACE") placements.push({ player: m.player, at: { row: m.row, col: m.col } });
    }

    let state: GameState = createInitialState();
    let index = -1;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      if (m.type === "PLACE") index += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const seals = findSealingMoves(before, mover).filter((s) => s.gained.length >= MIN_CELLS);
      if (seals.length === 0) continue;
      if (seals.some((s) => s.move.row === m.row && s.move.col === m.col)) continue;

      const pocket = seals[0].gained;
      // The frontier of the declined pocket: its own cells plus the seal point.
      const area = [...pocket, seals[0].move];
      const side = sides[mover === human ? "human" : "ai"];
      side.declines += 1;

      let ownMoves = 0;
      let found = false;
      let contestedFirst = false;
      for (let i = index + 1; i < placements.length; i += 1) {
        const p = placements[i];
        const near = area.some((c) => chebyshev(c, p.at) <= NEAR);
        if (p.player !== mover) {
          if (near && !found) contestedFirst = true;
          continue;
        }
        ownMoves += 1;
        if (near) { side.gaps.push(ownMoves); found = true; break; }
      }
      if (!found) side.never += 1;
      if (contestedFirst) side.contested += 1;
    }
  }
}

void inBounds;
void DIRECTIONS;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`after declining a ${MIN_CELLS}+ cell seal (games decided by the count)\n`);
console.log(
  `${"side".padEnd(8)}${"declines".padStart(10)}${"came back".padStart(11)}` +
    `${"own moves later".padStart(17)}${"within 1".padStart(10)}${"never".padStart(8)}${"opp. got there first".padStart(22)}`,
);
for (const [name, s] of Object.entries(sides)) {
  const back = s.gaps.length;
  console.log(
    `${name.padEnd(8)}${String(s.declines).padStart(10)}${pct(back, s.declines).padStart(11)}` +
      `${mean(s.gaps).toFixed(1).padStart(17)}` +
      `${pct(s.gaps.filter((g) => g === 1).length, s.declines).padStart(10)}` +
      `${pct(s.never, s.declines).padStart(8)}` +
      `${pct(s.contested, s.declines).padStart(22)}`,
  );
}
