/** The board at the move where the engine filled its own eye point. */
import { readFileSync } from "node:fs";
import { applyAction, evaluateComponents } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
const C = "ABCDEFGHI";
const F = process.argv[2]!;
for (const [game, turn, eye, plan] of [["1", 13, "C9", "B9/D9"], ["2", 13, "D9", "C9/E9"]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const ai: Player = opponent(rec.playerSide);
  let s: GameState = createInitialState();
  let played = "";
  for (const m of rec.moveHistory) {
    if (m.turn === turn) { played = `${C[m.col!]}${m.row! + 1}`; break; }
    s = m.type === "PASS" ? applyAction(s, { type: "PASS" }) : applyAction(s, { type: "PLACE", row: m.row!, col: m.col! });
  }
  console.log(`\ngame ${game}, before turn ${turn} — AI is ${ai}, it played ${played}`);
  console.log(`  the eye was ${eye}, made by ${plan}\n`);
  const lines = [`     ${[...C].join(" ")}`];
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c++) {
      const v = s.board[r][c];
      row.push(v === "PLAYER_A" ? "A" : v === "PLAYER_B" ? "B" : v === "NEUTRAL" ? "#" : ".");
    }
    lines.push(`  ${String(r + 1).padStart(2)} ${row.join(" ")}`);
  }
  console.log(lines.join("\n"));
  // What the evaluation thought of filling the eye, against making it.
  const at = (p: string) => ({ row: Number(p.slice(1)) - 1, col: C.indexOf(p[0]) });
  for (const point of [played, ...plan.split("/")]) {
    const parts = evaluateComponents(applyAction(s, { type: "PLACE", ...at(point) }), ai);
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    console.log(
      `  ${point}: total ${total.toFixed(0).padStart(6)}` +
        `   myLiberties ${(parts.myLiberties ?? 0).toFixed(0).padStart(4)}` +
        `   immortal ${(parts.immortal ?? 0).toFixed(0).padStart(4)}` +
        `   territory ${(parts.territory ?? 0).toFixed(0).padStart(6)}`,
    );
  }
}
