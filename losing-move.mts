/**
 * Which stage played the move that lost the game?
 *
 * capture-blame put the mistake two to six plies before the capture landed: at
 * that turn the engine still had a move the opponent could not force through,
 * and it played something else. This asks the engine itself what it does with
 * that position, and — the point of the exercise — which stage of the guard
 * ladder answers.
 *
 * The screen that drops moves letting the opponent force a capture lives in
 * stage 2. Every stage above it returns directly: the corner book at 1.88, the
 * framework guard at 1.9, the seal stages. If the losing moves come from up
 * there, they were never screened at all, and that is a hole rather than a
 * tuning problem.
 *
 *   npx vite-node losing-move.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 9);
const BUDGET = Number(process.env.BUDGET ?? 1500);
const THINK = Number(process.env.THINK ?? 3000);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

const safeMoves = (state: GameState, side: Player, other: Player): string[] => {
  const out: string[] = [];
  for (const mv of getLegalMoves(state, side)) {
    const board = state.board.map((r) => [...r]);
    board[mv.row][mv.col] = playerCell(side);
    const after: GameState = {
      ...state,
      board,
      territories: calculateTerritories(board),
      currentPlayer: other,
    };
    if (findForcedCapture(after, other, DEPTH, BUDGET) === null) out.push(nm(mv.row, mv.col));
  }
  return out;
};

const seen = new Set<string>();
console.log(`the turn each loss was decided on, replayed through the engine\n`);
console.log(
  `${"variant".padEnd(18)}${"ply".padStart(5)}${"it played".padStart(11)}` +
    `${"stage".padStart(22)}${"safe then".padStart(11)}${"engine now".padStart(12)}` +
    `${"still safe".padStart(12)}`,
);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    if (rec.winReason !== "CAPTURE" || rec.winner !== human) continue;
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    const turns: Array<{ ply: number; state: GameState; played: { row: number; col: number } }> = [];
    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        turns.push({ ply: ply + 1, state, played: { row: m.row!, col: m.col! } });
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      ply += 1;
    }
    if (turns.length === 0) continue;

    // The last turn that still had a way out is the one that lost the game.
    let lost: (typeof turns)[number] | null = null;
    let safeThen: string[] = [];
    for (let i = turns.length - 1; i >= 0 && i >= turns.length - 10; i -= 1) {
      const safe = safeMoves(turns[i].state, engine, human);
      if (safe.length > 0) { lost = turns[i]; safeThen = safe; break; }
    }
    if (lost === null) continue;

    const move = findBestMoveVeryHard(lost.state, engine, THINK);
    const now = move.type === "PLACE" ? nm(move.row, move.col) : "PASS";
    console.log(
      `${(rec.aiVariant ?? "(older)").padEnd(18)}${String(lost.ply).padStart(5)}` +
        `${nm(lost.played.row, lost.played.col).padStart(11)}` +
        `${lastDecision.stage.padStart(22)}` +
        `${String(safeThen.length).padStart(11)}${now.padStart(12)}` +
        `${(safeThen.includes(now) ? "yes" : "NO").padStart(12)}`,
    );
  }
}
