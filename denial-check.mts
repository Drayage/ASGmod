/**
 * Does the engine ever contest what the player is building?
 *
 * Every measurement so far has been from the engine's side: its own cells, its
 * own groups, its own captures. The player's report is about the other half —
 * "내가 펼치는거 하나도 안막잖아" — and nothing here has ever asked it.
 *
 * So this follows the human's territory as it forms. Every time the human's
 * projected holding grows, it asks what the engine did on its turn: play into
 * or beside that growing region, or somewhere else entirely. A region the
 * engine never touches between the human's first stone there and the end of
 * the game is a region it never contested at all.
 *
 *   npx vite-node denial-check.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { DIRECTIONS, inBounds, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
/** How close an engine move has to be to count as contesting a cell. */
const NEAR = Number(process.env.NEAR ?? 2);

interface Row {
  id: string;
  variant: string;
  humanCells: number;
  /** Human's final cells the engine never played within NEAR of, all game. */
  uncontested: number;
  /** Engine turns spent within NEAR of some cell the human ends up holding. */
  contestingTurns: number;
  engineTurns: number;
}
const rows: Row[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);

    // Play the whole game out first, to learn which cells the human ends up
    // holding — the ground that actually needed contesting.
    let final: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (final.winner) break;
      final = m.type === "PASS"
        ? applyAction(final, { type: "PASS" })
        : applyAction(final, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const humanFinal = calculateTerritories(final.board)[human];
    if (humanFinal.length === 0) continue;

    const touched = new Set<string>();
    let contestingTurns = 0;
    let engineTurns = 0;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        engineTurns += 1;
        let contested = false;
        for (const c of humanFinal) {
          if (Math.abs(c.row - m.row!) + Math.abs(c.col - m.col!) <= NEAR) {
            touched.add(`${c.row},${c.col}`);
            contested = true;
          }
        }
        if (contested) contestingTurns += 1;
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }

    rows.push({
      id: rec.id,
      variant: rec.aiVariant ?? "(older)",
      humanCells: humanFinal.length,
      uncontested: humanFinal.length - touched.size,
      contestingTurns,
      engineTurns,
    });
  }
}

const byVariant = new Map<string, Row[]>();
for (const r of rows) {
  byVariant.set(r.variant, [...(byVariant.get(r.variant) ?? []), r]);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log(`engine moves within ${NEAR} cells count as contesting\n`);
console.log(
  `${"variant".padEnd(18)}${"games".padStart(6)}${"human cells".padStart(13)}` +
    `${"never contested".padStart(17)}${"share".padStart(8)}${"turns spent".padStart(13)}`,
);
for (const [variant, rs] of byVariant) {
  const cells = mean(rs.map((r) => r.humanCells));
  const un = mean(rs.map((r) => r.uncontested));
  console.log(
    `${variant.padEnd(18)}${String(rs.length).padStart(6)}${cells.toFixed(1).padStart(13)}` +
      `${un.toFixed(1).padStart(17)}${`${((100 * un) / Math.max(1, cells)).toFixed(0)}%`.padStart(8)}` +
      `${`${mean(rs.map((r) => r.contestingTurns)).toFixed(1)}/${mean(rs.map((r) => r.engineTurns)).toFixed(1)}`.padStart(13)}`,
  );
}
