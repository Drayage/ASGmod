/**
 * Measures the factors the user asked for -- NOT a coordinate bonus -- before
 * any engine change is considered for the C2 corner joseki. For each of the
 * four corners, Black's opening move is fixed at C2 and the position is
 * examined along every axis that was named:
 *
 *   1. 강제 응수 여부 (is White forced to answer locally at all)
 *   2. 상대의 안전한 응수 개수 (how many of White's legal replies are safe)
 *   3. 응수하지 않았을 때 강제 포획까지 거리 (plies to a provable forced
 *      capture if White tenukis instead)
 *   4. 수순 종료 후 선수 유지 여부 (who tenukis first once the corner settles)
 *   5. 상대에게 허용한 확정 영역 (territory each side actually banks)
 *   6. 내 외곽 돌의 중앙 연결 가능성 (does Black's corner group ever reach
 *      toward the centre)
 *   7. 다음 큰 영역 완성까지 필요한 착수 수 (moves to Black's next framework)
 *   8. 압박 방향(B1 vs B3)이 어느 인접 귀퉁이와 더 잘 연결되는지
 *
 * Everything here is measurement only: findBestMoveVeryHard, evaluateState,
 * findForcedCapture and rankFrameworks are called exactly as shipped, nothing
 * is patched or biased. No conclusion here is wired into the engine.
 */
import { CORNERS } from "./corner-policy.mts";
import { createInitialState, applyMove, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { rankFrameworks } from "./src/games/alley-boss-cats/engine/frameworks";
import { getAllGroups, getConnectedGroup } from "./src/games/alley-boss-cats/groups";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState } from "./src/games/alley-boss-cats/types";

const SIM_BUDGET_MS = 600;
const FORCE_READ_DEPTH = 7;
const FORCE_READ_MS = 300;
/** How many plies (both sides) to play out past C2 before reading the
 * "settled corner" snapshot for factors 4-7. */
const CONTINUATION_PLIES = 10;
/** Chebyshev distance from the corner within which a move counts as "local"
 * rather than a tenuki. */
const LOCAL_RADIUS = 4;

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

function isLocal(frame: (typeof CORNERS)[number], cell: Coord): boolean {
  const di = Math.abs(cell.row - frame.corner.row);
  const dj = Math.abs(cell.col - frame.corner.col);
  return Math.max(di, dj) <= LOCAL_RADIUS;
}

