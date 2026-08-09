/**
 * Does the human's edge move ever reach the engine's candidate list?
 *
 * Humans take 37% of their stones on the first line and the engine 24%, and 43%
 * of a human's large-region boundary is board edge against the engine's 13%.
 * Before adding a sixth term telling the engine to value territory — the five
 * that came before all measured zero — this asks the mechanical question: when
 * the human plays on the edge, is that point even among the moves the engine
 * looks at, and where does the move ordering rank it?
 *
 *   npx vite-node edge-candidate.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { orderedCandidates, localMoveScore } from "./src/games/alley-boss-cats/engine/moveOrdering";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** The root branch limit the shipped search uses at depth one. */
const ROOT_LIMIT = 14;

interface Row {
  line: number;
  rank: number;
  legal: number;
  inTop: boolean;
}
const bySide = new Map<string, Row[]>();

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
        const mover = state.currentPlayer;
        const who = mover === human ? "human" : mover === ai ? "AI" : "?";
        const line = Math.min(m.row, m.col, 8 - m.row, 8 - m.col);

        // Rank the played point among all legal moves by the ordering heuristic.
        const scored = getLegalMoves(state, mover)
          .map((mv) => ({
            key: `${mv.row},${mv.col}`,
            score: localMoveScore(state.board, mv.row, mv.col, mover),
          }))
          .sort((a, b) => b.score - a.score);
        const key = `${m.row},${m.col}`;
        const rank = scored.findIndex((s) => s.key === key);
        const top = orderedCandidates(state, mover, ROOT_LIMIT);
        const inTop = top.some((a) => a.type === "PLACE" && `${a.row},${a.col}` === key);

        const list = bySide.get(who) ?? [];
        list.push({ line, rank, legal: scored.length, inTop });
        bySide.set(who, list);
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log(`the played move's standing in the engine's own move ordering\n`);
console.log(
  `${"side".padEnd(8)}${"line".padStart(6)}${"moves".padStart(8)}` +
    `${"mean rank".padStart(11)}${"of legal".padStart(10)}${`in top ${ROOT_LIMIT}`.padStart(12)}`,
);
for (const [who, rows] of bySide) {
  for (const line of [0, 1, 2, 3]) {
    const sub = rows.filter((r) => r.line === line);
    if (sub.length === 0) continue;
    console.log(
      `${who.padEnd(8)}${String(line + 1).padStart(6)}${String(sub.length).padStart(8)}` +
        `${mean(sub.map((r) => r.rank)).toFixed(1).padStart(11)}` +
        `${mean(sub.map((r) => r.legal)).toFixed(0).padStart(10)}` +
        `${pct(sub.filter((r) => r.inTop).length, sub.length).padStart(12)}`,
    );
  }
}
