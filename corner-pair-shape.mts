/**
 * Which pair does the book actually end up with, and when it is the bad one, why?
 *
 * The corner solver is unambiguous: over all 120 two-stone starts, (1,2) with
 * (2,1) kills an invader at every one of eight entry points and (1,2) with (0,3)
 * lets five of eight live, ranking 61st. `cornerFrameCentreEnabled` exists to
 * prefer the first, breaking the distance tie toward the more central point.
 *
 * The player asks whether the engine is deliberately choosing otherwise. This
 * separates the two possibilities: the tie-break picking wrong, or the good
 * point already being taken by the time the engine gets there.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const pairOf = (r: number, c: number): [number, number] => {
  const dr = Math.min(r, 8 - r), dc = Math.min(c, 8 - c);
  return dr <= dc ? [dr, dc] : [dc, dr];
};
/** The two mirror points of a corner at edge distances (a,b). */
function mirrors(q: string, a: number, b: number) {
  const rowEdge = q[0] === "위" ? 0 : 8;
  const colEdge = q[1] === "왼" ? 0 : 8;
  const step = (n: number, edge: number) => (edge === 0 ? n : edge - n);
  return [
    { row: step(a, rowEdge), col: step(b, colEdge) },
    { row: step(b, rowEdge), col: step(a, colEdge) },
  ];
}

let good = 0, bad = 0, badTaken = 0, badFree = 0, badBlock = 0;
const badFreeWhere: string[] = [];

/** The `flanked` rule from cornerBookMove: an edge-side frame point with an
 * enemy stone beside it along that edge is a block, not an eye. */
function flanked(board: GameState["board"], row: number, col: number, foe: Player): boolean {
  const dr = Math.min(row, 8 - row), dc = Math.min(col, 8 - col);
  if (Math.min(dr, dc) !== 0) return false;
  const along: Array<[number, number]> = dr === 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  return along.some(([ar, ac]) => {
    const r = row + ar, c = col + ac;
    return r >= 0 && c >= 0 && r < 9 && c < 9 && board[r][c] === playerCell(foe);
  });
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s: GameState = createInitialState();
    const opened = new Map<string, [number, number]>(); // quadrant -> first frame pair
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng && m.type === "PLACE") {
        const [a, b] = pairOf(m.row, m.col);
        const q = quad(m.row, m.col);
        if (a + b === 3) {
          const first = opened.get(q);
          if (!first) {
            opened.set(q, [a, b]);
          } else if (first[0] === 1 && first[1] === 2) {
            // Second frame stone in a corner opened at (1,2): (2,1) or (0,3)?
            if (a === 1 && b === 2) {
              good += 1;
            } else if (a === 0 && b === 3) {
              bad += 1;
              // Was the mirror (2,1) point still empty at that moment?
              const alt = mirrors(q, 1, 2).find(
                (p) => !(p.row === m.row && p.col === m.col),
              )!;
              // Both mirrors are (1,2)-class; find the one not already ours.
              const cands = mirrors(q, 1, 2).filter(
                (p) => s.board[p.row][p.col] !== playerCell(eng),
              );
              // Empty is not the same as playable: the book filters its gaps
              // through the rules, and a cell can be empty and still illegal —
              // confirmed territory, or a placement the rules refuse.
              const free = cands.some((p) => isLegalMove(s, p.row, p.col, eng));
              if (!free) badTaken += 1;
              else if (flanked(s.board, m.row, m.col, human)) badBlock += 1;
              else { badFree += 1; badFreeWhere.push(`${rec.appVersion ?? "?"} ${q}`); }
              void alt;
            }
            opened.set(q, [9, 9]); // counted once per corner
          }
        }
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}

console.log(`(1,2) 로 연 귀에 두 번째 프레임 돌을 놓은 경우 ${good + bad}건\n`);
console.log(`  (2,1) — 솔버 1위, 침입 8곳 전부 사망     ${good}건  ${((good / (good + bad)) * 100).toFixed(0)}%`);
console.log(`  (0,3) — 솔버 61위, 침입 8곳 중 5곳 생존   ${bad}건  ${((bad / (good + bad)) * 100).toFixed(0)}%`);
console.log(`\n  그 (0,3) ${bad}건의 내역`);
console.log(`    (2,1) 자리가 이미 막혀 있었음               ${badTaken}건`);
console.log(`    막는 수 예외가 발동 (상대가 옆에 붙어 있음)   ${badBlock}건`);
console.log(`    (2,1) 이 비었고 예외도 아닌데 (0,3)          ${badFree}건`);
if (badFree > 0) {
  // Grouped by build, because cornerFrameCentreEnabled has not always existed:
  // a case from an old recording says nothing about the engine shipping now.
  const byBuild = new Map<string, number>();
  for (const w of badFreeWhere) {
    const build = w.split(" ")[0];
    byBuild.set(build, (byBuild.get(build) ?? 0) + 1);
  }
  console.log("\n  그 40건을 빌드별로:");
  for (const [b, n] of [...byBuild.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${b.padEnd(12)}${String(n).padStart(3)}건`);
  }
}

/**
 * The question the numbers above raise: if the player answers (1,2) with its
 * mirror every time, then opening a corner at (1,2) is walking into it, and the
 * book has no plan for that. This counts how often the reply actually comes.
 */
{
  let opens = 0;
  let mirrored = 0;
  let elsewhereInCorner = 0;
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    let recs: any[];
    try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
    for (const rec of recs) {
      if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
      const human: Player = rec.playerSide;
      const eng = opponent(human);
      let s: GameState = createInitialState();
      const history = rec.moveHistory;
      for (let i = 0; i < history.length - 1; i += 1) {
        const m = history[i];
        if (s.currentPlayer === eng && m.type === "PLACE") {
          const [a, b] = pairOf(m.row, m.col);
          const q = quad(m.row, m.col);
          let mine = 0;
          for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
            if (quad(r, c) === q && s.board[r][c] === playerCell(eng)) mine += 1;
          }
          // Opening a corner: our first stone there, on the (1,2) point.
          if (mine === 0 && a === 1 && b === 2) {
            opens += 1;
            const reply = history[i + 1];
            if (reply?.type === "PLACE") {
              const mirror = mirrors(q, 1, 2).find((p) => !(p.row === m.row && p.col === m.col))!;
              if (reply.row === mirror.row && reply.col === mirror.col) mirrored += 1;
              else if (quad(reply.row, reply.col) === q) elsewhereInCorner += 1;
            }
          }
        }
        s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
      }
    }
  }
  const pc = (n: number) => `${((n / opens) * 100).toFixed(0)}%`;
  console.log(`\n엔진이 빈 귀를 (1,2) 로 연 ${opens}번에 대한 상대의 다음 수`);
  console.log(`  그 귀의 (2,1) — 짝을 정확히 뺏음   ${mirrored}건  ${pc(mirrored)}`);
  console.log(`  같은 귀의 다른 자리              ${elsewhereInCorner}건  ${pc(elsewhereInCorner)}`);
  console.log(`  다른 곳                          ${opens - mirrored - elsewhereInCorner}건  ${pc(opens - mirrored - elsewhereInCorner)}`);
}
