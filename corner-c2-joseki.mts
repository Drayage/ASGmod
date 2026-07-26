/**
 * Verifies a community-posted corner joseki ("그레이트킹덤 초반 귀퉁이 정석") against
 * this game's actual rules, for all four corners. Written from the user's own
 * bottom-left-corner, Go-style coordinate description:
 *
 *   가로 A,B,C... (column letters, A=0-indexed), 세로 1,2,3... (row numbers,
 *   counted inward from the corner's own edge), 왼쪽 아래 = corner.
 *
 * Reuses CORNERS from corner-policy.mts (already verified consistent with the
 * engine's four-corner rotation/reflection) so every claim below is checked
 * against all four corners, not just the one the post described.
 *
 * Never touches the shipped engine -- pure simulation via createInitialState /
 * applyMove and the existing capture reader.
 */
import { CORNERS } from "./corner-policy.mts";
import { createInitialState, applyMove, isLegalMove, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { evaluateState, candidateActions, applyAction } from "./src/games/alley-boss-cats/ai";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const CAPTURE_READ_DEPTH = 7;
const CAPTURE_READ_MS = 400;

/** Go-style (letter, digit) -> real board coordinate for a given corner frame.
 * digit is 1-indexed, counting inward from the corner's own edge. */
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

console.log("=".repeat(70));
console.log("Section 2: does C2, then White B1, then Black A2 capture B1 outright?");
console.log("=".repeat(70));
for (const frame of CORNERS) {
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  const b1 = go(frame, "B", 1);
  const a2 = go(frame, "A", 2);
  state = place(state, c2); // Black (A)
  state = place(state, b1); // White (B)
  state = place(state, a2); // Black (A)
  const captured = state.winner === "A" && state.winReason === "CAPTURE";
  console.log(
    `${frame.name}: C2=${fmt(c2)} B1=${fmt(b1)} A2=${fmt(a2)} -> ` +
      `winner=${state.winner ?? "none"} reason=${state.winReason ?? "-"} ` +
      `(claim, read literally as "captured on the spot") => ${captured ? "CONFIRMED" : "NOT CONFIRMED"}`,
  );
  if (captured) continue;

  // Not captured on the spot -- B1 still has real liberties. But the post's
  // claim is better read the way a Go player means "그대로 게임이 끝남": not
  // "captured this instant" but "already a dead stone, nothing saves it from
  // here." That's a stronger, checkable claim: does *every* legal White
  // reply from here still leave Black a forced capture? If so, White's B1
  // reply was already fatal the moment Black answered with A2, regardless of
  // how many more moves the actual capture takes on the board.
  const board = state.board;
  if (board[b1.row][b1.col] === "PLAYER_B") {
    const group = getConnectedGroup(board, b1.row, b1.col);
    const libs = getGroupLiberties(board, group);
    console.log(`    B1 still on the board: group=${JSON.stringify(group)} liberties=${[...libs].join(" ")}`);
  }

  const legalWhiteMoves = getLegalMoves(state, "B");
  let safe = 0;
  const safeMoves: Coord[] = [];
  for (const move of legalWhiteMoves) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner) continue;
    if (!findForcedCapture(next, "A", CAPTURE_READ_DEPTH, CAPTURE_READ_MS)) {
      safe++;
      safeMoves.push(move);
    }
  }
  console.log(
    `    Read as "already dead, no reply saves it": of ${legalWhiteMoves.length} legal White replies, ` +
      `${safe} escape a forced capture (${CAPTURE_READ_DEPTH}-ply / ${CAPTURE_READ_MS}ms each) ` +
      `=> ${safe === 0 ? "CONFIRMED" : `NOT CONFIRMED (escapes: ${safeMoves.map(fmt).join(" ")})`}`,
  );
}

