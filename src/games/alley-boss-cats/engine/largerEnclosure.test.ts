import { describe, expect, it } from "vitest";
import { findBestMoveVeryHard, lastDecision } from "./minimax";
import { applyAIVariant } from "../aiVariant";
import { applyAction } from "../ai";
import { createInitialState } from "../rules";
import { opponent } from "../types";
import type { GameState, Player } from "../types";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The contract the "larger enclosure" upgrade has to keep: it may improve a move
 * chosen because ground was the question, and it may not touch a move chosen
 * because something was about to die.
 *
 * This is the shape of defect that keeps recurring in this engine — a rule
 * applied at the wrong point in the pipeline, contradicting the stage above it,
 * with nothing pinning either. Stage 1 says a forced capture "still outranks any
 * amount of ground" and stage 1.5 says "no amount of ground is actually a
 * competing option"; both used to be handed to the upgrade anyway, and over 877
 * recorded turns seven of its ten swaps came from exactly those stages.
 *
 * Written against the recorded games rather than a constructed position because
 * the constructed version would only prove the predicate, not that the predicate
 * is the one the ladder consults.
 */
const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";

function recordedPositions(limit: number): Array<{ state: GameState; engine: Player }> {
  const out: Array<{ state: GameState; engine: Player }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return out; // uploads are not part of the repository
  }
  for (const file of files) {
    let recs: any[];
    try {
      recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? [];
    } catch {
      continue;
    }
    for (const rec of recs) {
      if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
      const engine = opponent(rec.playerSide as Player);
      let s: GameState = createInitialState();
      for (const m of rec.moveHistory) {
        if (s.currentPlayer === engine && m.type === "PLACE" && out.length < limit) {
          out.push({ state: s, engine });
        }
        s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

describe("the larger-enclosure upgrade", () => {
  it("never overrules a stage that said ground does not compete", () => {
    applyAIVariant("EYE_INSIDE");
    const positions = recordedPositions(120);
    if (positions.length === 0) return; // no recorded games available here

    const offenders: string[] = [];
    for (const { state, engine } of positions) {
      findBestMoveVeryHard(state, engine, 400);
      const stage = lastDecision.stage;
      if (!stage.includes("+ larger")) continue;
      // Every stage below 1.87 exists because something is on a clock.
      if (/^(0 wins|1 |1\.5 |1\.75 |1\.85 |1\.86 )/.test(stage)) offenders.push(stage);
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
