/**
 * How fixed is the player's play?
 *
 * They raised it themselves, and it cuts both ways. If their games are near
 * copies of each other then five more is not five samples, and the capture check
 * is weaker than it looks. But it also means their strategy can be replayed
 * without them — and a bot that reproduces it turns every remaining question
 * from "please play ten games" into an arena run.
 *
 * So this measures repetition directly. Grouping their games by which side they
 * took, it asks how often the move at each ply is the one they played in another
 * game from the same position, and how deep the identical prefix runs.
 *
 *   npx vite-node player-repeat.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Game { side: Player; moves: Array<string | null>; boards: string[] }

const games: Game[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const g: Game = { side: human, moves: [], boards: [] };

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      if (mover === human) {
        // The position they faced, so "same move" can be conditioned on it.
        g.boards.push(state.board.map((r) => r.join("")).join("/"));
        g.moves.push(m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS");
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    games.push(g);
  }
}

console.log(`the player's own moves across ${games.length} games\n`);

// How far two games of theirs stay identical, over every pair on the same side.
for (const side of ["A", "B"] as Player[]) {
  const mine = games.filter((g) => g.side === side);
  if (mine.length < 2) continue;
  const prefixes: number[] = [];
  for (let i = 0; i < mine.length; i += 1) {
    for (let j = i + 1; j < mine.length; j += 1) {
      let k = 0;
      while (k < mine[i].moves.length && k < mine[j].moves.length && mine[i].moves[k] === mine[j].moves[k]) k += 1;
      prefixes.push(k);
    }
  }
  const mean = prefixes.reduce((a, b) => a + b, 0) / prefixes.length;
  console.log(
    `  as ${side}: ${mine.length} games, ${prefixes.length} pairs, identical for the first ` +
      `${mean.toFixed(1)} of their own moves (longest ${Math.max(...prefixes)})`,
  );
}

// Their first six moves, by side, so the repetition is visible rather than inferred.
console.log(`\ntheir opening, as played`);
for (const side of ["A", "B"] as Player[]) {
  const mine = games.filter((g) => g.side === side);
  if (mine.length === 0) continue;
  console.log(`\n  as ${side} (${mine.length} games)`);
  for (let k = 0; k < 6; k += 1) {
    const tally = new Map<string, number>();
    for (const g of mine) {
      const mv = g.moves[k];
      if (mv) tally.set(mv, (tally.get(mv) ?? 0) + 1);
    }
    if (tally.size === 0) continue;
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    const parts = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k2, v]) => `${k2} ${Math.round((100 * v) / total)}%`);
    console.log(`    move ${k + 1}  ${parts.join("   ")}`);
  }
}

// The stronger question: given the exact same board, do they repeat themselves?
const byBoard = new Map<string, Map<string, number>>();
for (const g of games) {
  for (let k = 0; k < g.moves.length; k += 1) {
    const key = `${g.side}|${g.boards[k]}`;
    const tally = byBoard.get(key) ?? new Map<string, number>();
    tally.set(g.moves[k]!, (tally.get(g.moves[k]!) ?? 0) + 1);
    byBoard.set(key, tally);
  }
}
let repeated = 0;
let sameMove = 0;
for (const tally of byBoard.values()) {
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  if (total < 2) continue;
  repeated += total;
  sameMove += Math.max(...tally.values());
}
console.log(
  `\na position they faced more than once: ${repeated} of their moves, and they played the same` +
    `\nanswer ${sameMove} of those times (${repeated ? Math.round((100 * sameMove) / repeated) : 0}%).`,
);
