/**
 * How often is the move a stage returns beaten outright by another it could
 * have played?
 *
 * The player's generalisation of the one position they found: a move a guard
 * hands back is still only forced relative to that guard's own reason, and
 * depending on the position there may be a move that does the same job and more.
 * So the guard has to look, not just return.
 *
 * A move is called dominated here only on terms nothing can argue with: another
 * legal move that settles strictly more cells right now and is at least as safe,
 * measured by the same capture read the engine screens with. No judgement about
 * shape or influence enters it — if the engine had played that instead it would
 * have had more confirmed ground and no more risk.
 *
 * The stage is then read off by replaying the engine on the position, so the
 * count can say where to look rather than only that something is wrong.
 *
 *   npx vite-node dominated.mts <export.json ...>
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
const READ = Number(process.env.READ ?? 600);
/**
 * How many more cells the alternative must settle before it is counted.
 *
 * One extra cell now is not obviously better than a stone placed where it will
 * be worth more later, so the unqualified count mixes real losses with ordinary
 * judgement. Raising this isolates the gaps no shape argument covers.
 */
const MIN = Number(process.env.MIN ?? 1);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Stage { turns: number; dominated: number; lost: number }
const stages = new Map<string, Stage>();
const examples: string[] = [];
const seen = new Set<string>();
let engineTurns = 0;
let dominatedTurns = 0;
let lostCells = 0;

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
        const before = state.territories[engine].length;

        const settles = (row: number, col: number) => {
          const board = state.board.map((r) => [...r]);
          board[row][col] = playerCell(engine);
          return calculateTerritories(board)[engine].length - before;
        };
        const took = settles(m.row!, m.col!);

        // Only moves that settle strictly more can dominate, so the expensive
        // safety read runs on those alone.
        const better = getLegalMoves(state, engine)
          .map((mv) => ({ mv, gain: settles(mv.row, mv.col) }))
          .filter((x) => x.gain - took >= MIN)
          .sort((a, b) => b.gain - a.gain);

        let beat: { row: number; col: number; gain: number } | null = null;
        if (better.length > 0) {
          const playedNext = applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
          const playedSafe =
            !playedNext.winner && !opponentCanForceCapture(playedNext, engine, 7, READ);
          for (const { mv, gain } of better) {
            const next = applyAction(state, { type: "PLACE", ...mv });
            const safe = !next.winner && !opponentCanForceCapture(next, engine, 7, READ);
            // At least as safe: either both survive the read, or the played move
            // did not either, in which case safety cannot be the reason.
            if (safe || !playedSafe) {
              beat = { row: mv.row, col: mv.col, gain };
              break;
            }
          }
        }

        if (beat) {
          findBestMoveVeryHard(state, engine, THINK);
          const stage = lastDecision.stage;
          const s = stages.get(stage) ?? { turns: 0, dominated: 0, lost: 0 };
          s.dominated += 1;
          s.lost += beat.gain - took;
          stages.set(stage, s);
          dominatedTurns += 1;
          lostCells += beat.gain - took;
          if (examples.length < 12) {
            examples.push(
              `  ply ${String(ply).padStart(3)}  ${stage.padEnd(24)}` +
                `played ${nm(m.row!, m.col!)} settling ${took}, ` +
                `${nm(beat.row, beat.col)} settles ${beat.gain}`,
            );
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

console.log(`engine turns: ${engineTurns}, counting gaps of ${MIN}+ cells`);
console.log(
  `turns where a safe move settled strictly more: ${dominatedTurns}` +
    ` (${Math.round((100 * dominatedTurns) / engineTurns)}%), ${lostCells} cells in total\n`,
);
console.log(
  `${"stage that chose".padEnd(26)}${"dominated turns".padStart(17)}${"cells left".padStart(12)}` +
    `${"per turn".padStart(10)}`,
);
for (const [stage, s] of [...stages.entries()].sort((a, b) => b[1].lost - a[1].lost)) {
  console.log(
    `${stage.padEnd(26)}${String(s.dominated).padStart(17)}${String(s.lost).padStart(12)}` +
      `${(s.lost / s.dominated).toFixed(1).padStart(10)}`,
  );
}
console.log(`\nthe first few\n`);
for (const line of examples) console.log(line);
