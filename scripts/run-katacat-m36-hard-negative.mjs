import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testFile = resolve(
  "src/games/alley-boss-cats/engine/katacatM341HardNegative.test.ts",
);
const original = readFileSync(testFile, "utf8");
const marker = "  }, 3_600_000);\n});";
if (!original.includes(marker)) {
  throw new Error("M3.6 could not locate the M3.4.1 collector timeout marker");
}
const extended = original.replace(marker, "  }, 14_400_000);\n});");
writeFileSync(testFile, extended);
try {
  const executable = process.platform === "win32"
    ? resolve("node_modules/.bin/vitest.cmd")
    : resolve("node_modules/.bin/vitest");
  const result = spawnSync(
    executable,
    ["run", "src/games/alley-boss-cats/engine/katacatM341HardNegative.test.ts"],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  writeFileSync(testFile, original);
}
