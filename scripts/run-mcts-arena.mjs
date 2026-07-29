import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const games = readArg("games", "4");
const moveMs = readArg("move-ms", "300");
const simulations = readArg("simulations", "10000");
const maxMoves = readArg("max-moves", "90");
const seed = readArg("seed", "20260729");

console.log(
  `Starting CURRENT vs HYBRID_MCTS arena: games=${games}, move-ms=${moveMs}, simulations=${simulations}, max-moves=${maxMoves}, seed=${seed}`,
);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const testFile = "src/games/alley-boss-cats/engine/mctsArena.test.ts";
const result = spawnSync(process.execPath, [vitest, "run", testFile, "--reporter=verbose"], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
  env: {
    ...process.env,
    RUN_MCTS_ARENA: "1",
    ABC_ARENA_GAMES: games,
    ABC_ARENA_MOVE_MS: moveMs,
    ABC_ARENA_MCTS_SIMULATIONS: simulations,
    ABC_ARENA_MAX_MOVES: maxMoves,
    ABC_ARENA_SEED: seed,
  },
});

if (result.error) throw result.error;

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const plain = stdout.replace(ansiPattern, "");
const jsonMatch = plain.match(/ARENA_JSON:(\{.*\})/);

if (jsonMatch) {
  const arena = JSON.parse(jsonMatch[1]);
  writeFileSync("mcts-arena.json", `${JSON.stringify(arena, null, 2)}\n`, "utf8");
  console.log("Saved detailed move log to mcts-arena.json");
} else if ((result.status ?? 1) === 0) {
  console.warn("Arena completed, but no machine-readable result was found.");
}

// The JSON marker can be very large. Keep it out of the visible Actions log;
// the formatted data is available in mcts-arena.json instead.
const visibleStdout = stdout
  .split(/\r?\n/)
  .filter((line) => !line.includes("ARENA_JSON:"))
  .join("\n");
process.stdout.write(visibleStdout);
if (visibleStdout && !visibleStdout.endsWith("\n")) process.stdout.write("\n");
if (stderr) process.stderr.write(stderr);

process.exit(result.status ?? 1);
