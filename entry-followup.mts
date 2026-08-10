/**
 * The player's diagnosis: it goes in, does not make itself a way to live, and
 * waits for the squeeze.
 *
 * That is a claim about timing, and timing is measurable. For every stone played
 * into ground the other side's influence owned, this follows the mover's own
 * turns forward and asks when the first reinforcement lands near it — and, the
 * part that matters, whether the group was still comfortable at that moment or
 * already down to its last liberties.
 *
 * A follow-up while the group still breathes is a base being built. A follow-up
 * once it is down to two liberties is an answer to a threat, and by then the
 * shape is whatever the opponent has left it.
 *
 *   npx vite-node entry-followup.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const NEAR = Number(process.env.NEAR ?? 2);
const TIGHT = Number(process.env.TIGHT ?? 2);

interface Entry {
  side: string;
  /** Own turns between the entry and the first stone played near it. */
  wait: number | null;
  /** Liberties the group had when that reinforcement landed. */
  roomThen: number | null;
  /** It was already down to TIGHT or fewer by then. */
  reactive: boolean;
  /** Liberties the group had one own-turn after entering, before any answer. */
  roomAfter: number;
  died: boolean;
  room: number;
  /** Enemy stones minus own stones within NEAR at the moment it landed. */
  behind: number;
}

const all: Entry[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    // Two passes: find the entries, then walk the game once more tracking each.
    const states: GameState[] = [];
    const moves: Array<{ mover: Player; row: number; col: number } | null> = [];
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      states.push(state);
      moves.push(m.type === "PLACE" ? { mover: state.currentPlayer, row: m.row!, col: m.col! } : null);
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const final = state;
    const dead = new Set(
      ((final.capturedGroup ?? []) as Array<{ row: number; col: number }>).map(
        (c) => `${c.row},${c.col}`,
      ),
    );

    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      if (!move) continue;
      const owners = influenceOwnerMap(states[i].board);
      if (owners[move.row * 9 + move.col] !== opponent(move.mover)) continue;

      // Walk this mover's later turns, watching the group and looking for the
      // first stone played beside it.
      let wait: number | null = null;
      let roomThen: number | null = null;
      let turns = 0;
      let roomAfter = -1;
      for (let j = i + 1; j < moves.length; j += 1) {
        const later = moves[j];
        const board = states[j].board;
        if (board[move.row][move.col] !== playerCell(move.mover)) break;
        const group = getConnectedGroup(board, move.row, move.col);
        const room = getGroupLiberties(board, group).size;
        if (!later || later.mover !== move.mover) continue;
        turns += 1;
        if (roomAfter < 0) roomAfter = room;
        const near =
          Math.max(Math.abs(later.row - move.row), Math.abs(later.col - move.col)) <= NEAR;
        if (near) {
          wait = turns;
          roomThen = room;
          break;
        }
      }

      let support = 0;
      let against = 0;
      for (let r = 0; r < 9; r += 1) {
        for (let c = 0; c < 9; c += 1) {
          const cell = states[i].board[r][c];
          if (cell !== "PLAYER_A" && cell !== "PLAYER_B") continue;
          if (Math.max(Math.abs(r - move.row), Math.abs(c - move.col)) > NEAR) continue;
          if (cell === playerCell(move.mover)) support += 1;
          else against += 1;
        }
      }

      const group = getConnectedGroup(final.board, move.row, move.col);
      all.push({
        behind: against - support,
        side: nameOf(move.mover),
        wait,
        roomThen,
        reactive: roomThen !== null && roomThen <= TIGHT,
        roomAfter: roomAfter < 0 ? 0 : roomAfter,
        died: dead.has(`${move.row},${move.col}`),
        room: getGroupLiberties(final.board, group).size,
      });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

console.log(`after going into their ground, when does the next stone land nearby?`);
console.log(`${all.length} entries, "nearby" is ${NEAR} steps, "tight" is ${TIGHT} liberties\n`);
console.log(
  `${"side".padEnd(8)}${"n".padStart(6)}${"followed up".padStart(13)}${"own turns later".padStart(17)}` +
    `${"room when it did".padStart(18)}${"only once tight".padStart(17)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side);
  const answered = g.filter((e) => e.wait !== null);
  console.log(
    `${side.padEnd(8)}${String(g.length).padStart(6)}` +
      `${pct(answered.length, g.length).padStart(13)}` +
      `${mean(answered.map((e) => e.wait!)).toFixed(2).padStart(17)}` +
      `${mean(answered.map((e) => e.roomThen!)).toFixed(2).padStart(18)}` +
      `${pct(g.filter((e) => e.reactive).length, answered.length).padStart(17)}`,
  );
}

console.log(`\nand what that timing was worth\n`);
console.log(
  `${"side".padEnd(8)}${"first answer".padStart(20)}${"n".padStart(6)}` +
    `${"ended in a dead group".padStart(23)}${"final room".padStart(12)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side);
  for (const [label, pick] of [
    ["next turn", (e: Entry) => e.wait === 1],
    ["within three", (e: Entry) => e.wait !== null && e.wait > 1 && e.wait <= 3],
    ["later than that", (e: Entry) => e.wait !== null && e.wait > 3],
    ["never", (e: Entry) => e.wait === null],
  ] as Array<[string, (e: Entry) => boolean]>) {
    const x = g.filter(pick);
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(20)}${String(x.length).padStart(6)}` +
        `${pct(x.filter((e) => e.died).length, x.length).padStart(23)}` +
        `${mean(x.map((e) => e.room)).toFixed(2).padStart(12)}`,
    );
  }
}

console.log(`\nsplit by whether the answer came before or after it got tight\n`);
console.log(
  `${"side".padEnd(8)}${"answer".padStart(20)}${"n".padStart(6)}` +
    `${"ended in a dead group".padStart(23)}${"final room".padStart(12)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side && e.wait !== null);
  for (const [label, pick] of [
    ["while it breathed", (e: Entry) => !e.reactive],
    ["only once tight", (e: Entry) => e.reactive],
  ] as Array<[string, (e: Entry) => boolean]>) {
    const x = g.filter(pick);
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(20)}${String(x.length).padStart(6)}` +
        `${pct(x.filter((e) => e.died).length, x.length).padStart(23)}` +
        `${mean(x.map((e) => e.room)).toFixed(2).padStart(12)}`,
    );
  }
}

// The aggregate says the engine answers sooner than the player and while the
// group still breathes, so the account does not hold over all 623 entries. But
// the deaths do not live in all 623 — they live in the entries made while
// outnumbered, which is where the last section found them. Same timing question,
// asked only there.
console.log(`\nthe same timing, restricted to entries made outnumbered by two or more\n`);
console.log(
  `${"side".padEnd(8)}${"n".padStart(6)}${"followed up".padStart(13)}${"own turns later".padStart(17)}` +
    `${"room when it did".padStart(18)}${"only once tight".padStart(17)}${"died".padStart(8)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side && e.behind >= 2);
  const answered = g.filter((e) => e.wait !== null);
  if (g.length === 0) continue;
  console.log(
    `${side.padEnd(8)}${String(g.length).padStart(6)}` +
      `${pct(answered.length, g.length).padStart(13)}` +
      `${mean(answered.map((e) => e.wait!)).toFixed(2).padStart(17)}` +
      `${mean(answered.map((e) => e.roomThen!)).toFixed(2).padStart(18)}` +
      `${pct(g.filter((e) => e.reactive).length, Math.max(1, answered.length)).padStart(17)}` +
      `${pct(g.filter((e) => e.died).length, g.length).padStart(8)}`,
  );
}
