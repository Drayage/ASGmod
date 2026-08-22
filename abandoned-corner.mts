/**
 * The corner the engine never enters.
 *
 * All three games on e41bae8 end with one quadrant holding 0-2 engine stones and
 * 8-11 of the player's cells. This checks the book's own gate at the moment the
 * engine could still have gone there: CORNER_BOOK_MAX_ENEMY writes a corner off
 * once it holds three of theirs, and nothing below the book ever contests it.
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const QUADS = ["위왼", "위오", "아래왼", "아래오"];
applyAIVariant("EYE_PAIR");
if (!cornerBookEnabled) throw new Error("variant did not take");

const recs = JSON.parse(readFileSync(process.argv[2], "utf8")).records.slice(0, 3);
recs.forEach((rec: any, gi: number) => {
  const human: Player = rec.playerSide;
  const eng = opponent(human);
  console.log(`\n=== ${gi + 1}판 (엔진 ${eng})`);
  let s: GameState = createInitialState();
  let turn = 0;
  const reported = new Set<string>();
  for (const m of rec.moveHistory) {
    if (s.currentPlayer === eng) {
      turn += 1;
      for (const q of QUADS) {
        let mine = 0, theirs = 0;
        for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
          if (quad(r, c) !== q) continue;
          if (s.board[r][c] === playerCell(eng)) mine += 1;
          else if (s.board[r][c] === playerCell(human)) theirs += 1;
        }
        // The turn a corner passes out of the book's reach for good.
        if (mine === 0 && theirs === 3 && !reported.has(q)) {
          reported.add(q);
          console.log(`  엔진 ${turn}번째 수 시점: ${q} 에 상대 돌 3개, 내 돌 0개 → 책의 한도(2) 초과, 이후 후보에서 제외`);
        }
      }
    }
    s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
  }
  if (reported.size === 0) console.log("  (한도를 넘긴 귀 없음)");
});
