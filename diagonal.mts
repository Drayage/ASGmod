/**
 * Diagonal or straight — every stone, not just the corner follow-up.
 *
 * §40 measured the next stone in the same corner and found the largest gap in
 * this branch: the human plays it diagonally 79% of the time and the engine 20%,
 * z = 7.6. The rules say why — three stones on the corner diagonal enclose three
 * cells and three in a straight line enclose none.
 *
 * That was one stone in one place. This asks it of every move: when a stone
 * lands touching one of its own, is it diagonal or orthogonal? Split by game
 * file so the corner book's effect on it is visible.
 *
 *   npx vite-node diagonal.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Side { touching: number; diagonal: number; both: number }
const blank = (): Side => ({ touching: 0, diagonal: 0, both: 0 });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    games += 1;
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const before = state;
      const mover = before.currentPlayer;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const own = playerCell(mover);
      let ortho = 0;
      let diag = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const r = m.row + dr;
          const c = m.col + dc;
          if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
          if (before.board[r][c] !== own) continue;
          if (dr === 0 || dc === 0) ortho += 1;
          else diag += 1;
        }
      }
      if (ortho + diag === 0) continue;
      const side = sides[mover === human ? "human" : "ai"];
      side.touching += 1;
      if (diag > 0 && ortho === 0) side.diagonal += 1;
      else if (diag > 0 && ortho > 0) side.both += 1;
    }
  }
}

void opponent;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`stones landing beside one of their own — ${games} games\n`);
console.log(
  `${"side".padEnd(8)}${"such stones".padStart(13)}${"diagonal only".padStart(16)}` +
    `${"both".padStart(9)}${"straight only".padStart(16)}`,
);
for (const [name, s] of Object.entries(sides)) {
  const straight = s.touching - s.diagonal - s.both;
  console.log(
    `${name.padEnd(8)}${String(s.touching).padStart(13)}` +
      `${`${s.diagonal} (${pct(s.diagonal, s.touching)})`.padStart(16)}` +
      `${pct(s.both, s.touching).padStart(9)}` +
      `${`${straight} (${pct(straight, s.touching)})`.padStart(16)}`,
  );
}
