/**
 * Where a territory loss actually happened.
 *
 * Two games decided on count with no capture are the cleanest read there is on
 * the thing this branch is stuck on, so this prints, per engine turn: the stage
 * that chose the move, and both sides' settled count right after it. A frame
 * that ends at twenty cells did not arrive at the end, and the turn the count
 * jumps is the turn worth reading.
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { cornerBookEnabled } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
const MS = Number(process.env.MS ?? 3000);

applyAIVariant((process.env.V ?? "EYE_INSIDE") as any);
// The measurement hazard documented on applyAIVariant: fail loudly rather than
// quietly reporting STANDARD under a variant's name.
if (!cornerBookEnabled) throw new Error("variant did not take — see applyAIVariant's warning");

for (const path of process.argv.slice(2)) {
  const recs = JSON.parse(readFileSync(path, "utf8")).records ?? [];
  recs.forEach((rec: any, gi: number) => {
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    console.log(
      `\n=== ${gi + 1}판 (${rec.appVersion})  사람 ${human} / 엔진 ${eng}  ` +
      `${rec.winner === eng ? "엔진 승" : "사람 승"} ${rec.winReason} ` +
      `A ${rec.territoryA} : B ${rec.territoryB} ===`,
    );
    let s: GameState = createInitialState();
    let prevTheirs = 0;
    rec.moveHistory.forEach((m: any, k: number) => {
      let stage = "";
      let picked = "";
      if (s.currentPlayer === eng && m.type === "PLACE") {
        const a = findBestMoveVeryHard(s, eng, MS);
        stage = lastDecision.stage;
        picked = a.type === "PLACE" ? nm(a.row, a.col) : "PASS";
      }
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
      const t = calculateTerritories(s.board);
      const theirs = t[human].length;
      const jump = theirs - prevTheirs;
      prevTheirs = theirs;
      const who = m.player === eng ? "엔진" : "사람";
      console.log(
        `${String(k + 1).padStart(3)}수 ${who} ${(m.type === "PASS" ? "PASS" : nm(m.row, m.col)).padEnd(5)}` +
        `집 엔진 ${String(t[eng].length).padStart(2)} : 사람 ${String(theirs).padStart(2)}` +
        `${jump >= 4 ? `  <<< 사람 +${jump}` : "          "}` +
        `${stage ? `  [${stage}]${picked && picked !== nm(m.row, m.col) ? ` (지금엔진 ${picked})` : ""}` : ""}`,
      );
    });
  });
}
