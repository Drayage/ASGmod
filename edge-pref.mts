/** Where each side puts its stones, by distance from the board edge. */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const counts = new Map<string, number[]>();
const early = new Map<string, number[]>();
const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const ai = opponent(human);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (m.type === "PLACE") {
        const who = state.currentPlayer === human ? "human" : state.currentPlayer === ai ? "AI" : "?";
        const d = Math.min(m.row, m.col, 8 - m.row, 8 - m.col);
        const list = counts.get(who) ?? new Array(5).fill(0);
        list[d] += 1;
        counts.set(who, list);
        if (m.turn <= 12) {
          const e = early.get(who) ?? new Array(5).fill(0);
          e[d] += 1;
          early.set(who, e);
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}
const show = (title: string, map: Map<string, number[]>) => {
  console.log(`\n${title}   (line 1 = board edge)`);
  console.log(`${"side".padEnd(8)}${["1st", "2nd", "3rd", "4th", "5th"].map((s) => s.padStart(8)).join("")}${"n".padStart(8)}`);
  for (const [who, list] of map) {
    const n = list.reduce((a, b) => a + b, 0);
    console.log(`${who.padEnd(8)}${list.map((c) => `${((c / n) * 100).toFixed(0)}%`.padStart(8)).join("")}${String(n).padStart(8)}`);
  }
};
show("all stones by line", counts);
show("first 12 turns only", early);
