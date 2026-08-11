/**
 * Within the shortlist a stage was choosing from, did it take the most ground?
 *
 * The player's correction to the previous measurement, and it is the right
 * question. Whether some better move existed elsewhere on the board mixes two
 * different things: free choices, where a stone placed for later can beat a cell
 * now, and forced ones, where the move is being made to satisfy a goal — not
 * getting captured, claiming a corner — and every candidate satisfies it
 * equally. In the second case there is no trade-off at all. Among moves that all
 * do the job, take the one that settles the most.
 *
 * So this asks only that. Each stage now records the shortlist it was offered,
 * and this replays the engine, finds the move it chose, and compares it against
 * the other candidates on that same list — cells settled now, and safety by the
 * same capture read, so a candidate is only counted as better if it is not worse
 * in either.
 *
 *   npx vite-node shortlist-max.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 1200);
const READ = Number(process.env.READ ?? 500);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Stat { turns: number; missed: number; cells: number; listed: number }
const stages = new Map<string, Stat>();
const examples: string[] = [];
const seen = new Set<string>();

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
        const pick = findBestMoveVeryHard(state, engine, THINK);
        const { stage, offered } = lastDecision;
        const stat = stages.get(stage) ?? { turns: 0, missed: 0, cells: 0, listed: 0 };
        stat.turns += 1;
        stat.listed += offered.length;

        if (pick.type === "PLACE" && offered.length > 1) {
          const before = state.territories[engine].length;
          const settles = (row: number, col: number) => {
            const board = state.board.map((r) => [...r]);
            board[row][col] = playerCell(engine);
            return calculateTerritories(board)[engine].length - before;
          };
          const chose = settles(pick.row, pick.col);
          const rivals = offered
            .filter((o) => !(o.row === pick.row && o.col === pick.col))
            .map((o) => ({ ...o, gain: settles(o.row, o.col) }))
            .filter((o) => o.gain > chose)
            .sort((a, b) => b.gain - a.gain);

          if (rivals.length > 0) {
            const mineNext = applyAction(state, { type: "PLACE", row: pick.row, col: pick.col });
            const mineSafe =
              !mineNext.winner && !opponentCanForceCapture(mineNext, engine, 7, READ);
            for (const r of rivals) {
              const next = applyAction(state, { type: "PLACE", row: r.row, col: r.col });
              const safe = !next.winner && !opponentCanForceCapture(next, engine, 7, READ);
              if (safe || !mineSafe) {
                stat.missed += 1;
                stat.cells += r.gain - chose;
                if (examples.length < 12) {
                  examples.push(
                    `  ply ${String(ply).padStart(3)}  ${stage.padEnd(24)}` +
                      `chose ${nm(pick.row, pick.col)} settling ${chose}, ` +
                      `${nm(r.row, r.col)} was on the same list and settles ${r.gain}`,
                  );
                }
                break;
              }
            }
          }
        }
        stages.set(stage, stat);
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const total = [...stages.values()].reduce((a, s) => a + s.turns, 0);
const missed = [...stages.values()].reduce((a, s) => a + s.missed, 0);
const cells = [...stages.values()].reduce((a, s) => a + s.cells, 0);

console.log(`engine turns replayed: ${total}`);
console.log(`turns where its own shortlist held a safer-or-equal move settling more:`);
console.log(`  ${missed} (${Math.round((100 * missed) / total)}%), ${cells} cells\n`);
console.log(
  `${"stage".padEnd(26)}${"turns".padStart(7)}${"list size".padStart(11)}` +
    `${"took less".padStart(11)}${"cells".padStart(7)}${"per turn".padStart(10)}`,
);
for (const [stage, s] of [...stages.entries()].sort((a, b) => b[1].cells - a[1].cells)) {
  console.log(
    `${stage.padEnd(26)}${String(s.turns).padStart(7)}` +
      `${(s.listed / s.turns).toFixed(1).padStart(11)}` +
      `${`${s.missed} (${Math.round((100 * s.missed) / s.turns)}%)`.padStart(11)}` +
      `${String(s.cells).padStart(7)}${(s.missed ? s.cells / s.missed : 0).toFixed(1).padStart(10)}`,
  );
}
console.log(`\nthe first few\n`);
for (const line of examples) console.log(line);
