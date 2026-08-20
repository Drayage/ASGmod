/**
 * What the cheap invasion read costs, in verdicts and in milliseconds.
 *
 * judgeFramework decides "is this region really theirs" by trying to prove a
 * forced kill of an invading cat, and an *unproven* kill counts the invasion as
 * living. So a starved read does not make frames look safe — it makes them look
 * hollow, and both stages that consult it (1.87 deny theirs, 1.9 finish mine)
 * only fire on frames judged secure. Being cheap here shows up as the engine
 * ignoring frames on both sides of the board.
 *
 * This walks every engine turn of the recorded games and asks how the verdicts
 * move as the read gets less cheap, next to what the extra reading costs per
 * turn. Both are needed: a setting that finds more is only worth having if the
 * search it takes the time from can spare it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { rankFrameworks, setInvasionDeepenEnabled, setInvasionRead, setInvasionTempoHonest } from "./src/games/alley-boss-cats/engine/frameworks";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const FRAMEWORK_MAX_GAPS = 3;

/** ms per invasion, depth, and the outer budget rankFrameworks is given. The
 * outer one has to grow with the inner: judgeFramework is handed
 * ms * MAX_INVASION_CHECKS, and the outer deadline cuts the frame loop off. */
const SETTINGS: Array<[number, number, number]> = (process.env.SETTINGS ?? "25:5:300,25:8:300,50:8:600,100:8:1200")
  .split(",")
  .map((s) => s.split(":").map(Number) as [number, number, number]);

type Position = { state: GameState; eng: Player; human: Player };
const positions: Position[] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      // Only turns where the engine is to move and the board is worth judging.
      if (s.currentPlayer === eng) positions.push({ state: s, eng, human });
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
  }
}
// Sampled: the question is a rate, and every third turn of a hundred games
// answers it as well as all of them for a fraction of the reading.
const STRIDE = Number(process.env.STRIDE ?? 3);
const sample = positions.filter((_, i) => i % STRIDE === 0);
positions.length = 0;
positions.push(...sample);
console.log(`${positions.length} 엔진 턴 (${STRIDE}턴마다 하나)\n`);

/** A frame this stage would act on: secure, started, and a few moves from done. */
const actionable = (v: any) => v.secure && v.movesToClose > 0 && v.movesToClose <= FRAMEWORK_MAX_GAPS;

console.log(
  `${"ms".padStart(4)}${"깊이".padStart(5)}${"바깥예산".padStart(9)}` +
  `${"상대 틀 있음".padStart(14)}${"내 틀 있음".padStart(13)}${"턴당 ms".padStart(10)}`,
);
setInvasionTempoHonest(process.env.TEMPO === "honest");
setInvasionDeepenEnabled(process.env.DEEPEN === "1");
for (const [ms, depth, outer] of SETTINGS) {
  setInvasionRead(ms, depth);
  let theirs = 0;
  let mine = 0;
  const started = Date.now();
  for (const p of positions) {
    if (rankFrameworks(p.state, p.human, outer).some(actionable)) theirs += 1;
    if (rankFrameworks(p.state, p.eng, outer).some(actionable)) mine += 1;
  }
  const perTurn = (Date.now() - started) / positions.length;
  const pc = (n: number) => `${((n / positions.length) * 100).toFixed(1)}%`;
  console.log(
    `${String(ms).padStart(4)}${String(depth).padStart(5)}${String(outer).padStart(9)}` +
    `${`${theirs} (${pc(theirs)})`.padStart(14)}${`${mine} (${pc(mine)})`.padStart(13)}` +
    `${perTurn.toFixed(1).padStart(10)}`,
  );
}
