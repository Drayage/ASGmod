/**
 * What the diagonal costs, since the player says it costs something.
 *
 * Their reasoning for the one-space diagonal: it keeps three follow-ups open —
 * connect straight once an eye exists, connect diagonally in a hurry, or extend
 * the far diagonal for a big house when nobody contests — at some extra risk.
 *
 * The two stones of a diagonal pair are not one group, and the two points
 * between them are exactly where an opponent would cut. So this counts every
 * diagonal pair each side forms, how often the opponent takes one of those two
 * points, and whether the pair was still both alive at the end.
 *
 *   npx vite-node diagonal-risk.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Side { pairs: number; cutTried: number; bothCut: number; died: number }
const blank = (): Side => ({ pairs: 0, cutTried: 0, bothCut: 0, died: 0 });
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
    const final = states[states.length - 1];
    const dead = new Set(
      (final.capturedGroup ?? []).map((c) => `${c.row},${c.col}`),
    );

    for (let i = 0; i < states.length - 1; i += 1) {
      const m = rec.moveHistory[i];
      if (!m || m.type !== "PLACE") continue;
      const before = states[i];
      const mover = before.currentPlayer;
      const own = playerCell(mover);
      const name = mover === human ? "human" : "ai";

      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const r = m.row + dr;
        const c = m.col + dc;
        if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
        if (before.board[r][c] !== own) continue;
        // A new diagonal pair. Its two connection points:
        const links = [
          { row: m.row, col: c },
          { row: r, col: m.col },
        ].filter((p) => states[i + 1].board[p.row][p.col] === "EMPTY");
        if (links.length < 2) continue; // already half-filled, not a clean pair

        const side = sides[name];
        side.pairs += 1;

        let taken = 0;
        for (let j = i + 1; j < states.length - 1; j += 1) {
          const n = rec.moveHistory[j];
          if (!n || n.type !== "PLACE") continue;
          if (states[j].currentPlayer === mover) continue;
          if (links.some((p) => p.row === n.row && p.col === n.col)) taken += 1;
        }
        if (taken > 0) side.cutTried += 1;
        if (taken === 2) side.bothCut += 1;
        if (dead.has(`${m.row},${m.col}`) || dead.has(`${r},${c}`)) side.died += 1;
      }
    }
  }
}

void opponent;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`diagonal pairs and what happened to them — ${games} games\n`);
console.log(
  `${"side".padEnd(8)}${"pairs".padStart(8)}${"a link taken".padStart(15)}` +
    `${"both taken".padStart(13)}${"a stone died".padStart(15)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.pairs).padStart(8)}` +
      `${`${s.cutTried} (${pct(s.cutTried, s.pairs)})`.padStart(15)}` +
      `${`${s.bothCut} (${pct(s.bothCut, s.pairs)})`.padStart(13)}` +
      `${`${s.died} (${pct(s.died, s.pairs)})`.padStart(15)}`,
  );
}
