/**
 * Does the joseki bot predict the player better than the engine does?
 *
 * The bot is a guess at their strategy, and tuning the engine against a guess
 * would be fitting the engine to my reading of them. So before it is used as an
 * instrument it has to earn it: replayed over every position they actually
 * faced, it should name the move they played more often than the engine does
 * from the same position.
 *
 * The engine is the right baseline rather than chance. It is a strong player
 * that is not trying to be them, so the gap between the two is the part of their
 * policy the bot has captured and the engine has not — which is exactly what the
 * bot is for.
 *
 *   npx vite-node joseki-fit.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { josekiBotMove } from "./src/games/alley-boss-cats/engine/josekiBot";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const THINK = Number(process.env.THINK ?? 400);
const UPTO = Number(process.env.UPTO ?? 30);

const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

interface Tally { seen: number; bot: number; engine: number; both: number }
const blank = (): Tally => ({ seen: 0, bot: 0, engine: 0, both: 0 });
const overall = blank();
const byPhase: Record<string, Tally> = { "1-10": blank(), "11-20": blank(), "21+": blank() };

const seen = new Set<string>();
applyAIVariant("EYE_FRAME_TIGHT");

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    let own = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      if (mover === human && m.type === "PLACE") {
        own += 1;
        if (own <= UPTO) {
          const played = nm(m.row!, m.col!);
          const bot = josekiBotMove(state, human);
          const engine = findBestMoveVeryHard(state, human, THINK);
          const botSays = bot.type === "PLACE" ? nm(bot.row, bot.col) : "PASS";
          const engineSays = engine.type === "PLACE" ? nm(engine.row, engine.col) : "PASS";
          const phase = own <= 10 ? "1-10" : own <= 20 ? "11-20" : "21+";
          for (const t of [overall, byPhase[phase]]) {
            t.seen += 1;
            if (botSays === played) t.bot += 1;
            if (engineSays === played) t.engine += 1;
            if (botSays === played && engineSays === played) t.both += 1;
          }
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
/** Interval on a difference of two proportions measured on the same positions. */
const pairedCi = (t: Tally) => {
  const b = t.bot / t.seen;
  const e = t.engine / t.seen;
  const both = t.both / t.seen;
  const varDiff = b + e - 2 * both - (b - e) ** 2;
  return 1.96 * Math.sqrt(Math.max(varDiff, 0) / t.seen);
};

console.log(`how often each names the move the player actually played`);
console.log(`their first ${UPTO} moves of each game, engine thinking ${THINK}ms\n`);
console.log(
  `${"phase".padEnd(10)}${"positions".padStart(11)}${"joseki bot".padStart(13)}` +
    `${"engine".padStart(10)}${"difference".padStart(20)}`,
);
for (const [label, t] of [["overall", overall], ...Object.entries(byPhase)] as Array<[string, Tally]>) {
  if (t.seen === 0) continue;
  const diff = (100 * (t.bot - t.engine)) / t.seen;
  console.log(
    `${label.padEnd(10)}${String(t.seen).padStart(11)}${pct(t.bot, t.seen).padStart(13)}` +
      `${pct(t.engine, t.seen).padStart(10)}` +
      `${`${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp +/- ${(100 * pairedCi(t)).toFixed(1)}`.padStart(20)}`,
  );
}
