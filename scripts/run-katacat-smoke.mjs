import { spawnSync } from "node:child_process";

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

const forwarded = process.argv.slice(2);
const hasOutput = forwarded.some((argument) => argument.startsWith("--output"));
const output = hasOutput ? [] : ["--output=katacat-m0-output"];
const hasGames = forwarded.some((argument) => argument.startsWith("--games="));
const games = hasGames ? [] : ["--games=20"];

run("scripts/run-katacat-generate.mjs", [...output, ...games, ...forwarded]);
run("scripts/run-katacat-validate.mjs", [...output, "--strict=true"]);
