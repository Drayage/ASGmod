/**
 * Every move the reader calls a forced capture must actually be one.
 *
 * This is the test that should have existed before any ladder code was
 * written. For each puzzle it takes the reader's answer, plays it, and checks
 * that no defender reply survives a fresh read. A single survivor means the
 * reader invented a win — which in this game is a losing move played with
 * confidence.
 */
import { describe, expect, it } from "vitest";
import { findForcedCapture, setCaptureRetargets } from "./captureSearch";
import { applyMove, getLegalMoves } from "../rules";
import { BOARD_SIZE, CENTER, playerCell } from "../types";
import type { Board, GameState } from "../types";
const C = "ABCDEFGHI";
const P = (s: string) => ({ row: Number(s.slice(1)) - 1, col: C.indexOf(s[0]) });
const N = (r: number, c: number) => C[c] + (r + 1);
function build(blue: string[], orange: string[]): GameState {
  const b: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  b[CENTER][CENTER] = "NEUTRAL";
  for (const p of blue) { const { row, col } = P(p); b[row][col] = playerCell("A"); }
  for (const p of orange) { const { row, col } = P(p); b[row][col] = playerCell("B"); }
  return { board: b, currentPlayer: "A", remainingCats: { A: 36, B: 36 }, consecutivePasses: 0,
    territories: { A: [], B: [] }, winner: null, winReason: null, moveHistory: [] };
}
const PUZZLES: [string, string[], string[], string][] = [
  ["1", ["E7","D8","D9"], ["F7","E8","E9"], "F8"],
  ["2", ["B3","B6","A8"], ["B7","B9"], "B8"],
  ["3", ["F6","D7","E7","C8"], ["F7","D8","E8","C9"], "F8"],
  ["4", ["C6","E6","F6"], ["C5","D6","E7"], "D7"],
];
describe("the capture reader never invents a forced capture", () => {
  for (const [name, blue, orange, published] of PUZZLES) {
    for (const retargets of [0, 1]) {
      it(`problem ${name}, retargets ${retargets}: any move it calls forced really is`, () => {
        setCaptureRetargets(retargets);
        try {
          const state = build(blue, orange);
          const found = findForcedCapture(state, "A", 7, 600);
          if (!found) return; // a miss is allowed; a false claim is not
          expect(found.move.type).toBe("PLACE");
          const move = found.move as { type: "PLACE"; row: number; col: number };
          const after = applyMove(state, move.row, move.col);
          const survivors: string[] = [];
          for (const reply of getLegalMoves(after, "B")) {
            const next = applyMove(after, reply.row, reply.col);
            if (next.winner === "A") continue;
            if (next.winner === "B" || !findForcedCapture(next, "A", 9, 3000)) {
              survivors.push(N(reply.row, reply.col));
            }
          }
          expect(
            survivors,
            `${N(move.row, move.col)} (published ${published}) is not forced: ` +
              `${survivors.length} replies survive, e.g. ${survivors.slice(0, 5).join(" ")}`,
          ).toEqual([]);
        } finally {
          setCaptureRetargets(0);
        }
      });
    }
  }
});
