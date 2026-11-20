#!/usr/bin/env node
// Code scanning rejects the whole SARIF file when a single result has no
// physicalLocation, and every coverage result Strix emits (kind pass,
// notApplicable or open) carries only logicalLocations. Write a copy that keeps
// the results GitHub can display; the full report stays in the run artifact.
//
//   node scripts/sarif-for-code-scanning.mjs strix_runs "$RUNNER_TEMP/code-scanning"

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: sarif-for-code-scanning.mjs <input-dir> <output-dir>");
  process.exit(1);
}

function sarifFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sarifFiles(path);
    return entry.name.endsWith(".sarif") ? [path] : [];
  });
}

let kept = 0;
let total = 0;
const outputFiles = sarifFiles(from).map((file) => {
  const log = JSON.parse(readFileSync(file, "utf8"));
  for (const run of log.runs ?? []) {
    const results = run.results ?? [];
    total += results.length;
    run.results = results.filter((result) =>
      (result.locations ?? []).some((location) => location?.physicalLocation),
    );
    kept += run.results.length;
  }
  return {
    path: join(to, relative(from, file)),
    content: JSON.stringify(log),
  };
});

for (const outputFile of outputFiles) {
  mkdirSync(dirname(outputFile.path), { recursive: true });
  writeFileSync(outputFile.path, outputFile.content);
}

console.log(`kept ${kept} of ${total} results (${total - kept} have no physical location)`);
