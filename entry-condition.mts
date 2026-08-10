/**
 * When is walking into their area fine, and when does it get you killed?
 *
 * §55 found the seed stones of every group the engine lost sitting in the
 * opponent's influence a step or two from their nearest stone, chosen by the
 * full search. But going in is not wrong in itself — the player does it too, and
 * §52 showed their approaches pay. So the question is not whether to enter but
 * under what conditions, and that is a measurable thing: how much of your own is
 * within reach, how much of theirs, and how it turned out.
 *
 * Every stone either side played into ground the other's influence owned gets
 * its local balance recorded at the moment it landed, and its fate read at the
 * end — whether the group it belongs to was the one that died, and how much
 * room that group finished with.
 *
 *   npx vite-node entry-condition.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const RADIUS = Number(process.env.RADIUS ?? 2);

interface Entry {
  side: string;
  /** Own and enemy stones within RADIUS at the moment it landed. */
  support: number;
  against: number;
  /** Chebyshev distance to the nearest enemy stone. */
  close: number;
  died: boolean;
  /** Liberties of the group it ended up in. */
  room: number;
  size: number;
}

const all: Entry[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    const pending: Array<{ row: number; col: number; e: Entry }> = [];
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const owners = influenceOwnerMap(before.board);
      const owner = owners[m.row! * 9 + m.col!];
      if (owner !== opponent(mover)) continue; // not an entry into their ground

      let support = 0;
      let against = 0;
      let close = 9;
      for (let r = 0; r < 9; r += 1) {
        for (let c = 0; c < 9; c += 1) {
          const cell = before.board[r][c];
          if (cell !== "PLAYER_A" && cell !== "PLAYER_B") continue;
          const d = Math.max(Math.abs(r - m.row!), Math.abs(c - m.col!));
          const mine = cell === playerCell(mover);
          if (!mine) close = Math.min(close, d);
          if (d > RADIUS) continue;
          if (mine) support += 1;
          else against += 1;
        }
      }
      const e: Entry = {
        side: nameOf(mover),
        support,
        against,
        close,
        died: false,
        room: 0,
        size: 0,
      };
      pending.push({ row: m.row!, col: m.col!, e });
    }

    const dead = new Set(
      ((state.capturedGroup ?? []) as Array<{ row: number; col: number }>).map(
        (c) => `${c.row},${c.col}`,
      ),
    );
    for (const { row, col, e } of pending) {
      const group = getConnectedGroup(state.board, row, col);
      e.size = group.length;
      e.room = getGroupLiberties(state.board, group).size;
      e.died = dead.has(`${row},${col}`);
      all.push(e);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

console.log(`stones played into ground the other side's influence owned, ${all.length} of them`);
console.log(`support and opposition counted within ${RADIUS} steps\n`);
console.log(
  `${"side".padEnd(8)}${"n".padStart(6)}${"support".padStart(10)}${"against".padStart(10)}` +
    `${"nearest foe".padStart(13)}${"ended in a dead group".padStart(23)}` +
    `${"group room".padStart(12)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side);
  console.log(
    `${side.padEnd(8)}${String(g.length).padStart(6)}${mean(g.map((e) => e.support)).toFixed(2).padStart(10)}` +
      `${mean(g.map((e) => e.against)).toFixed(2).padStart(10)}` +
      `${mean(g.map((e) => e.close)).toFixed(2).padStart(13)}` +
      `${pct(g.filter((e) => e.died).length, g.length).padStart(23)}` +
      `${mean(g.map((e) => e.room)).toFixed(2).padStart(12)}`,
  );
}

console.log(`\nby the local balance at the moment it landed\n`);
console.log(
  `${"side".padEnd(8)}${"balance".padStart(18)}${"n".padStart(6)}` +
    `${"ended in a dead group".padStart(23)}${"group room".padStart(12)}${"group size".padStart(12)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side);
  for (const [label, pick] of [
    ["outnumbered 2+", (e: Entry) => e.against - e.support >= 2],
    ["outnumbered by 1", (e: Entry) => e.against - e.support === 1],
    ["level or better", (e: Entry) => e.against <= e.support],
  ] as Array<[string, (e: Entry) => boolean]>) {
    const x = g.filter(pick);
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(18)}${String(x.length).padStart(6)}` +
        `${pct(x.filter((e) => e.died).length, x.length).padStart(23)}` +
        `${mean(x.map((e) => e.room)).toFixed(2).padStart(12)}` +
        `${mean(x.map((e) => e.size)).toFixed(2).padStart(12)}`,
    );
  }
}

console.log(`\nand by how close the nearest enemy stone was\n`);
console.log(
  `${"side".padEnd(8)}${"nearest foe".padStart(14)}${"n".padStart(6)}` +
    `${"support".padStart(10)}${"ended in a dead group".padStart(23)}${"group room".padStart(12)}`,
);
for (const side of ["human", "ai"]) {
  const g = all.filter((e) => e.side === side);
  for (const d of [1, 2, 3]) {
    const x = g.filter((e) => (d === 3 ? e.close >= 3 : e.close === d));
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${(d === 3 ? "3+" : String(d)).padStart(14)}${String(x.length).padStart(6)}` +
        `${mean(x.map((e) => e.support)).toFixed(2).padStart(10)}` +
        `${pct(x.filter((e) => e.died).length, x.length).padStart(23)}` +
        `${mean(x.map((e) => e.room)).toFixed(2).padStart(12)}`,
    );
  }
}
