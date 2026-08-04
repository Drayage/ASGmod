#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const path = "scripts/generate-ownership-dataset.ts";
let source = readFileSync(path, "utf8");

const brokenComparator =
  '.sort((a, b) => b.score - a.score || a.action.type === "PASS" ? 1 : 0);';
const fixedComparator = `.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const aIndex = a.action.type === "PASS" ? 81 : a.action.row * 9 + a.action.col;
      const bIndex = b.action.type === "PASS" ? 81 : b.action.row * 9 + b.action.col;
      return aIndex - bIndex;
    });`;
const uselessGuard = '  if (state.winner?.length === 0) throw new Error("unreachable");\n';

if (source.includes(brokenComparator)) source = source.replace(brokenComparator, fixedComparator);
if (source.includes(uselessGuard)) source = source.replace(uselessGuard, "");

if (source.includes(brokenComparator) || source.includes(uselessGuard)) {
  throw new Error("Phase 1 generator normalization did not converge");
}
if (!source.includes("const scoreDelta = b.score - a.score;")) {
  throw new Error("Deterministic quiet-alternative comparator is missing");
}

writeFileSync(path, source);
console.log(`normalized ${path}`);
