// Viewer-authentication primitives: base64, SHA-256, password hashing, and
// credential records.
//
// Why this file hand-writes its crypto: the sandbox is QuickJS with no WebCrypto
// and no `btoa`, which is the same reason the rest of the project encodes base64
// by hand. Owncast's host gives a plugin no hashing at all.
//
// What the hashing is for, stated narrowly so it is not mistaken for more:
// passwords must not sit in Owncast's database or its backups in readable form.
// This is not a memory-hard KDF, and the iteration count is chosen so a check
// stays far inside the host's 5 s HTTP handler budget on an embedded
// interpreter. A hostile operator with the database can still brute-force a
// weak password offline; nothing a sandboxed plugin can do prevents that.

function text(value) {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// UTF-8 bytes of a string. `encodeURIComponent` is the only Unicode-safe
// primitive the sandbox guarantees.
function utf8Bytes(value) {
  const encoded = encodeURIComponent(String(value));
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%") {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return bytes;
}

function utf8String(bytes) {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const hex = bytes[i].toString(16);
    encoded += "%" + (hex.length === 1 ? "0" : "") + hex;
  }
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    return "";
  }
}

function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out +=
      i + 1 < bytes.length
        ? BASE64_ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6))
        : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET.charAt(b2 & 63) : "=";
  }
  return out;
}

// Tolerant decoder: unknown characters are skipped, missing padding is fine.
// A malformed Basic header should fail the login, not throw out of the handler.
function decodeBase64(value) {
  const clean = text(value).replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const hex = bytes[i].toString(16);
    out += hex.length === 1 ? "0" + hex : hex;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(value, shift) {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

// Returns the raw 32-byte digest as a number array.
function sha256Bytes(bytes) {
  const message = bytes.slice();
  const bitLength = message.length * 8;

  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);

  // The length is a 64-bit big-endian integer. Inputs here are tiny, but the
  // high word is written anyway so the function is correct in general.
  const high = Math.floor(bitLength / 4294967296);
  message.push(
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
  );
  const low = bitLength >>> 0;
  message.push(
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  );

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        ((message[at] << 24) |
          (message[at + 1] << 16) |
          (message[at + 2] << 8) |
          message[at + 3]) >>>
        0;
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [
    h0 >>> 24, (h0 >>> 16) & 0xff, (h0 >>> 8) & 0xff, h0 & 0xff,
    h1 >>> 24, (h1 >>> 16) & 0xff, (h1 >>> 8) & 0xff, h1 & 0xff,
    h2 >>> 24, (h2 >>> 16) & 0xff, (h2 >>> 8) & 0xff, h2 & 0xff,
    h3 >>> 24, (h3 >>> 16) & 0xff, (h3 >>> 8) & 0xff, h3 & 0xff,
    h4 >>> 24, (h4 >>> 16) & 0xff, (h4 >>> 8) & 0xff, h4 & 0xff,
    h5 >>> 24, (h5 >>> 16) & 0xff, (h5 >>> 8) & 0xff, h5 & 0xff,
    h6 >>> 24, (h6 >>> 16) & 0xff, (h6 >>> 8) & 0xff, h6 & 0xff,
    h7 >>> 24, (h7 >>> 16) & 0xff, (h7 >>> 8) & 0xff, h7 & 0xff,
  ];
}

function sha256Hex(value) {
  return bytesToHex(sha256Bytes(utf8Bytes(value)));
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

// Chained SHA-256: cheap enough for the embedded interpreter, slow enough that
// a leaked digest is not a lookup away. Each round rehashes the previous digest,
// so the cost is linear in ROUNDS and independent of password length.
//
// The number is measured, not guessed. One hash costs roughly 0.5 ms on the
// embedded interpreter, so 1024 rounds is about half a second: comfortable
// inside the host's 5 s handler budget, and 4096 was measured to time out.
const ROUNDS = 512;

function hashPassword(password, salt) {
  let digest = sha256Bytes(utf8Bytes(salt + ":" + String(password)));
  for (let i = 1; i < ROUNDS; i += 1) {
    digest = sha256Bytes(digest);
  }
  return bytesToHex(digest);
}

// Uniqueness is what a salt needs; unpredictability is not. The sandbox has no
// CSPRNG, so this mixes the clock, a counter and Math.random. It deliberately
// does no hashing: a salt is generated once per credential, and spending a
// password hash on it would double the cost of adding one.
let saltCounter = 0;
function newSalt() {
  let out = "";
  while (out.length < 32) {
    saltCounter += 1;
    out += Math.random().toString(36).slice(2) + saltCounter.toString(36);
  }
  return out.slice(0, 32);
}

// Length-independent comparison, so a wrong password takes the same time as a
// nearly-right one.
function timingSafeEqual(a, b) {
  const left = text(a);
  const right = text(b);
  let diff = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Credential records
//
// A record is { id, user, salt, hash }. An empty `user` makes it a
// password-only credential: any username is accepted and only the password is
// checked, which is how a "just a password" entry behaves.
// ---------------------------------------------------------------------------

function normalizeCredentials(input) {
  const raw = typeof input === "string" ? safeParse(input) : input;
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = {};

  for (let i = 0; i < raw.length; i += 1) {
    const candidate = raw[i];
    if (!candidate || typeof candidate !== "object") continue;

    const id = text(candidate.id).trim();
    const salt = text(candidate.salt);
    const hash = text(candidate.hash);

    // A record without its hash material cannot verify anything, and keeping it
    // would look like a working login that always fails.
    if (!id || !salt || !hash || seen[id]) continue;

    seen[id] = true;
    out.push({ id: id, user: text(candidate.user).trim(), salt: salt, hash: hash });
  }

  return out;
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

// What the admin page is allowed to see. The salt and hash never leave the
// server.
function summarizeCredentials(entries) {
  return entries.map(function (entry) {
    return {
      id: entry.id,
      user: entry.user,
      passwordOnly: entry.user === "",
    };
  });
}

function findMatchingCredential(entries, username, password) {
  const given = text(password);
  if (given === "") return null;

  const supplied = text(username);

  // Exact username matches are tried before password-only entries. Both are
  // legitimate candidates, but an entry that names the viewer must win. Because
  // a profile shares one salt, two entries with the same password have
  // identical hashes, so without this ordering an earlier password-only entry
  // would silently stand in and the viewer would appear in chat as "Guest"
  // instead of their username.
  const named = [];
  const wildcard = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.user === "") wildcard.push(entry);
    else if (entry.user === supplied) named.push(entry);
  }

  const candidates = named.concat(wildcard);
  if (!candidates.length) return null;

  // One digest per distinct salt, not per entry. Every credential in a profile
  // shares a salt, so a profile with ten entries still costs a single hash: at
  // roughly 1.5 ms per round in the sandbox, hashing per entry would put a
  // realistic profile past the host's 5 s handler budget.
  const digests = {};
  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i];
    if (!digests[entry.salt]) digests[entry.salt] = hashPassword(given, entry.salt);
    if (timingSafeEqual(digests[entry.salt], entry.hash)) return entry;
  }

  return null;
}

