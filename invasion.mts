/**
 * Who takes the engine's ground away?
 *
 * The engine reaches 39 cells of influence against a person and finishes with
 * 4. Something removes 35 cells, and every experiment so far has assumed the
 * engine simply failed to close them — which is why every fix has been a
 * better way of *valuing* ground. Nobody has checked the other possibility:
 * that the ground is taken.
 *
 * The distinction is not academic. If the engine's framework collapses because
 * the human walks into it, then it is not building the wrong ground, it is
 * building ground with holes in it and not defending them, and no evaluation
 * term that only prices the ground can help. It would also explain the one
 * thing nothing else has: why the defect is opponent-dependent. Two engines
 * both sprawl and neither invades, so both frameworks stand and both convert
 * around 22%. A person walks in, and only theirs stands.
 *
 * For every move of every recorded game this asks where it landed — inside the
 * mover's own influence, inside their opponent's, or on ground neither claims
 * — and splits the answer by who was moving.
 *
 *   npx vite-node invasion.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { influenceCount, influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { BOARD_SIZE, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  firstRole?: string;
  secondRole?: string;
  moveHistory: Move[];
}

const FILES = [
  { path: "src/games/alley-boss-cats/testdata/humanGames.json", kind: "vs-engine" as const },
  { path: "docs/pro-games-20230822.json", kind: "human-only" as const },
  { path: "docs/community-games.json", kind: "human-only" as const },
].filter((file) => existsSync(file.path));

interface Tally {
  moves: number;
  intoTheirs: number;
  intoMine: number;
  neutral: number;
  /** Opponent influence lost over the two plies following an invasion. */
  theirLossAfterInvasion: number[];
}
const blank = (): Tally => ({
  moves: 0,
  intoTheirs: 0,
  intoMine: 0,
  neutral: 0,
  theirLossAfterInvasion: [],
});
const tallies = new Map<string, Tally>();
const bucket = (label: string) => {
  const found = tallies.get(label);
  if (found) return found;
  const made = blank();
  tallies.set(label, made);
  return made;
};

for (const file of FILES) {
  const parsed = JSON.parse(readFileSync(file.path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    // Label each seat. Games against this engine name a human side; the rest
    // are person against person and are reported together as a control.
    let labels: Record<Player, string> | null = null;
    if (file.kind === "vs-engine" && record.playerSide) {
      const other = record.playerSide === "A" ? "B" : "A";
      labels = { [record.playerSide]: "human", [other]: "engine" } as Record<Player, string>;
    } else if (record.firstRole && record.secondRole) {
      labels = { A: "human (vs human)", B: "human (vs human)" } as Record<Player, string>;
    }
    if (!labels) continue;

    let state: GameState = createInitialState();
    const history: Array<{ state: GameState; mover: Player; invaded: boolean }> = [];

    for (const move of record.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const foe = opponent(mover);

      let invaded = false;
      if (move.type === "PLACE") {
        const owners = influenceOwnerMap(state.board);
        const owner = owners[move.row! * BOARD_SIZE + move.col!];
        const tally = bucket(labels[mover]);
        tally.moves += 1;
        if (owner === foe) {
          tally.intoTheirs += 1;
          invaded = true;
        } else if (owner === mover) tally.intoMine += 1;
        else tally.neutral += 1;
      }

      history.push({ state, mover, invaded });
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
    history.push({ state, mover: state.currentPlayer, invaded: false });

    // What an invasion cost its target: the opponent's influence just before
    // it, against their influence two plies later.
    for (let index = 0; index < history.length - 2; index += 1) {
      const entry = history[index];
      if (!entry.invaded) continue;
      const foe = opponent(entry.mover);
      const before = influenceCount(entry.state.board)[foe];
      const after = influenceCount(history[index + 2].state.board)[foe];
      bucket(labels[entry.mover]).theirLossAfterInvasion.push(before - after);
    }
  }
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

console.log(`moves by where they landed, from ${FILES.length} file(s)\n`);
console.log(
  `${"".padEnd(18)}${"moves".padStart(8)}${"into theirs".padStart(14)}` +
    `${"into own".padStart(11)}${"neutral".padStart(10)}`,
);
for (const [label, t] of tallies) {
  console.log(
    `${label.padEnd(18)}${String(t.moves).padStart(8)}` +
      `${pct(t.intoTheirs, t.moves).padStart(14)}` +
      `${pct(t.intoMine, t.moves).padStart(11)}` +
      `${pct(t.neutral, t.moves).padStart(10)}`,
  );
}

console.log("\nwhat an invasion cost its target (their influence, two plies later):");
for (const [label, t] of tallies) {
  const loss = summarize(t.theirLossAfterInvasion);
  console.log(
    `  ${label.padEnd(18)} n=${String(loss.count).padStart(4)}  ` +
      `mean ${String(loss.mean ?? "—").padStart(9)} cells`,
  );
}
