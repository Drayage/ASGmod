/**
 * The other half of the player's rule: you also have to check their corners.
 *
 * The corner book only builds our own — it claims an unopened corner and extends
 * along the frame, and it has nothing at all to say about a corner the opponent
 * has taken. So before adding that, the records can say what an approach is
 * worth: how often each side plays into a corner the other opened, how soon, and
 * what the opener ends up holding there when it happens versus when it doesn't.
 *
 * A corner is a quadrant, both coordinates on the same side of the centre line.
 * The opener is whoever puts the first stone in it; an approach is the other
 * side's first stone in the same quadrant. Territory is counted at the end of
 * the game, restricted to that quadrant, so it is what the corner actually
 * yielded rather than what it looked like it would.
 *
 *   npx vite-node rival-corner.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const cornerOf = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;

interface Corner {
  opener: Player;
  openedTurn: number;
  approachTurn: number | null;
  approacher?: Player;
  /** Stones the opener had put in before the approach landed. */
  headStart: number;
}

interface Side {
  /** Corners this side opened, by whether the other side ever came in. */
  approached: number[];
  alone: number[];
  /** How many of the other side's corners this side went into, per game. */
  approachesMade: number[];
  approachTurns: number[];
  /** Approaches that landed touching a defending stone, diagonals included. */
  contact: number;
  /** What the approacher itself ended up holding in that quadrant. */
  gained: number[];
  games: number;
}
const blank = (): Side => ({
  approached: [],
  alone: [],
  approachesMade: [],
  approachTurns: [],
  contact: 0,
  gained: [],
  games: 0,
});
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    const corners = new Map<string, Corner>();
    const stones: Record<string, number> = {};
    const made: Record<string, number> = { human: 0, ai: 0 };

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
      const corner = cornerOf(m.row, m.col);
      if (!corner) continue;
      const held = corners.get(corner);
      if (!held) {
        corners.set(corner, { opener: mover, openedTurn: turn, approachTurn: null, headStart: 0 });
        stones[`${corner}:${mover}`] = 1;
        continue;
      }
      if (mover === held.opener) {
        stones[`${corner}:${mover}`] = (stones[`${corner}:${mover}`] ?? 0) + 1;
        continue;
      }
      if (held.approachTurn === null) {
        held.approachTurn = turn;
        held.headStart = stones[`${corner}:${held.opener}`] ?? 0;
        held.approacher = mover;
        made[nameOf(mover)] += 1;
        sides[nameOf(mover)].approachTurns.push(turn);
        // Touching, diagonals included — the difference between leaning on their
        // stone and taking a point they have not reached yet.
        let touching = false;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const r = m.row! + dr;
            const c = m.col! + dc;
            if (r < 0 || r > 8 || c < 0 || c > 8) continue;
            if (state.board[r][c] === (held.opener === "A" ? "PLAYER_A" : "PLAYER_B")) touching = true;
          }
        }
        if (touching) sides[nameOf(mover)].contact += 1;
      }
    }

    // What each corner was worth to its opener once the game was over.
    for (const [corner, held] of corners) {
      const mine = state.territories[held.opener].filter(
        (c: { row: number; col: number }) => cornerOf(c.row, c.col) === corner,
      ).length;
      const s = sides[nameOf(held.opener)];
      if (held.approachTurn === null) s.alone.push(mine);
      else {
        s.approached.push(mine);
        const other = held.opener === "A" ? "B" : "A";
        sides[nameOf(other)].gained.push(
          state.territories[other].filter(
            (c: { row: number; col: number }) => cornerOf(c.row, c.col) === corner,
          ).length,
        );
      }
    }
    for (const name of ["human", "ai"]) {
      sides[name].games += 1;
      sides[name].approachesMade.push(made[name]);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const show = (xs: number[]) => (xs.length ? `${mean(xs).toFixed(1)} (n=${xs.length})` : "-");

console.log(`corners opened and corners entered, ${sides.human.games} games\n`);
console.log(
  `${"side".padEnd(8)}${"approaches made".padStart(17)}${"on turn".padStart(9)}` +
    `${"their corner kept, uncontested".padStart(32)}${"once entered".padStart(16)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${mean(s.approachesMade).toFixed(2).padStart(17)}` +
      `${(s.approachTurns.length ? mean(s.approachTurns).toFixed(1) : "-").padStart(9)}` +
      `${show(s.alone).padStart(32)}${show(s.approached).padStart(16)}`,
  );
}
console.log(
  `\nread as: the last two columns are what a corner yielded its opener, so the` +
    `\ndrop between them is what the other side's approach took away.\n`,
);
console.log(`what the approach was itself worth\n`);
console.log(
  `${"side".padEnd(8)}${"approaches".padStart(12)}${"landed touching".padStart(17)}` +
    `${"kept in that corner".padStart(21)}`,
);
for (const [name, s] of Object.entries(sides)) {
  const total = s.approachTurns.length;
  console.log(
    `${name.padEnd(8)}${String(total).padStart(12)}` +
      `${`${s.contact} (${total ? Math.round((100 * s.contact) / total) : 0}%)`.padStart(17)}` +
      `${show(s.gained).padStart(21)}`,
  );
}
