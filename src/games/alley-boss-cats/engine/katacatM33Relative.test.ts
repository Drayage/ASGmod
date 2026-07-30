// @ts-nocheck -- Invokes the Python feature encoder used by training and inference.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("KataCat M3.3 player-relative encoding", () => {
  it("preserves relative state while recalculating A's fixed margin", () => {
    const python = process.env.PYTHON ?? "python";
    const result = spawnSync(python, ["ml/katacat_m33_relative.py", "--self-test"], {
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary).toMatchObject({
      relativeInvariantPlanes: true,
      relativeOwnershipInvariant: true,
      relativeValueInvariant: true,
      scoreMarginRecalculated: true,
      seatPlanesSwapped: true,
      signedMarginFlipped: true,
      passed: true,
    });
  });
});
