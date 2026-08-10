/**
 * Whose fault is each capture the engine loses to?
 *
 * cut-risk ruled out the obvious story. The diagonal bonus does leave the engine
 * looser — half its stones have no orthogonal friend against a third before it —
 * but the groups that actually died are one, two and three stones, and all but
 * two of the nine were joined orthogonally. These are not diagonal frameworks
 * being cut; they are small groups being hunted down.
 *
 * Which leaves a sharper question. At the engine's last move before the capture,
 * was the group already lost — the opponent had a forced capture whatever the
 * engine did — or did the engine have a move that saved it and not play it? The
 * first is a strategic debt run up earlier. The second is the guard ladder
 * missing, and fixable.
 *
 *   npx vite-node capture-blame.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 9);
const BUDGET = Number(process.env.BUDGET ?? 3000);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

const seen = new Set<string>();
console.log(`each capture the engine lost to, read ${DEPTH} deep\n`);
console.log(
  `${"variant".padEnd(18)}${"ply".padStart(5)}${"its last move".padStart(15)}` +
    `${"already lost".padStart(14)}${"had a save".padStart(12)}${"saves".padStart(24)}`,
);

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    if (rec.winReason !== "CAPTURE" || rec.winner !== human) continue;

    // Every engine turn, kept, so the position can be walked backwards to the
    // last one where a save still existed.
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
    const last = turns[turns.length - 1];
    const before: GameState = last.state;
    const played = last.played;

    // Already lost: whatever the engine plays, the opponent still forces it.
    const saves: string[] = [];
    let anySafe = false;
    for (const mv of getLegalMoves(before, engine)) {
      const board = before.board.map((r) => [...r]);
      board[mv.row][mv.col] = playerCell(engine);
      const after: GameState = {
        ...before,
        board,
        territories: calculateTerritories(board),
        currentPlayer: human,
      };
      if (findForcedCapture(after, human, DEPTH, BUDGET) === null) {
        anySafe = true;
        if (saves.length < 3) saves.push(nm(mv.row, mv.col));
      }
    }

    // Walk back to the last engine turn that still had a way out. The move it
    // played there is the one that lost the game.
    let lostAt = last;
    let lostPly = -1;
    for (let i = turns.length - 2; i >= 0 && i >= turns.length - 10; i -= 1) {
      const t = turns[i];
      let safe = false;
      for (const mv of getLegalMoves(t.state, engine)) {
        const board = t.state.board.map((r) => [...r]);
        board[mv.row][mv.col] = playerCell(engine);
        const after: GameState = {
          ...t.state,
          board,
          territories: calculateTerritories(board),
          currentPlayer: human,
        };
        if (findForcedCapture(after, human, DEPTH, BUDGET) === null) { safe = true; break; }
      }
      if (safe) { lostAt = t; lostPly = t.ply; break; }
    }

    console.log(
      `${(rec.aiVariant ?? "(older)").padEnd(18)}${String(last.ply).padStart(5)}` +
        `${nm(played.row, played.col).padStart(15)}` +
        `${(anySafe ? "no" : "yes").padStart(14)}` +
        `${(lostPly < 0 ? ">10 turns" : `ply ${lostPly}`).padStart(14)}` +
        `${(lostPly < 0 ? "-" : nm(lostAt.played.row, lostAt.played.col)).padStart(10)}`,
    );
  }
}
