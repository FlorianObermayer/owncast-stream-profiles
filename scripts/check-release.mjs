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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const ROOT = process.cwd();

// The exact capability set an admin approved. Widening this is a deliberate,
// reviewable act — which is the whole point of the file.
const EXPECTED_PERMISSIONS = [
  "http.serve",
  "storage.kv",
  "network.fetch",
  // Per-profile viewer credentials: the plugin becomes the site's login gate.
  "auth.gate",
  "users.register",
];

const REQUIRED_FILES = [
  "plugin.manifest.json",
  "package.json",
  "package-lock.json",
  "src/plugin.js",
  "src/auth.js",
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
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/actions/verify/action.yml",
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

  // Composite actions carry `uses:` lines too, so they are held to the same
  // rule. A shared action is exactly where an unpinned reference would hide:
  // one file used by two workflows escapes a review that only reads those two.
  const shared = [];
  const actionsDir = join(ROOT, ".github", "actions");
  if (existsSync(actionsDir)) {
    for (const name of readdirSync(actionsDir)) {
      for (const file of ["action.yml", "action.yaml"]) {
        if (existsSync(join(actionsDir, name, file))) {
          shared.push(`.github/actions/${name}/${file}`);
          break;
        }
      }
    }
  }

  const targets = [
    ...files.map((file) => `.github/workflows/${file}`),
    ...shared,
  ];

  for (const relative of targets) {
    const lines = readFileSync(join(ROOT, relative), "utf8").split("\n");

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

// `allowScripts` is only read by npm 11+, and only warns unless strict mode is
// on; the build job must do both for the allowlist to block anything.
function checkInstallScriptPolicy() {
  const relative = ".github/actions/verify/action.yml";
  const absolute = join(ROOT, relative);
  if (!existsSync(absolute)) return; // checkRequiredFiles already reported it

  const text = readFileSync(absolute, "utf8");
  const pkg = readJson("package.json");
  const policy = pkg && pkg.allowScripts;

  if (!policy || typeof policy !== "object" || !Object.keys(policy).length) {
    fail("package.json declares no allowScripts allowlist; install scripts run unreviewed");
    return;
  }

  const badRange = Object.keys(policy).find((key) => /[\^~<>=*]/.test(key));
  if (badRange) {
    fail(
      `package.json allowScripts entry "${badRange}" is a range; ` +
        "pin the exact version so a new install script cannot arrive unreviewed",
    );
  }

  if (!/NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true/.test(text)) {
    fail(
      `${relative} does not set NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true. ` +
        "Without it an unlisted install script only warns, so the allowlist does not block anything.",
    );
  }

  if (!/npm install --global npm@11\./.test(text)) {
    fail(
      `${relative} does not install npm 11, which is the first npm that reads ` +
        "package.json's allowScripts field. Node 22 bundles npm 10, which ignores it.",
    );
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
// Password hashing
//
// src/auth.js hand-writes SHA-256 because the plugin sandbox has no crypto. A
// subtle mistake there would not fail loudly: every credential would simply
// stop matching, locking viewers out of a site the admin thinks is open. These
// are the FIPS 180-4 vectors for the empty string and "abc", plus both message
// padding boundaries.
// ---------------------------------------------------------------------------

const SHA256_VECTORS = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "a".repeat(55),
    "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
  ],
  [
    "a".repeat(56),
    "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
  ],
];

function checkPasswordHashing() {
  const modulePath = join(ROOT, "src", "auth.js");
  if (!existsSync(modulePath)) return; // checkRequiredFiles already reported it

  let auth;
  try {
    auth = createRequire(import.meta.url)(modulePath);
  } catch (error) {
    fail(`src/auth.js cannot be loaded: ${error.message}`);
    return;
  }

  for (const [input, expected] of SHA256_VECTORS) {
    const actual = auth.sha256Hex(input);
    if (actual !== expected) {
      fail(
        `src/auth.js computes the wrong SHA-256 for a ${input.length}-byte input ` +
          `(${actual}); stored passwords would never match.`,
      );
    }
  }

  // A hash must depend on the salt, or every profile would share one digest.
  const password = "correct horse battery staple";
  if (auth.hashPassword(password, "salt-one") === auth.hashPassword(password, "salt-two")) {
    fail("src/auth.js hashes ignore the salt");
  }

  // The round count is part of the stored verifier: a record written at the
  // legacy count must verify and be upgraded, and a stored count is
  // authoritative.
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = {
    id: "legacy",
    user: "alice",
    salt: salt,
    hash: auth.hashPassword(password, salt, auth.LEGACY_ROUNDS),
  };
  const legacyWork = auth.roundsToTry(legacy).map((rounds) => ({ salt: salt, rounds: rounds }));
  if (!auth.findMatchingCredential([{ entry: legacy, admin: false }], password, legacyWork)) {
    fail("a credential written at LEGACY_ROUNDS no longer verifies");
  } else if (legacy.rounds !== auth.ROUNDS || legacy.upgraded !== true) {
    fail("a legacy credential verified but was not upgraded to the current round count");
  }

  const current = {
    id: "current",
    user: "bob",
    salt: salt,
    hash: auth.hashPassword(password, salt),
    rounds: auth.ROUNDS,
  };
  const currentWork = auth.roundsToTry(current).map((rounds) => ({ salt: salt, rounds: rounds }));
  if (!auth.findMatchingCredential([{ entry: current, admin: false }], password, currentWork)) {
    fail("a credential at the current round count does not verify");
  }

  // 0.3.1 wrote records at the current count with no label. Treating an
  // unlabelled record as legacy-only would reject every credential created on
  // 0.3.1, which is the regression this migration exists to prevent.
  const unlabelled = {
    id: "unlabelled",
    user: "carol",
    salt: salt,
    hash: auth.hashPassword(password, salt),
  };
  const unlabelledWork = auth.roundsToTry(unlabelled).map((rounds) => ({
    salt: salt,
    rounds: rounds,
  }));
  if (!auth.findMatchingCredential([{ entry: unlabelled, admin: false }], password, unlabelledWork)) {
    fail("an unlabelled credential at the current round count does not verify");
  }

  // A stored count is authoritative: a legacy digest labelled as current must
  // not be accepted by hashing it at the cheaper count.
  const mislabelled = {
    id: "mislabelled",
    user: "dave",
    salt: salt,
    hash: auth.hashPassword(password, salt, auth.LEGACY_ROUNDS),
    rounds: auth.ROUNDS,
  };
  const mislabelledWork = auth.roundsToTry(mislabelled).map((rounds) => ({
    salt: salt,
    rounds: rounds,
  }));
  if (
    auth.findMatchingCredential([{ entry: mislabelled, admin: false }], password, mislabelledWork)
  ) {
    fail("a credential labelled with the wrong round count was accepted");
  }

  // normalizeCredentials must keep a valid count and drop an absurd one.
  const preserved = auth.normalizeCredentials(
    JSON.stringify([{ id: "r1", user: "x", salt: salt, hash: "h", rounds: auth.ROUNDS }]),
  );
  if (!preserved.length || preserved[0].rounds !== auth.ROUNDS) {
    fail("normalizeCredentials drops a valid round count");
  }
  const absurd = auth.normalizeCredentials(
    JSON.stringify([{ id: "r2", user: "x", salt: salt, hash: "h", rounds: 99999 }]),
  );
  if (absurd.length && absurd[0].rounds !== undefined) {
    fail("normalizeCredentials trusts an out-of-range round count");
  }

  // A URL parser strips C0 controls before resolving a reference, so these all
  // become "//example.com" in a browser. Legitimate paths must still pass.
  ["/\t/example.com", "/\n/example.com", "/\r/example.com", "/\u0000/example.com", "/\u007f/example.com"].forEach(
    (payload) => {
      if (auth.safeReturnTo(payload) !== "/") {
        fail("safeReturnTo accepts a control character that can redirect off-site");
      }
    },
  );
  if (auth.safeReturnTo("/plugins/x?y=z") !== "/plugins/x?y=z") {
    fail("safeReturnTo rejects a legitimate same-origin path");
  }
}

// ---------------------------------------------------------------------------
// Admin asset cache busting
//
// Owncast serves .js and .css with a 30-day max-age
// (utils.GetCacheDurationSecondsForPath), so a browser that has loaded the admin
// page once keeps using that release's script for a month. The `?v=` query is
// what makes an upgrade visible; if it drifts from the manifest version the
// admin page silently shows an old UI, which reads as "the feature is missing".
// ---------------------------------------------------------------------------

function checkAssetCacheBusting(manifestVersion) {
  const relative = "public/admin/index.html";
  const absolute = join(ROOT, relative);
  if (!existsSync(absolute) || !manifestVersion) return;

  const html = readFileSync(absolute, "utf8");
  const pattern = /\.\/(admin\.css|admin\.js)\?v=([^"'&]+)/g;
  const found = [];
  let match;

  while ((match = pattern.exec(html)) !== null) {
    found.push({ file: match[1], version: match[2] });
  }

  for (const file of ["admin.css", "admin.js"]) {
    if (!found.some((entry) => entry.file === file)) {
      fail(
        `${relative} loads ${file} without a ?v= cache-busting query. ` +
          "Owncast caches it for 30 days, so upgrades would not reach admins.",
      );
    }
  }

  for (const entry of found) {
    if (entry.version !== manifestVersion) {
      fail(
        `${relative} loads ${entry.file} as ?v=${entry.version}, but the ` +
          `manifest version is ${manifestVersion}. Run scripts/set-version.mjs.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Host binaries
//
// The downloaded owncast-plugin-test binary runs before the package is sealed,
// so digest pinning is the only thing tying the shipped bytes to a known file.
// ---------------------------------------------------------------------------

// sha256 of node_modules/@owncast/plugin-sdk/bin/.cache/owncast-plugin-test for
// the host-binary tag pinned in .github/actions/verify/action.yml.
const HOST_BINARY_SHA256 =
  "c75c8fdf642c0c402748723d9e7549025b3e2ee2eac146e4523af1b1f668d4f7";

function checkHostBinaries() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    notes.push("host binary digest is pinned for linux-x86_64 only; not checked on this platform");
    return;
  }

  const binary = join(
    ROOT,
    "node_modules",
    "@owncast",
    "plugin-sdk",
    "bin",
    ".cache",
    "owncast-plugin-test",
  );
  // Nothing has been downloaded yet, so nothing is about to run. `npm test`
  // and `npm run package` both refuse to proceed without it.
  if (!existsSync(binary)) return;

  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (actual !== HOST_BINARY_SHA256) {
    fail(
      "the downloaded owncast-plugin-test binary does not match the pinned digest " +
        `(expected ${HOST_BINARY_SHA256}, found ${actual}). ` +
        "It runs before the plugin is packaged, so the build stops here.",
    );
  }
}

// ---------------------------------------------------------------------------
// Sign-in budget
//
// The budget is counted in hash rounds, so it needs to fit the most expensive
// attempt and still stay inside the handler deadline.
// ---------------------------------------------------------------------------

const MAX_QUEUED_ROUNDS = 2400;

function readNumberConstant(source, name) {
  // Only digits, `*` and spaces, so this stays a parse rather than an eval.
  const match = new RegExp(`const ${name} = ([0-9*\\s]+);`).exec(source);
  if (!match) return null;
  return match[1]
    .split("*")
    .reduce((total, part) => total * Number(part.trim() || "1"), 1);
}

function checkSignInBudget() {
  const relative = "src/plugin.js";
  const absolute = join(ROOT, relative);
  if (!existsSync(absolute)) return; // checkRequiredFiles already reported it

  const source = readFileSync(absolute, "utf8");
  const budget = readNumberConstant(source, "ATTEMPT_ROUNDS");
  if (!budget) {
    fail(`${relative}: ATTEMPT_ROUNDS could not be read, so the sign-in budget is unchecked`);
    return;
  }

  let auth;
  try {
    auth = createRequire(import.meta.url)(join(ROOT, "src", "auth.js"));
  } catch (error) {
    return; // checkPasswordHashing already reported the load failure
  }

  const worstAttempt = 2 * (auth.LEGACY_ROUNDS + auth.ROUNDS);
  if (budget < worstAttempt) {
    fail(
      `${relative}: ATTEMPT_ROUNDS is ${budget}, below the ${worstAttempt} rounds an ` +
        "unmigrated profile plus owner login costs to verify. Refusing attempts that " +
        "cannot fit would lock viewers out instead of throttling them.",
    );
  }

  if (budget > MAX_QUEUED_ROUNDS) {
    fail(
      `${relative}: ATTEMPT_ROUNDS is ${budget}, above the ${MAX_QUEUED_ROUNDS} rounds ` +
        "measured as survivable. A queued burst would reach the 5 s handler deadline, " +
        "which closes the plugin runtime instead of slowing it down.",
    );
  }
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  const { version } = checkManifest();
  checkPackageJson(version);
  checkRequiredFiles();
  checkInstructionsLinks();
  checkWorkflowsPinned();
  checkInstallScriptPolicy();
  checkHostBinaries();
  checkPasswordHashing();
  checkSignInBudget();
  checkAssetCacheBusting(version);
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
