#!/usr/bin/env node
// Release guard. Fails when the repository would ship something the manifest did
// not ask for, so a compromised or careless change cannot quietly widen what an
// admin approves.
//
//   node scripts/check-release.mjs
//   node scripts/check-release.mjs --tag v0.8.0
//   node scripts/check-release.mjs --package stream-profiles.ocpkg
//
// Deliberately dependency-free: no jszip, no yaml, no glob. A security check
// that pulls in its own dependency tree is not a check you can trust, and CI
// runs this before it trusts anything else.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const ROOT = process.cwd();

// The exact capability set an admin approved. Widening this is a deliberate,
// reviewable act — which is the whole point of the file.
const EXPECTED_PERMISSIONS = ["http.serve", "storage.kv", "network.fetch"];

const REQUIRED_FILES = [
  "plugin.manifest.json",
  "package.json",
  "package-lock.json",
  "src/plugin.js",
  "public/admin/index.html",
  "public/admin/admin.js",
  "public/admin/admin.css",
  "icon.png",
  "INSTRUCTIONS.md",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "scripts/check-release.mjs",
  "scripts/set-version.mjs",
  ".github/images/admin-overview.png",
  ".github/images/admin-fields.png",
  ".github/images/admin-password.png",
];

// What a .ocpkg is allowed to contain. The host runs plugin.js in its sandbox;
// anything else in here would be shipped to servers unseen.
const ALLOWED_PACKAGE_ENTRIES = [
  "plugin.manifest.json",
  "plugin.js",
  "icon.png",
  "INSTRUCTIONS.md",
];
const ALLOWED_PACKAGE_PREFIXES = ["public/", "assets/"];

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function readJson(relativePath) {
  const absolute = join(ROOT, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function parseArgs(argv) {
  const args = { tag: "", packagePath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tag") args.tag = argv[i + 1] || "";
    else if (argv[i] === "--package") args.packagePath = argv[i + 1] || "";
  }
  return args;
}

// ---------------------------------------------------------------------------
// Manifest and package metadata
// ---------------------------------------------------------------------------

function checkManifest() {
  const manifest = readJson("plugin.manifest.json");
  if (!manifest) return { manifest: null, version: "" };

  if (manifest.api !== "1") {
    fail(`plugin.manifest.json: api must be "1", found ${JSON.stringify(manifest.api)}`);
  }

  if (typeof manifest.slug !== "string" || !SLUG_PATTERN.test(manifest.slug)) {
    fail("plugin.manifest.json: slug must be lowercase letters, digits and hyphens, starting with a letter");
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail("plugin.manifest.json: name is required");
  }

  if (typeof manifest.description !== "string" || !manifest.description.trim()) {
    fail("plugin.manifest.json: description is required; admins read it before installing");
  }

  const version = manifest.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    fail(`plugin.manifest.json: version must be semver, found ${JSON.stringify(version)}`);
  }

  // Permission set equality, order-insensitive. Report the direction so the
  // message says what an admin would be asked to approve.
  const declared = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const unexpected = declared.filter((p) => !EXPECTED_PERMISSIONS.includes(p));
  const missing = EXPECTED_PERMISSIONS.filter((p) => !declared.includes(p));

  if (unexpected.length) {
    fail(
      `plugin.manifest.json requests permissions this repository does not ship: ${unexpected.join(", ")}. ` +
        "If that is intentional, update EXPECTED_PERMISSIONS in scripts/check-release.mjs in the same commit.",
    );
  }
  if (missing.length) {
    fail(`plugin.manifest.json no longer declares: ${missing.join(", ")}. Update EXPECTED_PERMISSIONS to match.`);
  }

  if (declared.includes("network.fetch")) {
    const hosts = manifest.network && manifest.network.allowedHosts;
    if (!Array.isArray(hosts) || !hosts.length) {
      fail("plugin.manifest.json: network.fetch requires network.allowedHosts");
    }
  }

  // Config keys are admin-visible; a credential one would be stored in the
  // host's database, which this plugin deliberately avoids.
  const config = manifest.config || {};
  for (const key of Object.keys(config)) {
    if (/secret|password|token|apikey|api_key/i.test(key)) {
      notes.push(`manifest config key "${key}" looks like a credential and is stored in Owncast's database`);
    }
  }

  return { manifest, version };
}

function checkPackageJson(manifestVersion) {
  const pkg = readJson("package.json");
  if (!pkg) return;

  if (pkg.private !== true) {
    fail("package.json: set private: true so this plugin can never be published to npm by accident");
  }

  if (pkg.version !== manifestVersion) {
    fail(`version mismatch: package.json is ${pkg.version}, plugin.manifest.json is ${manifestVersion}`);
  }

  if (pkg.license !== "MIT") {
    notes.push(`package.json license is ${JSON.stringify(pkg.license)}; LICENSE is MIT`);
  }
}

// INSTRUCTIONS.md ships inside the .ocpkg and is rendered in the Owncast admin by
// ReactMarkdown with no link rewriting, inside the admin page itself (only the
// plugin's own pages are iframes). Two consequences, both enforced here:
//
//   * a relative link resolves against the admin URL and 404s, so links must be
//     absolute;
//   * following an absolute link navigates the admin away, so the file has to
//     stand on its own rather than defer to docs/.
function checkInstructionsLinks() {
  const absolutePath = join(ROOT, "INSTRUCTIONS.md");
  if (!existsSync(absolutePath)) return;

  const markdown = readFileSync(absolutePath, "utf8");

  // Markdown links and autolinks, e.g. [x](https://...) and <https://...>.
  const targets = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) targets.push(match[1]);
  for (const match of markdown.matchAll(/<(https?:\/\/[^>\s]+)>/g)) targets.push(match[1]);

  for (const target of targets) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    if (target.startsWith("#")) continue;
    fail(
      `INSTRUCTIONS.md links to ${target}, which is relative. ` +
        "It is rendered inside the Owncast admin, so use an absolute URL.",
    );
  }

  const pkg = readJson("package.json");
  const repository = pkg && pkg.repository;
  const rawUrl =
    typeof repository === "string" ? repository : repository && repository.url;

  if (!rawUrl) {
    fail("package.json: repository.url is required so the packaged docs can link home");
    return;
  }

  const homepage = String(rawUrl)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");

  if (!markdown.includes(homepage)) {
    fail(
      `INSTRUCTIONS.md does not link to ${homepage}. ` +
        "It ships to servers, so a stale repository link is a silent dead end.",
    );
  }
}