for (const frame of CORNERS) {
  console.log("=".repeat(78));
  console.log(`Corner ${frame.name} -- Black opens C2=${fmt(go(frame, "C", 2))}`);
  console.log("=".repeat(78));

  let state = createInitialState();
  state = place(state, go(frame, "C", 2)); // Black's move 1

  // ---- Factors 1+2: is White forced to answer, and how many safe replies ----
  const legalWhite = getLegalMoves(state, "B");
  let safeLocal = 0;
  let safeFar = 0;
  let losingLocal = 0;
  let losingFar = 0;
  for (const move of legalWhite) {
    const next = applyMove(state, move.row, move.col);
    const local = isLocal(frame, move);
    if (next.winner) {
      // A reply that wins outright for White is obviously safe; one that
      // hands Black an immediate win is obviously losing -- both decisive,
      // so neither needs the forced-capture reader below.
      if (next.winner === "B") {
        if (local) safeLocal++;
        else safeFar++;
      } else {
        if (local) losingLocal++;
        else losingFar++;
      }
      continue;
    }
    const forced = findForcedCapture({ ...next, currentPlayer: "A" }, "A", FORCE_READ_DEPTH, FORCE_READ_MS);
    if (forced) {
      if (local) losingLocal++;
      else losingFar++;
    } else {
      if (local) safeLocal++;
      else safeFar++;
    }
  }
  console.log(`[1/2] White's legal replies to C2: ${legalWhite.length}`);
  console.log(
    `      local (within ${LOCAL_RADIUS}): safe=${safeLocal} losing=${losingLocal}   ` +
      `far/tenuki: safe=${safeFar} losing=${losingFar}`,
  );
  console.log(
    `      => ${safeFar === 0 && losingFar > 0 ? "White IS forced to answer locally (every far reply loses)" : safeFar > 0 ? "White is NOT forced -- at least one far reply is safe" : "no far replies existed to classify"}`,
  );

  // ---- Factor 3: if White tenukis, how many plies to a provable forced capture ----
  const farAway = go(CORNERS[(CORNERS.indexOf(frame) + 2) % 4], "C", 2);
  if (getLegalMoves(state, "B").some((m) => m.row === farAway.row && m.col === farAway.col)) {
    const afterTenuki = applyMove(state, farAway.row, farAway.col);
    let minDepth: number | null = null;
    for (let d = 1; d <= FORCE_READ_DEPTH; d++) {
      const forced = findForcedCapture({ ...afterTenuki, currentPlayer: "A" }, "A", d, FORCE_READ_MS);
      if (forced) {
        minDepth = d;
        break;
      }
    }
    console.log(
      `[3] If White tenukis to ${fmt(farAway)} right after C2: ` +
        `${minDepth ? `forced capture provable at depth ${minDepth}` : `no forced capture provable within ${FORCE_READ_DEPTH} plies`}`,
    );
  }

  // ---- Factors 4-7: simulate a realistic continuation with the real engine ----
  let sim = state;
  let firstTenukiA: number | null = null;
  let firstTenukiB: number | null = null;
  for (let ply = 0; ply < CONTINUATION_PLIES && !sim.winner; ply++) {
    const mover = sim.currentPlayer;
    const action = findBestMoveVeryHard(sim, mover, SIM_BUDGET_MS);
    if (action.type !== "PLACE") break;
    const local = isLocal(frame, action);
    if (!local) {
      if (mover === "A" && firstTenukiA === null) firstTenukiA = ply;
      if (mover === "B" && firstTenukiB === null) firstTenukiB = ply;
    }
    sim = applyMove(sim, action.row, action.col);
  }

  console.log(`\n[4] Sente check over ${CONTINUATION_PLIES}-ply simulated continuation:`);
  console.log(
    `    Black's first tenuki at ply ${firstTenukiA ?? "never (stayed local the whole window)"}; ` +
      `White's first tenuki at ply ${firstTenukiB ?? "never"}`,
  );
  if (firstTenukiA !== null && firstTenukiB !== null) {
    console.log(
      `    => ${firstTenukiA < firstTenukiB ? "Black left the corner first -- consistent with Black keeping sente" : firstTenukiB < firstTenukiA ? "White left first -- Black did NOT keep sente here" : "tied"}`,
    );
  }

  console.log(`\n[5] Confirmed territory after the simulated continuation (if not already decided):`);
  if (sim.winner) {
    console.log(`    Game already decided: winner=${sim.winner} reason=${sim.winReason}`);
  } else {
    console.log(`    Black(A)=${sim.territories.A.length}  White(B)=${sim.territories.B.length}`);
  }

  console.log(`\n[6] Does Black's C2 stone's group reach toward the centre?`);
  if (!sim.winner) {
    const c2 = go(frame, "C", 2);
    if (sim.board[c2.row][c2.col] === "PLAYER_A") {
      const group = getConnectedGroup(sim.board, c2.row, c2.col);
      const maxReach = Math.max(
        ...group.map((c) => Math.max(Math.abs(c.row - frame.corner.row), Math.abs(c.col - frame.corner.col))),
      );
      console.log(
        `    C2's group has ${group.length} stone(s); furthest one is ${maxReach} cells from the corner ` +
          `(board half-width is ${Math.floor(BOARD_SIZE / 2)}) => ${maxReach >= Math.floor(BOARD_SIZE / 2) ? "reaches past the centre line" : "still confined to the corner side"}`,
      );
    } else {
      console.log(`    C2 stone itself is gone (captured or otherwise) -- can't measure its group.`);
    }
  } else {
    console.log(`    Skipped -- game already decided.`);
  }

  console.log(`\n[7] Moves needed to secure Black's NEXT framework (a different corner):`);
  if (!sim.winner) {
    const verdicts = rankFrameworks(sim, "A", 400).filter(
      (v) => v.frame.corner.row !== frame.corner.row || v.frame.corner.col !== frame.corner.col,
    );
    const bestNext = verdicts.find((v) => v.secure) ?? verdicts[0];
    console.log(
      bestNext
        ? `    Best other frame: corner=${JSON.stringify(bestNext.frame.corner)} secure=${bestNext.secure} movesToClose=${bestNext.movesToClose}`
        : `    No other frame candidate found yet.`,
    );
  } else {
    console.log(`    Skipped -- game already decided.`);
  }
}

// ---- Factor 8: which pressing direction (B1 vs B3) sits closer to the two
// adjacent corners, as a proxy for "connects better with an adjacent corner"?
console.log("\n" + "=".repeat(78));
console.log("[8] B1 vs B3 pressing direction -- proximity to the two ADJACENT corners");
console.log("=".repeat(78));
for (const frame of CORNERS) {
  const idx = CORNERS.indexOf(frame);
  const adjacent = CORNERS.filter((_, i) => i !== idx && i !== (idx + 2) % 4); // exclude self and diagonal opposite
  const b1 = go(frame, "B", 1);
  const b3 = go(frame, "B", 3);
  const distTo = (p: Coord, corner: Coord) => Math.max(Math.abs(p.row - corner.row), Math.abs(p.col - corner.col));
  const b1Dists = adjacent.map((a) => distTo(b1, a.corner));
  const b3Dists = adjacent.map((a) => distTo(b3, a.corner));
  const b1Min = Math.min(...b1Dists);
  const b3Min = Math.min(...b3Dists);
  console.log(
    `${frame.name}: B1=${fmt(b1)} closest adjacent-corner distance=${b1Min}   ` +
      `B3=${fmt(b3)} closest adjacent-corner distance=${b3Min}   ` +
      `=> ${b1Min < b3Min ? "B1 sits closer to an adjacent corner" : b3Min < b1Min ? "B3 sits closer to an adjacent corner" : "tied"}`,
  );
}
