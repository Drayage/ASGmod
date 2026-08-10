/**
 * How far is each side from having a four-cell seal to play?
 *
 * At equal settled score the human has a 4+ cell seal on the table on 13% of
 * their middle-game turns and the engine on 0% of 217. That is a fact about
 * shape, and the next question is how far away the shape is: a position one move
 * from offering one is a move-generation target, a position three moves away is
 * a different kind of problem.
 *
 * So this measures the distance. Zero if a 4+ seal is available now; one if some
 * legal move of the mover's own would make one available on their next turn; two
 * or more otherwise. The opponent replies in between and is ignored, which makes
 * this a threat count rather than a promise — equally so for both sides, which
 * is what the comparison needs.
 *
 *   STRIDE=2 npx vite-node seal-distance.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const TARGET = Number(process.env.TARGET ?? 4);
const STRIDE = Number(process.env.STRIDE ?? 2);
const FROM_TURN = Number(process.env.FROM_TURN ?? 11);
const TO_TURN = Number(process.env.TO_TURN ?? 40);

const largestSeal = (state: GameState, side: Player) =>
  findSealingMoves(state, side).reduce((n, s) => Math.max(n, s.gained.length), 0);

interface Side {
  turns: number; now: number; oneAway: number; further: number; makers: number[];
  /** Of the turns where a move existed that would create the threat, how often
   * the mover played one. The layer below "did you take the seal" — did you
   * build the thing that offers one. */
  playedMaker: number;
}
const blank = (): Side => ({ turns: 0, now: 0, oneAway: 0, further: 0, makers: [], playedMaker: 0 });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
let sampled = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const human: Player = rec.playerSide;

    const perSide: Record<string, number> = { human: 0, ai: 0 };
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
      if (turn < FROM_TURN || turn > TO_TURN) continue;
      // Count per side, not globally: turns alternate, so a global stride of two
      // samples one player and skips the other — the first run of this came back
      // 195 human turns against 90 and that is the reason, not the game.
      sampled += 1;
      perSide[mover === human ? "human" : "ai"] += 1;
      if (perSide[mover === human ? "human" : "ai"] % STRIDE !== 0) continue;

      const side = sides[mover === human ? "human" : "ai"];
      side.turns += 1;
      if (largestSeal(before, mover) >= TARGET) { side.now += 1; continue; }

      // One own move that leaves a 4+ seal standing for the next turn. The
      // opponent moves in between; this counts the threat, not the delivery.
      let makers = 0;
      let playedOne = false;
      for (const mv of getLegalMoves(before, mover)) {
        const after = applyAction(before, { type: "PLACE", row: mv.row, col: mv.col });
        if (after.winner) continue;
        if (largestSeal({ ...after, currentPlayer: mover }, mover) >= TARGET) {
          makers += 1;
          if (m.type === "PLACE" && mv.row === m.row && mv.col === m.col) playedOne = true;
        }
      }
      if (makers > 0) {
        side.oneAway += 1;
        side.makers.push(makers);
        if (playedOne) side.playedMaker += 1;
      } else side.further += 1;
    }
  }
}

void opponent;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(
  `distance to a ${TARGET}-cell seal, turns ${FROM_TURN}-${TO_TURN}, ${games} games decided by the count\n`,
);
console.log(
  `${"side".padEnd(8)}${"turns".padStart(8)}${"had one".padStart(12)}${"one move away".padStart(16)}` +
    `${"further".padStart(11)}${"moves that make one".padStart(21)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.turns).padStart(8)}${pct(s.now, s.turns).padStart(12)}` +
      `${pct(s.oneAway, s.turns).padStart(16)}${pct(s.further, s.turns).padStart(11)}` +
      `${(s.makers.length ? mean(s.makers).toFixed(1) : "-").padStart(21)}` +
      `${`${s.playedMaker}/${s.oneAway} (${pct(s.playedMaker, s.oneAway)})`.padStart(17)}`,
  );
}