function checkRequiredFiles() {
  for (const file of REQUIRED_FILES) {
    const absolute = join(ROOT, file);    if (!existsSync(absolute)) {
      fail(`${file} is missing`);
      continue;
    }
    if (statSync(absolute).size === 0) {
      fail(`${file} is empty`);
    }
  }
}

function checkTag(tag, manifestVersion) {
  if (!tag) return;

  const expected = `v${manifestVersion}`;
  if (tag !== expected) {
    fail(`tag ${tag} does not match the manifest version (expected ${expected})`);
  }
}

// ---------------------------------------------------------------------------
// Workflow hardening
//
// A `uses: owner/repo@v1` reference resolves to whatever that repository's tag
// points at today, so a compromise there runs in our CI. Pinning to a commit
// SHA is the only reference that cannot move, which is why it is enforced rather
// than left to review.
// ---------------------------------------------------------------------------

const SHA_PATTERN = /@[0-9a-f]{40}$/;

function checkWorkflowsPinned() {
  const dir = join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) {
    fail(".github/workflows is missing");
    return;
  }

  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  if (!files.length) {
    fail(".github/workflows contains no workflow files");
    return;
  }

  for (const file of files) {
    const relative = `.github/workflows/${file}`;
    const lines = readFileSync(join(dir, file), "utf8").split("\n");

    lines.forEach((line, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/.exec(line);
      if (!match) return;

      const reference = match[1];
      // Local composite actions and docker:// references are out of scope.
      if (reference.startsWith("./") || reference.startsWith("docker://")) return;

      if (!SHA_PATTERN.test(reference)) {
        fail(
          `${relative}:${index + 1} references ${reference} without a commit SHA. ` +
            "Pin it to the 40-character SHA of the release commit.",
        );
      } else if (!/#\s*v?\d+\.\d+\.\d+/.test(line)) {
        notes.push(`${relative}:${index + 1} is pinned but has no version comment`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Built package
// ---------------------------------------------------------------------------

// Minimal central-directory reader. Enough to list entry names, which is all
// this check needs.
function zipEntryNames(buffer) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;

  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error("corrupt central directory");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function checkPackage(packagePath, manifestVersion) {
  const absolute = join(ROOT, packagePath);
  if (!existsSync(absolute)) {
    fail(`${packagePath} is missing; run npm run package first`);
    return;
  }

  let names;
  try {
    names = zipEntryNames(readFileSync(absolute));
  } catch (error) {
    fail(`${packagePath} is not a readable zip: ${error.message}`);
    return;
  }

  const files = names.filter((name) => !name.endsWith("/"));

  for (const required of ["plugin.manifest.json", "plugin.js"]) {
    if (!files.includes(required)) {
      fail(`${packagePath} does not contain ${required}`);
    }
  }

  for (const name of files) {
    if (ALLOWED_PACKAGE_ENTRIES.includes(name)) continue;
    if (ALLOWED_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    fail(`${packagePath} contains unexpected entry: ${name}`);
  }

  // Guard the one invariant that matters most to an operator: this plugin does
  // not persist the admin password. A bundle that mentions it needs a review.
  const bundle = readFileSync(absolute);
  if (bundle.includes(Buffer.from("adminPassword"))) {
    fail(`${packagePath} references adminPassword; the plugin must not store credentials`);
  }

  // The manifest inside the package is what the host reads, so it must be the
  // same version the tag claims.
  let innerManifest = null;
  try {
    innerManifest = JSON.parse(readNestedJson(packagePath, "plugin.manifest.json"));
  } catch (error) {
    fail(`could not read the manifest inside ${packagePath}: ${error.message}`);
  }
  if (innerManifest && innerManifest.version !== manifestVersion) {
    fail(
      `the manifest inside ${packagePath} is version ${innerManifest.version}, ` +
        `but the repository is at ${manifestVersion}; rebuild before releasing`,
    );
  }

  notes.push(`${packagePath} contains ${files.length} file(s), ${(bundle.length / 1024).toFixed(0)} KB`);
}

// Reads one stored (uncompressed or deflated) entry out of a zip. Small files
// only, which is all a manifest is.
function readNestedJson(packagePath, wanted) {
  const buffer = readFileSync(join(ROOT, packagePath));

  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;

  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error("corrupt central directory");

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error("corrupt local header");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);

      const data = method === 0 ? raw : inflateRawSync(raw);
      return data.toString("utf8");
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`${wanted} not found in the archive`);
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  const { version } = checkManifest();
  checkPackageJson(version);
  checkRequiredFiles();
  checkInstructionsLinks();
  checkWorkflowsPinned();
  checkTag(args.tag, version);

  if (args.packagePath && version) {
    checkPackage(args.packagePath, version);
  }

  for (const note of notes) {
    console.log(`note: ${note}`);
  }

  if (problems.length) {
    for (const problem of problems) {
      console.error(`error: ${problem}`);
    }
    console.error(`\n${problems.length} problem(s) found.`);
    process.exit(1);
  }

  console.log(`ok: stream-profiles ${version} passes the release checks`);
}

main();
