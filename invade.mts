/**
 * Is a corner with one or two enemy stones still playable?
 *
 * The player says yes — go in anyway, and make diagonals inward, and it almost
 * never dies. That matters directly: stage 1.88 only fires on a corner nobody
 * has entered, and if lightly-held corners are playable too then the gate is
 * stricter than the game requires.
 *
 * So this finds every stone played into a quadrant where the opponent already
 * had stones and the mover had none, and asks whether the group it joined was
 * the one that ended the game.
 *
 * The first version of this checked whether the stone was still on the board at
 * the end and got 100% everywhere, for both sides, at every enemy count. That is
 * an artifact: a captured group is left in place and recorded in `capturedGroup`
 * so the loser can see what happened, so "still on the board" is true of every
 * stone ever played. The test below uses `capturedGroup`. It also records how the mover's next stone
 * in that quadrant was placed relative to the first — diagonal, orthogonal, or
 * further out — since that is the technique being claimed.
 *
 *   npx vite-node invade.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getConnectedGroup } from "./src/games/alley-boss-cats/groups";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const quadrant = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;

interface Side {
  invasions: number;
  byEnemyCount: Map<number, { n: number; survived: number }>;
  followUp: Map<string, number>;
}
const blank = (): Side => ({ invasions: 0, byEnemyCount: new Map(), followUp: new Map() });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
let games = 0;
let gamesEndingInCapture = 0;
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
    if (final.winReason === "CAPTURE") gamesEndingInCapture += 1;

    for (let i = 0; i < states.length - 1; i += 1) {
      const m = rec.moveHistory[i];
      if (!m || m.type !== "PLACE") continue;
      const before = states[i];
      const mover = before.currentPlayer;
      const q = quadrant(m.row, m.col);
      if (!q) continue;

      // How the quadrant stood before the stone landed.
      let mine = 0;
      let theirs = 0;
      for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          if (quadrant(row, col) !== q) continue;
          const cell = before.board[row][col];
          if (cell === playerCell(mover)) mine += 1;
          else if (cell === playerCell(opponent(mover))) theirs += 1;
        }
      }
      if (mine > 0 || theirs === 0) continue;

      const name = mover === human ? "human" : "ai";
      const side = sides[name];
      side.invasions += 1;
      const bucket = Math.min(theirs, 4);
      const entry = side.byEnemyCount.get(bucket) ?? { n: 0, survived: 0 };
      entry.n += 1;
      // Survival: the stone was not part of the group whose capture ended it.
      const died =
        final.winReason === "CAPTURE" &&
        (final.capturedGroup ?? []).some((c) => c.row === m.row && c.col === m.col);
      if (!died) entry.survived += 1;
      side.byEnemyCount.set(bucket, entry);

      // The mover's next stone in the same quadrant, if any.
      for (let j = i + 1; j < rec.moveHistory.length; j += 1) {
        const n = rec.moveHistory[j];
        if (!n || n.type !== "PLACE") continue;
        if (states[j].currentPlayer !== mover) continue;
        if (quadrant(n.row, n.col) !== q) continue;
        const dr = Math.abs(n.row - m.row);
        const dc = Math.abs(n.col - m.col);
        const shape =
          dr === 1 && dc === 1 ? "diagonal" : dr + dc === 1 ? "orthogonal" : `${Math.max(dr, dc)} away`;
        side.followUp.set(shape, (side.followUp.get(shape) ?? 0) + 1);
        break;
      }
    }
  }
}

void getConnectedGroup;
void ({} as Coord);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
const capturedGames = gamesEndingInCapture;
console.log(
  `stones played into a quadrant the opponent already held, ${games} games ` +
    `(${capturedGames} ended in a capture at all)\n`,
);
console.log(`${"side".padEnd(8)}${"enemy stones there".padStart(20)}${"times".padStart(8)}${"stone survived".padStart(16)}`);
for (const [name, s] of Object.entries(sides)) {
  for (const k of [...s.byEnemyCount.keys()].sort((a, b) => a - b)) {
    const e = s.byEnemyCount.get(k)!;
    console.log(
      `${name.padEnd(8)}${(k >= 4 ? "4+" : String(k)).padStart(20)}${String(e.n).padStart(8)}` +
        `${`${e.survived} (${pct(e.survived, e.n)})`.padStart(16)}`,
    );
  }
}
console.log(`\nhow the next stone in that quadrant was placed`);
for (const [name, s] of Object.entries(sides)) {
  const total = [...s.followUp.values()].reduce((a, b) => a + b, 0);
  const parts = [...s.followUp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k} ${pct(v, total)}`);
  console.log(`  ${name.padEnd(8)}${parts.join("   ")}   (n=${total})`);
}
