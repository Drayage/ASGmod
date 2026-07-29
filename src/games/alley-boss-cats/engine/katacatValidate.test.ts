// @ts-nocheck -- This opt-in Vitest entrypoint reads artifacts with Node APIs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { KataCatGameRecord, KataCatM0Bundle, KataCatSampleRecord } from "./katacatM0";
import { validateKataCatM0Bundle } from "./katacatM0";

const env = globalThis.process?.env ?? {};
const enabled = env.RUN_KATACAT_VALIDATE === "1";
const suite = enabled ? describe : describe.skip;

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

suite("KataCat M0 dataset validation", () => {
  it(
    "replays every game and verifies labels and split isolation",
    () => {
      const outputDir = resolve(env.KATACAT_OUTPUT_DIR ?? "katacat-m0-output");
      const metadata = JSON.parse(
        readFileSync(resolve(outputDir, "katacat-meta.json"), "utf8"),
      );
      const games = readJsonLines<KataCatGameRecord>(resolve(outputDir, "katacat-games.jsonl"));
      const samples = readJsonLines<KataCatSampleRecord>(resolve(outputDir, "katacat-samples.jsonl"));
      const bundle: KataCatM0Bundle = { metadata, games, samples };
      const acceptance = validateKataCatM0Bundle(bundle);
      const strictCoverage = env.KATACAT_REQUIRE_FULL_COVERAGE === "1";

      console.log(`Validated ${games.length} games and ${samples.length} samples`);
      console.log(`acceptance=${JSON.stringify(acceptance)}`);
      console.log(`KATACAT_M0_VALIDATION:${JSON.stringify({ acceptance, coverage: metadata.coverage })}`);

      expect(acceptance.replayVerified).toBe(true);
      expect(acceptance.exactFinalLabels).toBe(true);
      expect(acceptance.naturalTerminalsOnly).toBe(true);
      expect(acceptance.splitDisjoint).toBe(true);
      if (strictCoverage) expect(acceptance.passed).toBe(true);
    },
    3_600_000,
  );
});
