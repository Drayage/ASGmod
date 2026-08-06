import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CELL_COUNT, OwnershipNet, hybridMargin, type OwnershipNetFile } from "./ownershipNet";
import { applyMove, createInitialState, getLegalMoves } from "../rules";
import { calculateTerritories } from "../territory";
import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";

const NET_PATH = "public/ownership-net.json";
const available = existsSync(NET_PATH);

function loadNet(): OwnershipNet {
  return new OwnershipNet(JSON.parse(readFileSync(NET_PATH, "utf8")) as OwnershipNetFile);
}

function position(seed: number, plies: number): GameState {
  let value = seed >>> 0;
  const random = () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
  let state = createInitialState();
  for (let ply = 0; ply < plies && !state.winner; ply += 1) {
    const legal = getLegalMoves(state, state.currentPlayer);
    if (legal.length === 0) break;
    const { row, col } = legal[Math.floor(random() * legal.length)];
    state = applyMove(state, row, col);
  }
  return state;
}

// The exported net is a build artefact rather than source, so the suite has to
// stay green without it. Skipping is right; asserting it exists would make a
// clean checkout fail for a file nobody committed.
describe.skipIf(!available)("ownership net inference", () => {
  it("matches the PyTorch outputs it was exported with", () => {
    // The whole reason this port can be trusted. A transposed weight, a
    // wrong padding offset or a mixed-up channel order all still run and all
    // still return plausible-looking numbers; only the recorded outputs say
    // whether the two are computing the same function.
    const result = loadNet().verifyAgainstReferences();
    expect(result.cases).toBeGreaterThan(0);
    expect(result.maxOwnLogitError).toBeLessThan(1e-4);
    expect(result.maxMarginError).toBeLessThan(1e-3);
  });

  it("returns a probability distribution over every point", () => {
    const net = loadNet();
    const state = position(11, 24);
    const prediction = net.predict(OwnershipNet.encodeState(state));
    expect(prediction.probabilityA).toHaveLength(CELL_COUNT);
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const a = prediction.probabilityA[cell];
      const b = prediction.probabilityB[cell];
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(a + b).toBeLessThanOrEqual(1.0001);
    }
    expect(Number.isFinite(prediction.margin)).toBe(true);
  });

  it("reads a mirrored board as the mirror of its own answer", () => {
    // Not a symmetry the net was trained to have, but a left-right flip of the
    // board with the same side to move is the same position relabelled, so a
    // wildly different answer would mean the spatial indexing is wrong.
    const net = loadNet();
    const state = position(5, 18);
    const flipped = state.board.map((row) => [...row].reverse());
    const direct = net.predict(OwnershipNet.encode(state.board, state.currentPlayer));
    const mirrored = net.predict(OwnershipNet.encode(flipped, state.currentPlayer));

    let totalGap = 0;
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const here = row * BOARD_SIZE + col;
        const there = row * BOARD_SIZE + (BOARD_SIZE - 1 - col);
        totalGap += Math.abs(direct.probabilityA[here] - mirrored.probabilityA[there]);
      }
    }
    expect(totalGap / CELL_COUNT).toBeLessThan(0.15);
  });

  it("counts settled ground exactly and only asks the net about open points", () => {
    const net = loadNet();
    const state = position(23, 40);
    const prediction = net.predict(OwnershipNet.encodeState(state));
    const territories = calculateTerritories(state.board);
    const settled = territories.A.length - territories.B.length;

    const margin = hybridMargin(state, prediction);
    // Whatever the net says, it can only move the total by the number of open
    // points — the settled part is arithmetic and must survive untouched.
    const openPoints = state.board.flat().filter((cell) => cell === "EMPTY").length;
    expect(Math.abs(margin - settled)).toBeLessThanOrEqual(openPoints);
  });

  it("costs little enough to run once per move", () => {
    // The budget argument for the whole design: one inference at the root is
    // affordable against a 3000ms move, where one per leaf would collapse the
    // search depth that makes the engine strong.
    const net = loadNet();
    const state = position(31, 22);
    const input = OwnershipNet.encodeState(state);
    net.predict(input);

    const started = Date.now();
    const runs = 20;
    for (let run = 0; run < runs; run += 1) net.predict(input);
    const perCall = (Date.now() - started) / runs;
    expect(perCall).toBeLessThan(150);
  });
});
