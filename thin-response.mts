/**
 * The move before the group was lost.
 *
 * At turn 19 nothing saves it, so the mistake is earlier. In both games the
 * group sat at two liberties at turn 17 with the opponent beside it, and the
 * engine played on the far side of the board. Two liberties with an enemy
 * adjacent is exactly what `thinGroupDanger` — stage 1.75 — was built to answer,
 * and that guard was switched off earlier today on arena evidence.
 *
 * The arena said captures suffered went 22 to 22. It is engine against engine,
 * and an engine does not hunt a two-liberty group the way a person does.
 *
 *   npx vite-node thin-response.mts <export.json> <game#> <turn>
 */
import { readFileSync } from "node:fs";
import { applyAction, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import {
  findBestMoveVeryHard,
  lastDecision,
  setThinGroupGuardEnabled,
} from "./src/games/alley-boss-cats/engine/minimax";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
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

const thin = getAllGroups(state.board, ai)
  .map((g) => ({ g, libs: getGroupLiberties(state.board, g).size }))
  .filter((x) => x.libs === 2);
console.log(`game ${gameArg} turn ${target}: AI is ${ai}, played ${played} on the day`);
for (const t of thin) {
  console.log(`  at two liberties: {${t.g.map((s) => nm(s.row, s.col)).join(" ")}}`);
}

/** Does this reply keep `group` alive through two more of the opponent's moves? */
function holds(from: GameState, anchor: { row: number; col: number }, stones: Set<string>): boolean {
  for (const reply of getSafeActions(from, human).pool) {
    const after = applyAction(from, reply);
    if (after.winner === human) return false;
    const still = getConnectedGroup(after.board, anchor.row, anchor.col);
    if (still.length === 0 || !still.some((s) => stones.has(`${s.row},${s.col}`))) return false;
    // Now the AI answers as best it can; if nothing holds, this line loses it.
    let saved = false;
    for (const mine of getSafeActions(after, ai).pool) {
      const next = applyAction(after, mine);
      if (next.winner === ai) { saved = true; break; }
      const g = getConnectedGroup(next.board, anchor.row, anchor.col);
      if (g.length > 0 && getGroupLiberties(next.board, g).size >= 3) { saved = true; break; }
    }
    if (!saved) return false;
  }
  return true;
}

for (const t of thin) {
  const anchor = t.g[0];
  const stones = new Set(t.g.map((s) => `${s.row},${s.col}`));
  const keeps: string[] = [];
  for (const act of getSafeActions(state, ai).pool) {
    const mine = applyAction(state, act);
    if (mine.winner === ai) { keeps.push(`${act.type === "PLACE" ? nm(act.row, act.col) : "PASS"}!`); continue; }
    if (mine.winner) continue;
    if (holds(mine, anchor, stones)) keeps.push(act.type === "PLACE" ? nm(act.row, act.col) : "PASS");
  }
  console.log(
    `  moves that hold {${t.g.map((s) => nm(s.row, s.col)).join(" ")}} for two more exchanges: ` +
      (keeps.length ? keeps.slice(0, 12).join(", ") + (keeps.length > 12 ? ` … (${keeps.length})` : "") : "NONE"),
  );
}

for (const guard of [false, true]) {
  setThinGroupGuardEnabled(guard);
  const mv = findBestMoveVeryHard(state, ai, 3000);
  console.log(
    `  thinGroupGuard ${guard ? "ON " : "OFF"} (shipped: OFF): plays ` +
      `${(mv.type === "PLACE" ? nm(mv.row, mv.col) : "PASS").padEnd(4)}  stage ${lastDecision.stage}`,
  );
}
setThinGroupGuardEnabled(false);