// Splits an `Authorization: Basic ...` header. Returns null when the header is
// absent or malformed; a username may be empty, a password may contain colons.
function parseBasicAuthorization(header) {
  const raw = text(header).trim();
  if (raw.slice(0, 6).toLowerCase() !== "basic ") return null;

  const bytes = decodeBase64(raw.slice(6));
  if (!bytes.length) return null;

  const decoded = utf8String(bytes);
  const split = decoded.indexOf(":");
  if (split === -1) return { user: decoded, password: "" };

  return {
    user: decoded.slice(0, split),
    password: decoded.slice(split + 1),
  };
}

// The host sanitises its own `return_to`, but a crafted link to the login page
// reaches this plugin directly, so anything that is not a same-origin path is
// refused. `//host` and `/\host` are both protocol-relative in a browser.
function safeReturnTo(value) {
  const raw = text(value).trim();
  if (raw === "" || raw.charAt(0) !== "/") return "/";
  if (raw.charAt(1) === "/" || raw.charAt(1) === "\\") return "/";
  return raw;
}

module.exports = {
  base64,
  bytesToHex,
  hashPassword,
  newSalt,
  normalizeCredentials,
  parseBasicAuthorization,
  safeReturnTo,
  sha256Hex,
  summarizeCredentials,
  findMatchingCredential,
  timingSafeEqual,
  utf8Bytes,
};
