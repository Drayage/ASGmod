/**
 * Does the eye-space term stop the engine playing its own eye, and does the
 * group then live?
 *
 * Judged on the positions, not on a rate — the rate disagreed with itself
 * across builds and is not evidence. Two questions per weight: the move at the
 * turns that decided each game, and the outcome of playing on from there.
 */
import { readFileSync } from "node:fs";
import { applyAction, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const F = process.argv[2]!;
const WEIGHTS = (process.env.WEIGHTS ?? "0,25,60").split(",").map(Number);
const PLIES = Number(process.env.PLIES ?? 14);

for (const [game, point, eye, turns] of [
  ["1", "C8", "C9", [11, 13]],
  ["2", "D8", "D9", [9, 11, 13]],
] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const human: Player = rec.playerSide;
  const ai = opponent(human);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };
  console.log(`\ngame ${game}: group ${point}, its eye point would be ${eye}`);

  let state: GameState = createInitialState();
  const saved = new Map<number, GameState>();
  for (const m of rec.moveHistory) {
    if (state.winner) break;
    if ((turns as readonly number[]).includes(m.turn) && state.currentPlayer === ai) {
      saved.set(m.turn, state);
      const played = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
      const picks = WEIGHTS.map((w) => {
        tuning.eyeSpaceWeight = w;
        const mv = findBestMoveVeryHard(state, ai, 3000);
        const at = mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS";
        return `w${w}:${at}${at === eye ? "!" : " "}`;
      });
      tuning.eyeSpaceWeight = 0;
      console.log(`  turn ${String(m.turn).padStart(2)} played ${played.padEnd(4)}  ${picks.join("  ")}`);
    }
    state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
  }

  const from = turns[0];
  const base = saved.get(from)!;
  console.log(`  playing on from turn ${from}, both sides searching:`);
  for (const w of WEIGHTS) {
    tuning.eyeSpaceWeight = w;
    let s = base;
    let outcome = "no capture";
    for (let ply = 0; ply < PLIES; ply += 1) {
      s = applyAction(s, findBestMoveVeryHard(s, s.currentPlayer, 3000));
      if (s.winner) { outcome = s.winner === ai ? "engine WINS by capture" : "engine LOSES by capture"; break; }
    }
    const g = getConnectedGroup(s.board, anchor.row, anchor.col);
    console.log(
      `    w${String(w).padStart(2)}: ${outcome.padEnd(24)}` +
        ` group ${g.length ? `alive on ${getGroupLiberties(s.board, g).size} liberties` : "GONE"}`,
    );
  }
  tuning.eyeSpaceWeight = 0;
}
console.log(`\n  "!" marks the engine playing the eye point itself — the losing move`);
