/**
 * Follow-up to corner-c2-joseki.mts: does findBestMoveVeryHard actually avoid
 * or punish the moves the joseki analysis identifies as good/bad, when asked
 * to play the position itself (not just checked with the tactical reader)?
 */
import { CORNERS } from "./corner-policy.mts";
import { createInitialState, applyMove } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import type { Coord, GameState } from "./src/games/alley-boss-cats/types";

const BUDGET_MS = 2000;

function go(frame: (typeof CORNERS)[number], letter: string, digit: number): Coord {
  const j = letter.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
  const i = digit - 1;
  return { row: frame.corner.row + frame.sr * i, col: frame.corner.col + frame.sc * j };
}

function place(state: GameState, coord: Coord): GameState {
  return applyMove(state, coord.row, coord.col);
}

function fmt(c: Coord): string {
  return `(${c.row},${c.col})`;
}

const frame = CORNERS[3]; // BR

console.log("Does the engine, playing White right after Black's C2, choose B1 on its own?");
{
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  state = place(state, c2);
  const action = findBestMoveVeryHard(state, "B", BUDGET_MS);
  const b1 = go(frame, "B", 1);
  const chosenIsB1 = action.type === "PLACE" && action.row === b1.row && action.col === b1.col;
  console.log(`  C2=${fmt(c2)} played by Black. Engine (White) plays: ${JSON.stringify(action)}. Is it B1=${fmt(b1)}? ${chosenIsB1}`);
}

console.log("\nIf White plays B1 anyway (a scripted 'mistake'), what does the engine (Black) do?");
{
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  const b1 = go(frame, "B", 1);
  state = place(state, c2); // Black
  state = place(state, b1); // White (forced mistake, scripted)
  const action = findBestMoveVeryHard(state, "A", BUDGET_MS);
  const a2 = go(frame, "A", 2);
  const chosenIsA2 = action.type === "PLACE" && action.row === a2.row && action.col === a2.col;
  console.log(`  Engine (Black) plays: ${JSON.stringify(action)}. Is it A2=${fmt(a2)} (the joseki's suggested punish)? ${chosenIsA2}`);
  if (!chosenIsA2 && action.type === "PLACE") {
    const next = applyMove(state, action.row, action.col);
    console.log(`  Playing the engine's own choice -> winner=${next.winner ?? "none"} reason=${next.winReason ?? "-"}`);
  }
}

console.log("\nDoes the engine, playing Black right after White's A2 invasion, choose B1 (the joseki's recommended punish)?");
{
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  const a2 = go(frame, "A", 2);
  state = place(state, c2); // Black
  state = place(state, a2); // White
  const action = findBestMoveVeryHard(state, "A", BUDGET_MS);
  const b1 = go(frame, "B", 1);
  const b3 = go(frame, "B", 3);
  const chosenIsB1 = action.type === "PLACE" && action.row === b1.row && action.col === b1.col;
  const chosenIsB3 = action.type === "PLACE" && action.row === b3.row && action.col === b3.col;
  console.log(`  Engine (Black) plays: ${JSON.stringify(action)}. B1=${fmt(b1)}? ${chosenIsB1}  B3=${fmt(b3)}? ${chosenIsB3}`);
}

console.log("\nDoes the engine open with C2 (or its mirror) at all, unprompted, on turn 1?");
{
  const state = createInitialState();
  const action = findBestMoveVeryHard(state, "A", BUDGET_MS);
  console.log(`  Engine's actual turn-1 move: ${JSON.stringify(action)}`);
}
