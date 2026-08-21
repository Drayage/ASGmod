/**
 * Does the (0,1) answer stone live?
 *
 * `cornerAnswerInsideEnabled` came from the corner solver: over every board size
 * and stone count it was solved at, (0,1) was the only answer point with a
 * positive mean. The solver studies one corner in isolation, which is exactly
 * the assumption a real board breaks — the opponent can bring stones from
 * outside it, and a stone on the first line beside their corner stone is the
 * cheapest thing on the board to hunt.
 *
 * Two games on build 8d50f63 both ended with the engine's group captured, and
 * both captures started from that stone: the answer went down, the player
 * attacked it on the very next move, and stage 1.5 spent four turns failing to
 * save it. This counts the pattern over everything recorded — how often the
 * answer stone's group is still on the board at the end, against how often the
 * book's ordinary corner stones are.
 *
 * "Still on the board" is not the question, and the first version of this asked
 * it and got 100% for everything: a capture ends the game and the stones stay
 * where they are. The captured group is the one left without a liberty on the
 * final board, so that is what membership is tested against.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const pair = (r: number, c: number) => {
  const dr = Math.min(r, 8 - r), dc = Math.min(c, 8 - c);
  return dr <= dc ? [dr, dc] : [dc, dr];
};

type Row = { version: string; kind: string; survived: boolean; lostByCapture: boolean };
const rows: Row[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    const lostByCapture = rec.winReason === "CAPTURE" && rec.winner === human;

    // Final board, to ask what was still standing.
    let end: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      end = applyAction(end, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
    // The group that lost the game: the engine's, with nothing left to breathe.
    const dead = new Set<string>();
    for (const group of getAllGroups(end.board, eng)) {
      if (getGroupLiberties(end.board, group).size > 0) continue;
      for (const cell of group) dead.add(`${cell.row},${cell.col}`);
    }

    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng && m.type === "PLACE") {
        const [a, b] = pair(m.row, m.col);
        const q = quad(m.row, m.col);
        // Did they already hold this corner when the engine played here?
        let theirs = 0;
        for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
          if (quad(r, c) === q && s.board[r][c] === playerCell(human)) theirs += 1;
        }
        const isAnswer = a === 0 && b === 1 && theirs > 0;
        const isFramePoint = a + b === 3 && theirs === 0;
        if (isAnswer || isFramePoint) {
          const alive = !dead.has(`${m.row},${m.col}`);
          rows.push({
            version: rec.appVersion ?? "?",
            kind: isAnswer ? "(0,1) 응수" : "빈 귀 프레임",
            survived: alive,
            lostByCapture,
          });
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

for (const kind of ["(0,1) 응수", "빈 귀 프레임"]) {
  const set = rows.filter((r) => r.kind === kind);
  const alive = set.filter((r) => r.survived).length;
  const inLosses = set.filter((r) => r.lostByCapture).length;
  console.log(
    `${kind.padEnd(14)}  돌 ${String(set.length).padStart(4)}개   ` +
    `잡힌 그룹에 속함 ${String(set.length - alive).padStart(3)} (${(((set.length - alive) / set.length) * 100).toFixed(1)}%)   ` +
    `잡혀서 진 판에 놓인 것 ${inLosses}`,
  );
}
