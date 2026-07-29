// @ts-nocheck -- This opt-in Vitest entrypoint writes artifacts with Node APIs.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKataCatM0 } from "./katacatM0";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_GENERATE === "1";
const suite = enabled ? describe : describe.skip;

function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function envFloat(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseFloat(env[name] ?? "");
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

suite("KataCat M0 dataset generation", () => {
  it(
    "writes replayable naturally-terminal games and balanced samples",
    () => {
      const outputDir = resolve(env.KATACAT_OUTPUT_DIR ?? "katacat-m0-output");
      const bundle = generateKataCatM0({
        games: envInt("KATACAT_GAMES", 20, 4),
        teacherMs: envInt("KATACAT_TEACHER_MS", 100, 20),
        maxMoves: envInt("KATACAT_MAX_MOVES", 90, 20),
        seed: envInt("KATACAT_SEED", 20260729, 1),
        maxSamplesPerBucket: envInt("KATACAT_MAX_SAMPLES_PER_BUCKET", 16, 1),
        noisyRate: envFloat("KATACAT_NOISY_RATE", 0.25, 0, 1),
        territoryPassPly: envInt("KATACAT_TERRITORY_PASS_PLY", 56, 12),
      });

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        resolve(outputDir, "katacat-games.jsonl"),
        bundle.games.map((game) => JSON.stringify(game)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        resolve(outputDir, "katacat-samples.jsonl"),
        bundle.samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        resolve(outputDir, "katacat-meta.json"),
        JSON.stringify(bundle.metadata, null, 2) + "\n",
        "utf8",
      );

      console.log(`KataCat M0 output: ${outputDir}`);
      console.log(`games=${bundle.games.length} samples=${bundle.samples.length}`);
      console.log(`capture=${bundle.metadata.coverage.resultTypes.CAPTURE} territory=${bundle.metadata.coverage.resultTypes.TERRITORY}`);
      console.log(`acceptance=${JSON.stringify(bundle.metadata.acceptance)}`);
      console.log(`KATACAT_M0_META:${JSON.stringify(bundle.metadata)}`);

      expect(bundle.metadata.acceptance.replayVerified).toBe(true);
      expect(bundle.metadata.acceptance.exactFinalLabels).toBe(true);
      expect(bundle.metadata.acceptance.naturalTerminalsOnly).toBe(true);
      expect(bundle.metadata.acceptance.splitDisjoint).toBe(true);
      expect(bundle.games.length).toBe(bundle.metadata.options.games);
      expect(bundle.samples.length).toBeGreaterThan(0);
    },
    3_600_000,
  );
});
