import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, ...rest] = argument.slice(2).split("=");
    values[key] = rest.join("=");
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const env = {
  ...process.env,
  RUN_KATACAT_VALIDATE: "1",
  KATACAT_OUTPUT_DIR: args.output ?? args["output-dir"] ?? "katacat-m0-output",
  KATACAT_REQUIRE_FULL_COVERAGE:
    args.strict === "1" || args.strict === "true" ? "1" : "0",
};

console.log(
  `Validating KataCat M0: output=${env.KATACAT_OUTPUT_DIR}, strict=${env.KATACAT_REQUIRE_FULL_COVERAGE}`,
);

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  [
    "vitest",
    "run",
    "src/games/alley-boss-cats/engine/katacatValidate.test.ts",
  ],
  { env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