console.log("\n" + "=".repeat(70));
console.log("Section 3: C2, White A2, Black B1 -- what are White's actual safe replies?");
console.log("=".repeat(70));
for (const frame of CORNERS) {
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  const a2 = go(frame, "A", 2);
  const b1 = go(frame, "B", 1);
  const b3 = go(frame, "B", 3);
  const b4 = go(frame, "B", 4);
  state = place(state, c2); // Black (A)
  state = place(state, a2); // White (B)
  state = place(state, b1); // Black (A)
  console.log(`\n${frame.name}: after C2=${fmt(c2)} A2(W)=${fmt(a2)} B1=${fmt(b1)}, White to move.`);

  if (state.winner) {
    console.log(`    Game already decided: winner=${state.winner} reason=${state.winReason}`);
    continue;
  }

  const legalMoves = getLegalMoves(state, "B");
  const safeReplies: Coord[] = [];
  const losingReplies: Coord[] = [];
  for (const move of legalMoves) {
    const next = applyMove(state, move.row, move.col);
    if (next.winner === "B") {
      safeReplies.push(move); // wins outright, definitely "safe"
      continue;
    }
    if (next.winner) continue; // lost immediately -- not safe, don't even need the reader
    const forced = findForcedCapture({ ...next, currentPlayer: "A" }, "A", CAPTURE_READ_DEPTH, CAPTURE_READ_MS);
    if (forced) losingReplies.push(move);
    else safeReplies.push(move);
  }

  console.log(`    Legal White replies: ${legalMoves.length}`);
  console.log(`    Safe (per findForcedCapture, ${CAPTURE_READ_DEPTH}-ply / ${CAPTURE_READ_MS}ms each): ${safeReplies.length}`);
  console.log(`    -> ${safeReplies.map(fmt).join(" ")}`);
  console.log(`    Provably losing: ${losingReplies.length}`);
  const b3IsSafe = safeReplies.some((m) => m.row === b3.row && m.col === b3.col);
  const b4IsSafe = safeReplies.some((m) => m.row === b4.row && m.col === b4.col);
  console.log(`    B3=${fmt(b3)} safe? ${b3IsSafe}   B4=${fmt(b4)} safe? ${b4IsSafe}`);

  // If White tenukis (plays far from the corner), how many Black moves until
  // a forced capture is provable? Use the corner's own diagonal opposite as a
  // stand-in "far away" reply.
  const farAway = go(CORNERS[(CORNERS.indexOf(frame) + 2) % 4], "C", 2);
  if (isLegalMove(state, farAway.row, farAway.col, "B")) {
    const tenuki = applyMove(state, farAway.row, farAway.col);
    const forcedNow = findForcedCapture({ ...tenuki, currentPlayer: "A" }, "A", CAPTURE_READ_DEPTH, CAPTURE_READ_MS);
    console.log(
      `    If White tenukis to ${fmt(farAway)} instead: forced capture provable immediately? ${forcedNow !== null}`,
    );
  }
}

console.log("\n" + "=".repeat(70));
console.log("Section 4: C2, White A2, Black B3, White B1 -- White's confirmed territory?");
console.log("=".repeat(70));
for (const frame of CORNERS) {
  let state = createInitialState();
  const c2 = go(frame, "C", 2);
  const a2 = go(frame, "A", 2);
  const b3 = go(frame, "B", 3);
  const b1 = go(frame, "B", 1);
  state = place(state, c2); // Black
  state = place(state, a2); // White
  state = place(state, b3); // Black
  if (state.winner) {
    console.log(`${frame.name}: game already decided after B3: winner=${state.winner} reason=${state.winReason}`);
    continue;
  }
  state = place(state, b1); // White
  console.log(
    `${frame.name}: C2=${fmt(c2)} A2(W)=${fmt(a2)} B3=${fmt(b3)} B1(W)=${fmt(b1)} -> ` +
      `winner=${state.winner ?? "none"} territoryA=${state.territories.A.length} territoryB=${state.territories.B.length}`,
  );
  if (!state.winner) {
    console.log(`    White(B) territory cells: ${JSON.stringify(state.territories.B)}`);
  }
}

console.log("\n" + "=".repeat(70));
console.log("Bonus: how does findBestMoveVeryHard's 1-ply opening score rate C2 (and its mirror)?");
console.log("=".repeat(70));
{
  const state = createInitialState();
  const placements = candidateActions(state, "A").filter(
    (a): a is Extract<typeof a, { type: "PLACE" }> => a.type === "PLACE",
  );
  const ranked = placements
    .map((action) => ({ action, score: evaluateState(applyAction(state, action), "A") }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0].score;
  const frame = CORNERS[3]; // BR, arbitrary
  const c2 = go(frame, "C", 2);
  const b3 = go(frame, "B", 3);
  const c2Rank = ranked.findIndex((r) => r.action.row === c2.row && r.action.col === c2.col);
  const b3Rank = ranked.findIndex((r) => r.action.row === b3.row && r.action.col === b3.col);
  console.log(`Best opening score: ${best}`);
  console.log(`C2=${fmt(c2)}: rank ${c2Rank + 1}/${ranked.length}, score ${ranked[c2Rank]?.score}`);
  console.log(`B3(mirror)=${fmt(b3)}: rank ${b3Rank + 1}/${ranked.length}, score ${ranked[b3Rank]?.score}`);
}
