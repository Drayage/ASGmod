/**
 * Does widening the sealed gate change what the engine plays against the
 * actual siege the player ran — not a self-play stand-in for it?
 *
 * `sealed-threshold-playout.mts` self-played both sides and found the group
 * always dies regardless of threshold or weight — but self-play's opponent
 * does not hunt a group the way the player did (the original sealed-playout.mts
 * flagged exactly this limitation). This replays the human's recorded moves
 * exactly, and recomputes only the engine's, so the question is the direct one:
 * against this exact recorded siege, does the new term save the group?
 *
 *   npx vite-node sealed-threshold-replay.mts <export.json> <recordId> <point> <fromTurn>
 *
 * fromTurn: recorded moves are replayed verbatim (neither side recomputed) up
 * to this ply. Needed because the opening book picks among several openings —
 * confirmed non-deterministic here, since even threshold=3/weight=0 (the
 * shipped default exactly) diverges from the recorded game within the first
 * few plies when the engine's move is recomputed from turn one. Starting after
 * the group already exists in its recorded shape sidesteps that noise and asks
 * the real question: given this position, does the new term change the
 * engine's defence of it.
 */
import { readFileSync } from "node:fs";
import { applyAction, setSealedLibertyThreshold, tuning } from "./src/games/alley-boss-cats/ai";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";

const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const WEIGHTS = (process.env.WEIGHTS ?? "0,60,150,300").split(",").map(Number);
const THRESHOLDS = (process.env.THRESHOLDS ?? "3,4,5,6").split(",").map(Number);

const [path, recordId, point, fromArg] = process.argv.slice(2);
const from = Number(fromArg);
const all = (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records;
const rec = all.find((r: any) => r.id === recordId);
const human: Player = rec.playerSide;
const ai = opponent(human);
const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };

function replay(threshold: number, weight: number): { outcome: string; libs: number; diverged: number } {
  applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);
  setSealedLibertyThreshold(threshold);
  tuning.sealedWeight = weight;
  let s: GameState = createInitialState();
  let firstDivergence = -1;
  let ply = 0;
  for (const m of rec.moveHistory) {
    if (s.winner) break;
    ply += 1;
    if (ply < from) {
      s = m.type === "PASS" ? applyAction(s, { type: "PASS" })
        : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
      continue;
    }
    if (s.currentPlayer === ai) {
      const mv = findBestMoveVeryHard(s, ai, 2600);
      if (
        firstDivergence < 0 &&
        (mv.type !== m.type || (mv.type === "PLACE" && (mv.row !== m.row || mv.col !== m.col)))
      ) {
        firstDivergence = ply;
      }
      s = applyAction(s, mv);
    } else {
      // The engine's move may have diverged enough that the human's recorded
      // reply no longer applies to this board — stop rather than crash or
      // silently misplay it.
      if (m.type === "PLACE" && !isLegalMove(s, m.row!, m.col!, human)) {
        tuning.sealedWeight = 0;
        setSealedLibertyThreshold(3);
        const g = getConnectedGroup(s.board, anchor.row, anchor.col);
        const libs = g.length ? getGroupLiberties(s.board, g).size : 0;
        return {
          outcome: `recorded human move no longer legal at ply ${ply}`,
          libs,
          diverged: firstDivergence,
        };
      }
      s = m.type === "PASS" ? applyAction(s, { type: "PASS" })
        : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
  tuning.sealedWeight = 0;
  setSealedLibertyThreshold(3);
  if (s.winner) return { outcome: s.winner === ai ? "engine WINS" : "engine LOSES", libs: -1, diverged: firstDivergence };
  const g = getConnectedGroup(s.board, anchor.row, anchor.col);
  const libs = g.length ? getGroupLiberties(s.board, g).size : 0;
  return { outcome: "reached end of recorded moves, group alive", libs, diverged: firstDivergence };
}

console.log(`${rec.id}, group ${point}, engine's moves recomputed, human's replayed exactly`);
console.log(`${"threshold".padEnd(11)}${WEIGHTS.map((w) => `w=${w}`.padStart(34)).join("")}`);
for (const t of THRESHOLDS) {
  const row = [String(t).padEnd(11)];
  for (const w of WEIGHTS) {
    const r = replay(t, w);
    row.push(`${r.outcome}(${r.libs}lib,d${r.diverged})`.padStart(34));
  }
  console.log(row.join(""));
}
