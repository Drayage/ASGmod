/**
 * The untried half of the sealedWeight experiment: does widening the liberty
 * gate — not just raising the price — change the outcome?
 *
 * `sealed-playout.mts` varied `tuning.sealedWeight` at threshold 3 (the shipped
 * gate) and found game two's tracked group survived at every weight while a
 * different group died the same way — the term spoke too late to matter.
 * `sealed-check.mts` then showed `canBreathe` calls these same groups sealed
 * one to four liberties earlier than that gate allows. This plays the known
 * positions out — both sides searching with the same tuning, from a point
 * before the group in question is fully cornered — with the weight and the
 * gate raised together.
 *
 *   npx vite-node sealed-threshold-playout.mts <export.json> <recordId> <point> <fromTurn>
 */
import { readFileSync } from "node:fs";
import { applyAction, setSealedLibertyThreshold, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const C = "ABCDEFGHI";
const PLIES = Number(process.env.PLIES ?? 20);
const WEIGHTS = (process.env.WEIGHTS ?? "0,60,150").split(",").map(Number);
const THRESHOLDS = (process.env.THRESHOLDS ?? "3,4,5,6").split(",").map(Number);

const [path, recordId, point, fromArg] = process.argv.slice(2);
const from = Number(fromArg);
const all = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records;
const rec = all.find((r: any) => r.id === recordId);
const human: Player = rec.playerSide;
const ai = opponent(human);
const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };

let base: GameState = createInitialState();
for (const m of rec.moveHistory) {
  if (m.turn === from) break;
  base = m.type === "PASS" ? applyAction(base, { type: "PASS" })
    : applyAction(base, { type: "PLACE", row: m.row!, col: m.col! });
}

console.log(`${rec.id}, group ${point}, both sides self-play from turn ${from}, ${PLIES} plies`);
console.log(`${"threshold".padEnd(11)}${WEIGHTS.map((w) => `w=${w}`.padStart(24)).join("")}`);
for (const t of THRESHOLDS) {
  setSealedLibertyThreshold(t);
  const row = [String(t).padEnd(11)];
  for (const w of WEIGHTS) {
    tuning.sealedWeight = w;
    let s = base;
    let outcome = "still alive";
    for (let ply = 0; ply < PLIES; ply += 1) {
      const mv = findBestMoveVeryHard(s, s.currentPlayer, 3000);
      s = applyAction(s, mv);
      if (s.winner) { outcome = s.winner === ai ? "WINS" : "LOSES"; break; }
      const g = getConnectedGroup(s.board, anchor.row, anchor.col);
      if (g.length === 0) { outcome = "group gone"; break; }
    }
    const g = getConnectedGroup(s.board, anchor.row, anchor.col);
    const libs = g.length ? getGroupLiberties(s.board, g).size : 0;
    row.push(`${outcome}(${libs}lib)`.padStart(24));
  }
  console.log(row.join(""));
  tuning.sealedWeight = 0;
}
setSealedLibertyThreshold(3);
