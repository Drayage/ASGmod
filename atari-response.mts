/**
 * Was the group savable, and does the engine try?
 *
 * Two games ended the same way: the engine's own group sat in atari on its turn
 * and it played on the far side of the board. Either the group was already dead
 * — in which case playing elsewhere is correct and it was lost earlier — or the
 * search failed to answer, which is a different and worse problem.
 *
 * Settles it by enumerating every legal reply and checking which, if any, leave
 * the group alive against the opponent's best answer.
 *
 *   npx vite-node atari-response.mts <export.json> <game#> <turn>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision, lastSearchScore } from "./src/games/alley-boss-cats/engine/minimax";
import { findEndangeredGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const [, , path, gameArg, turnArg] = process.argv;
const target = Number(turnArg);
const rec = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records[Number(gameArg) - 1];
const human: Player = rec.playerSide;
const ai = opponent(human);
const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;

let state: GameState = createInitialState();
let played = "";
for (const m of rec.moveHistory) {
  if (m.turn === target) { played = m.type === "PLACE" ? nm(m.row, m.col) : "PASS"; break; }
  state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
    : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
}

const doomed = findEndangeredGroups(state, ai);
console.log(`game ${gameArg} turn ${target}: AI is ${ai}, played ${played} on the day`);
console.log(`  AI groups in atari: ${doomed.map((g) => `{${g.map((s) => nm(s.row, s.col)).join(" ")}}`).join(", ") || "none"}`);
if (doomed.length === 0) process.exit(0);

const watched = doomed[0];
const anchor = watched[0];
const stones = new Set(watched.map((s) => `${s.row},${s.col}`));

// Every legal reply, scored by whether the group is still alive after the
// opponent's strongest answer.
const { pool } = getSafeActions(state, ai);
const survivors: string[] = [];
for (const act of pool) {
  const mine = applyAction(state, act);
  if (mine.winner === ai) { survivors.push(`${act.type === "PLACE" ? nm(act.row, act.col) : "PASS"} (wins outright)`); continue; }
  if (mine.winner) continue;
  // Does any opponent reply capture it?
  let dies = false;
  for (const reply of getSafeActions(mine, human).pool) {
    const after = applyAction(mine, reply);
    const still = getConnectedGroup(after.board, anchor.row, anchor.col);
    const same = still.length > 0 && still.some((s) => stones.has(`${s.row},${s.col}`));
    if (!same || after.winner === human) { dies = true; break; }
  }
  if (!dies) survivors.push(act.type === "PLACE" ? nm(act.row, act.col) : "PASS");
}

console.log(`  moves that keep {${watched.map((s) => nm(s.row, s.col)).join(" ")}} alive` +
  ` against every reply: ${survivors.length ? survivors.join(", ") : "NONE — the group was already dead"}`);

const mv = findBestMoveVeryHard(state, ai, 3000);
console.log(`  engine at HEAD plays: ${mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS"}` +
  `   score ${lastSearchScore.toFixed(0)}   stage ${lastDecision.stage} (${lastDecision.candidates}/${lastDecision.poolSize})`);
