/**
 * Dumps the exact settled-territory margin for every position in a dataset.
 *
 * The training script needs this to test the combination the measurements point
 * at — count the walled-in ground exactly, and ask the model only about the
 * open points, which is the part arithmetic cannot supply. Computing it here
 * rather than reimplementing the flood fill in Python keeps one definition of
 * what territory is; a second copy would be free to drift, and the whole reason
 * this number is trusted is that the rules engine produces it.
 *
 *   npx vite-node settled-margin.mts -- --input positions.jsonl --out settled.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Board, Cell } from "./src/games/alley-boss-cats/types";

function arg(name: string): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

function decodeBoard(encoded: string): Board {
  const board: Board = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line: Cell[] = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const character = encoded[row * BOARD_SIZE + col];
      line.push(
        character === "A"
          ? "PLAYER_A"
          : character === "B"
            ? "PLAYER_B"
            : character === "N"
              ? "NEUTRAL"
              : "EMPTY",
      );
    }
    board.push(line);
  }
  return board;
}

const inputPath = arg("input");
const outPath = arg("out");
if (!inputPath || !outPath) {
  throw new Error("usage: settled-margin.mts -- --input <positions.jsonl> --out <settled.txt>");
}

const out: string[] = [];
for (const line of readFileSync(inputPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const parsed = JSON.parse(line);
  const territories = calculateTerritories(decodeBoard(parsed.board));
  out.push(String(territories.A.length - territories.B.length));
}
writeFileSync(outPath, out.join("\n") + "\n", "utf8");
console.log(`wrote ${out.length} settled margins to ${outPath}`);
