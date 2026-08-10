/**
 * When the opponent checks, who answers locally and for how long?
 *
 * The player's report: once they started contesting, the engine stopped playing
 * well — it over-invests in the small fight instead of settling for a shape that
 * simply does not die and taking the bigger point elsewhere.
 *
 * That is measurable. A check is an opponent stone landing within one step of
 * one of my own. This counts, for each check, how many of the answerer's next
 * four moves land within two steps of it, and how long their longest unbroken
 * run of local replies is.
 *
 *   npx vite-node checked.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const AHEAD = Number(process.env.AHEAD ?? 4);
const NEAR = Number(process.env.NEAR ?? 2);

interface Side { checks: number; local: number[]; runs: number[] }
const blank = (): Side => ({ checks: 0, local: [], runs: [] });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    games += 1;
    const human: Player = rec.playerSide;

    const states: GameState[] = [createInitialState()];
    for (const m of rec.moveHistory) {
      const cur = states[states.length - 1];
      if (cur.winner) break;
      states.push(
        m.type === "PASS"
          ? applyAction(cur, { type: "PASS" })
          : applyAction(cur, { type: "PLACE", row: m.row!, col: m.col! }),
      );
    }

    for (let i = 0; i < states.length - 1; i += 1) {
      const m = rec.moveHistory[i];
      if (!m || m.type !== "PLACE") continue;
      const before = states[i];
      const checker = before.currentPlayer;
      const answerer = opponent(checker);

      // Did this stone land next to one of the answerer's?
      let touches = false;
      for (let dr = -1; dr <= 1 && !touches; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const r = m.row + dr;
          const c = m.col + dc;
          if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
          if (before.board[r][c] === playerCell(answerer)) { touches = true; break; }
        }
      }
      if (!touches) continue;

      const name = answerer === human ? "human" : "ai";
      const side = sides[name];
      side.checks += 1;

      let local = 0;
      let run = 0;
      let best = 0;
      let taken = 0;
      for (let j = i + 1; j < rec.moveHistory.length && taken < AHEAD; j += 1) {
        const n = rec.moveHistory[j];
        if (!n || n.type !== "PLACE") continue;
        if (states[j].currentPlayer !== answerer) continue;
        taken += 1;
        const near =
          Math.max(Math.abs(n.row - m.row), Math.abs(n.col - m.col)) <= NEAR;
        if (near) { local += 1; run += 1; best = Math.max(best, run); }
        else run = 0;
      }
      side.local.push(local);
      side.runs.push(best);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(
  `answering a check — of the next ${AHEAD} own moves, how many land within ${NEAR} of it\n` +
    `${games} games\n`,
);
console.log(
  `${"answerer".padEnd(10)}${"checks".padStart(8)}${"local of 4".padStart(13)}` +
    `${"longest run".padStart(14)}${"3 or 4 local".padStart(15)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(10)}${String(s.checks).padStart(8)}${mean(s.local).toFixed(2).padStart(13)}` +
      `${mean(s.runs).toFixed(2).padStart(14)}` +
      `${pct(s.local.filter((n) => n >= 3).length, s.local.length).padStart(15)}`,
  );
}
