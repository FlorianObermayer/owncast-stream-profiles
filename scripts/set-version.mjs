#!/usr/bin/env node
// Set the plugin version everywhere it is recorded, in one step.
//
//   node scripts/set-version.mjs patch      # 0.0.1 -> 0.0.2
//   node scripts/set-version.mjs minor
//   node scripts/set-version.mjs major
//   node scripts/set-version.mjs 0.1.0      # explicit
//
// `npm version` alone is not enough: it rewrites package.json and
// package-lock.json but knows nothing about plugin.manifest.json, which is the
// version the Owncast host shows in its plugin list, the one the catalog uses to
// tell releases apart, and the one the release tag must match. Bumping only part
// of the set is how a release ends up shipping under the wrong label.
//
// Dependency-free on purpose, like check-release.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const BUMPABLE = ["patch", "minor", "major"];

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
}

// Only rewrites the version-bearing line(s) rather than re-serialising the
// whole file, so formatting and key order survive untouched.
function replaceVersion(file, pattern, replacement) {
  const text = readFileSync(join(ROOT, file), "utf8");

  if (!pattern.test(text)) {
    throw new Error(`${file}: could not find the version field to update`);
  }

  writeFileSync(join(ROOT, file), text.replace(pattern, replacement));
}

function bump(current, argument) {
  if (SEMVER.test(argument)) return argument;

  if (!BUMPABLE.includes(argument)) {
    throw new Error(
      `expected one of ${BUMPABLE.join(", ")} or an explicit x.y.z version, got "${argument}"`,
    );
  }

  const [, major, minor, patch] = SEMVER.exec(current);

  if (argument === "major") return `${Number(major) + 1}.0.0`;
  if (argument === "minor") return `${major}.${Number(minor) + 1}.0`;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function main() {
  const argument = (process.argv[2] || "").trim();

  if (!argument) {
    const current = readJson("package.json").version;
    console.error("usage: node scripts/set-version.mjs <patch|minor|major|x.y.z>");
    console.error(`current version: ${current}`);
    process.exit(2);
  }

  const manifest = readJson("plugin.manifest.json");
  const pkg = readJson("package.json");

  // package.json is authoritative for the current version; check-release.mjs
  // keeps the three in sync, so a mismatch here is already a bug.
  if (manifest.version !== pkg.version) {
    console.error(
      `refusing to bump: package.json is ${pkg.version} but plugin.manifest.json is ${manifest.version}. ` +
        "Align them first so the bump starts from a known state.",
    );
    process.exit(1);
  }

  const next = bump(pkg.version, argument);

  // 1. package.json
  replaceVersion(
    "package.json",
    /"version":\s*"[^"]*"/,
    `"version": "${next}"`,
  );

  // 2. package-lock.json — both the root `version` and `packages[""].version`,
  //    since that is what `npm ci` compares against package.json. The lockfile is
  //    generated, and npm itself writes it with this shape, so re-serialising it
  //    is safe and keeps the two fields from drifting apart.
  const lock = readJson("package-lock.json");

  if (typeof lock.version !== "string" || !lock.packages || !lock.packages[""]) {
    throw new Error("package-lock.json is not in the expected npm v2/v3 shape");
  }

  lock.version = next;
  lock.packages[""].version = next;
  writeFileSync(
    join(ROOT, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );

  // 3. plugin.manifest.json — the version the host and the catalog read.
  replaceVersion(
    "plugin.manifest.json",
    /"version":\s*"[^"]*"/,
    `"version": "${next}"`,
  );

  console.log(`version ${pkg.version} -> ${next}`);
  console.log("updated: package.json, package-lock.json, plugin.manifest.json");
  // main is protected, so the bump lands by pull request and the tag is pushed
  // afterwards, on the merge commit. Tagging first would pin an unmerged commit.
  console.log(`\nnext: commit and open a pull request`);
  console.log(`then, on main after the merge: git tag v${next} && git push origin v${next}`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
