/**
 * The same enclosure, one size larger.
 *
 * The player's idea, and it is a better criterion than any threshold I had.
 * Rather than asking whether some move settles more cells somewhere on the board
 * — which mixes in trades a threshold has to arbitrate — ask whether the region
 * being closed has a bigger version of itself available, using the same stones
 * as walls. If another move settles every cell this one would and more, the
 * smaller move cannot be defended by shape, tempo or anything else. You get all
 * of it plus the rest.
 *
 * That is exactly the position they found. Closing at 1행 4열 settled six cells;
 * closing at 3행 4열 settled the same six and two more.
 *
 * So this counts strict supersets: turns where the engine settled R while some
 * legal, equally safe move settled R' with R as a subset.
 *
 *   npx vite-node superset-seal.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 1200);
const READ = Number(process.env.READ ?? 500);
/** Include turns where the move settled nothing, i.e. every set contains none. */
const EMPTY_TOO = process.env.EMPTY_TOO === "1";

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Stat { turns: number; hits: number; cells: number }
const stages = new Map<string, Stat>();
const examples: string[] = [];
const seen = new Set<string>();
let engineTurns = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      ply += 1;
      if (mover === engine && m.type === "PLACE") {
        engineTurns += 1;
        const held = new Set(
          (state.territories[engine] as Array<{ row: number; col: number }>).map(
            (c) => `${c.row},${c.col}`,
          ),
        );
        const gainedBy = (row: number, col: number) => {
          const board = state.board.map((r) => [...r]);
          board[row][col] = playerCell(engine);
          const after = calculateTerritories(board)[engine] as Array<{ row: number; col: number }>;
          return new Set(
            after.map((c) => `${c.row},${c.col}`).filter((k) => !held.has(k)),
          );
        };

        const mine = gainedBy(m.row!, m.col!);
        if (mine.size === 0 && !EMPTY_TOO) {
          state = applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
          continue;
        }

        // A strict superset: everything this move settles, and more.
        let bigger: { row: number; col: number; size: number } | null = null;
        for (const mv of getLegalMoves(state, engine)) {
          if (mv.row === m.row && mv.col === m.col) continue;
          const theirs = gainedBy(mv.row, mv.col);
          if (theirs.size <= mine.size) continue;
          let covers = true;
          for (const k of mine) if (!theirs.has(k)) { covers = false; break; }
          if (!covers) continue;
          if (!bigger || theirs.size > bigger.size) {
            bigger = { row: mv.row, col: mv.col, size: theirs.size };
          }
        }

        if (bigger) {
          const nextMine = applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
          const mineSafe =
            !nextMine.winner && !opponentCanForceCapture(nextMine, engine, 7, READ);
          const nextBig = applyAction(state, { type: "PLACE", row: bigger.row, col: bigger.col });
          const bigSafe = !nextBig.winner && !opponentCanForceCapture(nextBig, engine, 7, READ);
          if (bigSafe || !mineSafe) {
            findBestMoveVeryHard(state, engine, THINK);
            const stage = lastDecision.stage;
            const s = stages.get(stage) ?? { turns: 0, hits: 0, cells: 0 };
            s.hits += 1;
            s.cells += bigger.size - mine.size;
            stages.set(stage, s);
            if (examples.length < 12) {
              examples.push(
                `  ply ${String(ply).padStart(3)}  ${stage.padEnd(26)}` +
                  `${nm(m.row!, m.col!)} settled ${mine.size}, ` +
                  `${nm(bigger.row, bigger.col)} settles the same ${mine.size} and ${bigger.size}`,
              );
            }
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const hits = [...stages.values()].reduce((a, s) => a + s.hits, 0);
const cells = [...stages.values()].reduce((a, s) => a + s.cells, 0);
console.log(`engine turns: ${engineTurns}${EMPTY_TOO ? "" : " (only turns that settled something)"}`);
console.log(`turns where the same region had a strictly larger version: ${hits}, ${cells} cells\n`);
console.log(`${"stage".padEnd(28)}${"turns".padStart(7)}${"cells".padStart(7)}${"per turn".padStart(10)}`);
for (const [stage, s] of [...stages.entries()].sort((a, b) => b[1].cells - a[1].cells)) {
  console.log(
    `${stage.padEnd(28)}${String(s.hits).padStart(7)}${String(s.cells).padStart(7)}` +
      `${(s.cells / s.hits).toFixed(1).padStart(10)}`,
  );
}
console.log(`\nthe first few\n`);
for (const line of examples) console.log(line);
