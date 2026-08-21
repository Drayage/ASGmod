/**
 * In the games the engine lost by capture, what was the group that died made of?
 *
 * Per-stone rates answer the wrong question — a game is lost once, by one group,
 * and most of that group's stones are whatever the defence added afterwards.
 * What matters is which stone the dead group started from.
 *
 * Two games on build 8d50f63 both died from the (0,1) answer stone: it went
 * down, the player attacked it on their next move, and stage 1.5 spent four
 * turns failing to save it. This asks how general that is, split by whether the
 * variant that plays (0,1) was on.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const COLS = "ABCDEFGHI";
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const pairOf = (r: number, c: number) => {
  const dr = Math.min(r, 8 - r), dc = Math.min(c, 8 - c);
  return dr <= dc ? [dr, dc] : [dc, dr];
};

type Loss = { variant: string; version: string; origin: string; plies: number };
const losses: Loss[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    if (!(rec.winReason === "CAPTURE" && rec.winner === human)) continue;

    let end: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      end = applyAction(end, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
    const dead = new Set<string>();
    for (const group of getAllGroups(end.board, eng)) {
      if (getGroupLiberties(end.board, group).size > 0) continue;
      for (const cell of group) dead.add(`${cell.row},${cell.col}`);
    }
    if (dead.size === 0) { losses.push({ variant: rec.aiVariant ?? "?", version: rec.appVersion ?? "?", origin: "그룹 못 찾음", plies: rec.moveHistory.length }); continue; }

    // Walk forward and label the first stone of the dead group.
    let s: GameState = createInitialState();
    let origin = "기타";
    for (const m of rec.moveHistory) {
      if (s.currentPlayer === eng && m.type === "PLACE" && dead.has(`${m.row},${m.col}`)) {
        const [a, b] = pairOf(m.row, m.col);
        const q = quad(m.row, m.col);
        let theirs = 0;
        for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
          if (quad(r, c) === q && s.board[r][c] === playerCell(human)) theirs += 1;
        }
        origin =
          a === 0 && b === 1 && theirs > 0 ? "(0,1) 응수"
          : a + b === 3 && theirs === 0 ? "빈 귀 프레임"
          : a + b === 3 ? "상대 있는 귀 프레임"
          : `기타 ${COLS[m.col]}${m.row + 1} (${a},${b})`;
        break;
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
    losses.push({ variant: rec.aiVariant ?? "?", version: rec.appVersion ?? "?", origin, plies: rec.moveHistory.length });
  }
}

const inside = losses.filter((l) => l.variant === "EYE_INSIDE" || l.variant === "EYE_DENY");
const others = losses.filter((l) => !(l.variant === "EYE_INSIDE" || l.variant === "EYE_DENY"));

function report(label: string, set: Loss[]) {
  console.log(`\n${label} — 잡혀서 진 판 ${set.length}개`);
  const by = new Map<string, number>();
  for (const l of set) {
    const key = l.origin.startsWith("기타 ") ? "기타" : l.origin;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)}${String(v).padStart(3)}  ${((v / set.length) * 100).toFixed(0)}%`);
  }
  const avg = set.reduce((n, l) => n + l.plies, 0) / Math.max(1, set.length);
  console.log(`  판 길이 평균 ${avg.toFixed(1)}수`);
}
report("(0,1) 응수 켠 변형", inside);
report("그 외 변형", others);
