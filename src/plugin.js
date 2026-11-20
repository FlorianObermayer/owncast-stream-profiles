// stream-profiles: save named stream "contexts" and switch between them.
//
// A profile bundles the settings that describe a broadcast:
//
//   server name, stream title, About, welcome message, offline message,
//   custom page content, tags, NSFW, directory listing, autoplay, chat
//   toggles, fediverse go-live message, video serving endpoint, custom
//   CSS/JavaScript, external action buttons, social handles
//
// Owncast's plugin API has no setter for any of these, so applying a profile
// calls the server's own admin API over HTTP (HTTP Basic, user "admin"). Those
// endpoints are documented as internal and unstable, which is the trade-off
// this plugin makes: it needs the admin password per request and `network.fetch`.
//
// The password is never read from config and never written to storage. The
// admin page asks for it, holds it in memory for as long as the page is open,
// and sends it with each request that needs it. Nothing here logs it.
//
// Every endpoint below takes { value: ... } under /api/admin and replies with
// { success, message }, except GET /serverconfig which returns the whole config.

const { definePlugin, owncast, authCheck } = require("@owncast/plugin-sdk");

// base64/utf8Bytes are only used for the admin API's Basic header. Everything
// else in ./auth backs the viewer gate.
const {
  ROUNDS,
  base64,
  utf8Bytes,
  findMatchingCredential,
  hashPassword,
  newSalt,
  normalizeCredentials,
  parseBasicAuthorization,
  roundsToTry,
  safeReturnTo,
  sha256Hex,
  summarizeCredentials,
} = require("./auth");

const PROFILES_KEY = "profiles";
const ACTIVE_KEY = "active-profile";

// Credentials live beside their profile, never inside it: a profile round-trips
// through the admin page, and a password hash has no business making that trip.
const CREDENTIALS_PREFIX = "auth:";
// One credential that is not attached to any profile. It exists so a mistake in
// a profile cannot shut the owner out of their own site, which makes it the one
// thing here that must not depend on the active profile.
const ADMIN_CREDENTIAL_KEY = "auth-admin";
// Session bindings record their issuer. Real profile ids are slugs, so this
// sentinel cannot collide with one.
const ADMIN_SCOPE = "admin";
// Which profile issued a viewer's session, so switching profiles revokes the
// sessions of the old one instead of letting them ride along.
const SESSION_PREFIX = "auth-session:";

// Failed sign-in attempts are metered because each one hashes a password and
// Owncast runs plugin handlers one at a time against a 5 s deadline. Overrunning
// that deadline does not slow the request, it closes the module and leaves every
// viewer -- and the owner login -- offline until an admin reloads the plugin.
//
// The budget is spent *before* any hashing, and the new state is written before
// this returns, so a burst cannot all pass the check while the first hash is
// still running. The bucket is global because the request carries no trustworthy
// client address (only headers the caller chooses); a second bucket per submitted
// username (hashed, so every name is treated alike) keeps one account from being
// ground down. Per-IP throttling still belongs at the reverse proxy; this is the
// ceiling that has to exist here, because the plugin is what does the expensive
// work.
//
// The budget is counted in hash rounds, not attempts, because one attempt is not
// a fixed amount of work: 32 rounds normally, but 544 per credential written by
// an older release, which has to be verified at both counts until it is upgraded.
// Counting attempts would let a burst of eight turn into 8 x 1088 rounds, which
// is past the deadline -- the exact failure this exists to prevent. 0.3.1
// survived roughly 2400 rounds queued, so half of that leaves room on a slower
// server. A successful sign-in refunds what it spent, so a viewer who types the
// password right never spends the site's budget.
const ATTEMPT_KEY = "auth-attempt";
const ATTEMPT_ROUNDS = 1600;
const ATTEMPT_ROUNDS_REFILL_MS = 60 * 1000;
const ATTEMPT_USER_PREFIX = "auth-attempt-user:";
const ATTEMPT_USER_BURST = 3;
const ATTEMPT_USER_REFILL_MS = 60 * 1000;

// Lifetime of a renewed session, in seconds. Owncast's default is 24 h and is
// absolute: a viewer who never signs in again is dropped 24 h later even if
// they watch every day. Returning `refresh` on each page load makes it sliding,
// which is what a viewer expects from "signed in". The same 24 h keeps the
// revocation backstop unchanged, since a revoked viewer is only noticed on a
// page load anyway.
const SESSION_RENEW_SECONDS = 24 * 60 * 60;

const AUTOPLAY_MODES = ["off", "always", "sound-only"];

// The single source of truth for what a profile can hold. `type` drives both
// coercion on save and which widget the admin page renders:
//
//   string   free text (Markdown or plain, Owncast decides)
//   list     array of strings
//   boolean  true / false
//   enum     one of `options`
//   actions  Owncast external actions (the buttons under the stream)
//   socials  Owncast social handles
//
// `capture(details, root)` reads the current value back out of
// GET /serverconfig so an existing setup can be imported into a profile.
// Nothing in this list needs an Owncast restart: every endpoint writes to the
// datastore and the value is read per request. Some values are read at a later
// moment, though, so `activation` records when the change is actually observed.
// The apply response reports these back so the UI can say what is still pending.
//
//   instant           read per request (the default)
//   next-stream       read when a broadcast starts
//   directory-ping    sent to the Owncast directory on its next ping (~4 min)
//   new-connections   enforced when a chat client connects
//   browser-cache     stored now, but visitors may hold a cached copy
const ACTIVATION_NOTES = {
  "next-stream": "takes effect when the next stream starts",
  "directory-ping":
    "reaches the Owncast directory within about 4 minutes while live",
  "new-connections":
    "applies to new chat connections; viewers already connected keep chatting until they reconnect",
  "browser-cache":
    "is stored now, but browsers cache the old image (PNG up to 30 days, ICO 1 day) — hard-refresh to check",
};

const FIELD_SPECS = [
  {
    key: "serverName",
    label: "Server name",
    path: "/config/name",
    type: "string",
    capture: (details) => details.name,
  },
  {
    key: "streamTitle",
    label: "Stream title",
    path: "/config/streamtitle",
    type: "string",
    capture: (details) => details.streamTitle,
  },
  {
    key: "summary",
    label: "About text",
    path: "/config/serversummary",
    type: "string",
    capture: (details) => details.summary,
  },
  {
    key: "welcomeMessage",
    label: "Welcome message",
    path: "/config/welcomemessage",
    type: "string",
    capture: (details) => details.welcomeMessage,
  },
  {
    key: "offlineMessage",
    label: "Offline message",
    path: "/config/offlinemessage",
    type: "string",
    capture: (details) => details.offlineMessage,
  },
  {
    key: "extraPageContent",
    label: "Custom page content",
    path: "/config/pagecontent",
    type: "string",
    capture: (details) => details.extraPageContent,
  },
  {
    key: "tags",
    label: "Tags",
    path: "/config/tags",
    type: "list",
    capture: (details) => details.tags,
  },
  {
    key: "nsfw",
    label: "Mark as NSFW",
    path: "/config/nsfw",
    type: "boolean",
    capture: (details) => details.nsfw,
  },
  {
    key: "directoryEnabled",
    label: "List in the Owncast directory",
    path: "/config/directoryenabled",
    type: "boolean",
    activation: "directory-ping",
    capture: (details, root) => Boolean(root.yp && root.yp.enabled),
  },
  {
    key: "autoplay",
    label: "Autoplay",
    path: "/config/autoplay",
    type: "enum",
    options: AUTOPLAY_MODES,
    fallback: "always",
    capture: (details) => details.autoplay,
  },
  {
    key: "chatDisabled",
    label: "Disable chat",
    path: "/config/chat/disable",
    type: "boolean",
    activation: "new-connections",
    capture: (details, root) => Boolean(root.chatDisabled),
  },
  {
    key: "chatJoinMessagesEnabled",
    label: "Chat join messages",
    path: "/config/chat/joinmessagesenabled",
    type: "boolean",
    capture: (details, root) => Boolean(root.chatJoinMessagesEnabled),
  },
  {
    // The pool Owncast picks a display name from for viewers who have not
    // signed in. Owncast uses it only when it holds at least
    // minSuggestedUsernamePoolLength (10) entries and otherwise generates
    // phrases instead, so a shorter list is silently ignored — the admin page
    // says so next to the field.
    //
    // Not in the /serverconfig `instanceDetails` object, unlike the fields
    // above it.
    key: "suggestedUsernames",
    label: "Suggested chat usernames",
    path: "/config/chat/suggestedusernames",
    type: "list",
    capture: (details, root) => root.suggestedUsernames,
  },
  {
    key: "hideViewerCount",
    label: "Hide viewer count",
    path: "/config/hideviewercount",
    type: "boolean",
    capture: (details, root) => Boolean(root.hideViewerCount),
  },
  {
    key: "disableSearchIndexing",
    label: "Opt out of search indexing",
    path: "/config/disablesearchindexing",
    type: "boolean",
    capture: (details, root) => Boolean(root.disableSearchIndexing),
  },
  {
    key: "federationGoLiveMessage",
    label: "Fediverse go-live message",
    path: "/config/federation/livemessage",
    type: "string",
    activation: "next-stream",
    capture: (details, root) =>
      root.federation ? root.federation.goLiveMessage : "",
  },
  {
    key: "videoServingEndpoint",
    label: "Video serving endpoint",
    path: "/config/videoservingendpoint",
    type: "string",
    activation: "next-stream",
    capture: (details, root) => root.videoServingEndpoint,
  },
  {
    key: "customStyles",
    label: "Custom CSS",
    path: "/config/customstyles",
    type: "string",
    capture: (details) => details.customStyles,
  },
  {
    key: "customJavascript",
    label: "Custom JavaScript",
    path: "/config/customjavascript",
    type: "string",
    capture: (details) => details.customJavascript,
  },
  {
    key: "externalActions",
    label: "Action buttons",
    path: "/config/externalactions",
    type: "actions",
    capture: (details, root) => root.externalActions,
  },
  {
    key: "socialHandles",
    label: "Social links",
    path: "/config/socialhandles",
    type: "socials",
    capture: (details) => details.socialHandles,
  },
  {
    key: "logo",
    label: "Logo",
    path: "/config/logo",
    type: "image",
    activation: "browser-cache",
    capture: () => "",
  },
  {
    key: "favicon",
    label: "Favicon",
    path: "/config/favicon",
    type: "image",
    activation: "browser-cache",
    capture: () => "",
  },
];

// Images are stored beside the profiles, not inside them: a profile entry stays
// small, and each image gets its own request (the plugin caps request bodies at
// 1 MB). `maxChars` bounds the data URI length for that reason, and because
// Owncast validates/limits the decoded image itself.
//
// `reset` marks a field Owncast can clear on its own: DELETE /config/favicon
// removes the custom favicon and falls back to the stock one, so no bytes are
// needed. The logo has no such endpoint (`SetLogo` only accepts base64), which
// is why the one bundled asset in this plugin is Owncast's own
// `static/img/logo.png` — the file `static.GetLogo()` serves when unset.
const IMAGE_FIELDS = {
  logo: {
    maxChars: 700 * 1024,
    asset: "defaults/logo.png",
    mime: "image/png",
  },
  favicon: {
    maxChars: 300 * 1024,
    reset: true,
  },
};

// Data URI for a field's stock image, read from this plugin's bundled assets.
// Fields with a native reset have no asset and return "".
function defaultImageData(field) {
  const spec = IMAGE_FIELDS[field];
  if (!spec || !spec.asset) return "";

  try {
    const bytes = owncast.assets.read(spec.asset);
    if (!bytes || !bytes.length) return "";
    return "data:" + spec.mime + ";base64," + base64(bytes);
  } catch (error) {
    // A missing asset is not worth failing the whole apply over; the caller
    // falls back to leaving the image alone.
    return "";
  }
}

// Fields a profile never touches unless the admin opts in. These are site or
// infrastructure settings: rewriting them from a stream profile is legal, but
// doing it by surprise clears a theme, a CDN host, or the chat policy. The same
// reasoning applies to a field added late: a profile captured before it existed
// holds an empty value, and applying that would wipe whatever is configured now.
const DEFAULT_SKIPPED = [
  "serverName",
  "videoServingEndpoint",
  "customStyles",
  "customJavascript",
  "chatDisabled",
  "hideViewerCount",
  "disableSearchIndexing",
  "externalActions",
  "socialHandles",
  // A profile captured before this field existed has an empty list, and
  // applying it would otherwise clear the operator's real one.
  "suggestedUsernames",
];

// Starting point for a fresh install. Delete or rename them freely.
const SEED_PROFILES = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function parseJson(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function slugify(value) {
  const slug = text(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "profile";
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function configString(key, fallback) {
  try {
    const value = owncast.config.get(key, fallback);
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return fallback;
    return String(value);
  } catch (error) {
    return fallback;
  }
}

function baseUrl() {
  const configured = configString("owncastUrl", "").trim();
  const base = configured || "http://127.0.0.1:8080";
  return base.replace(/\/+$/, "");
}

// The admin password is never stored by this plugin. It arrives with each
// request that needs it, is used for one batch of admin API calls, and is
// dropped when the request ends. See the README for why.
function authorizationHeader(password) {
  return "Basic " + base64(utf8Bytes("admin:" + password));
}

// Credentials arrive in the request body, so reject obvious junk early. The
// value is never trimmed: leading or trailing spaces are legal in a password.
function usablePassword(value) {
  return typeof value === "string" && value !== "";
}

// ---------------------------------------------------------------------------
// Admin API calls
// ---------------------------------------------------------------------------

// Anything that is not a JSON message (a proxy's HTML error page, a plain-text
// 413 from the host) is passed through so the operator sees the real reason
// instead of a bare status code.
function bodySnippet(raw) {
  const body = text(raw).replace(/\s+/g, " ").trim();
  if (!body) return "";
  return body.length > 300 ? body.slice(0, 300) + "…" : body;
}

function failureText(status, data, rawBody) {
  if (data && typeof data.message === "string" && data.message) {
    return data.message;
  }
  if (data && typeof data.error === "string" && data.error) {
    return data.error;
  }

  const snippet = bodySnippet(rawBody);
  const base =
    status === 401
      ? "Unauthorized — check the admin password"
      : status === 403
        ? "Forbidden — the server rejected the request"
        : status === 404
          ? "Not found — is this Owncast 0.3.0 or newer?"
          : status === 0
            ? "No response"
            : "HTTP " + status;

  return snippet ? base + ": " + snippet : base;
}

function adminRequest(method, path, payload, password) {
  const url = baseUrl() + "/api/admin" + path;
  const options = {
    method: method,
    headers: {
      Authorization: authorizationHeader(password),
      Accept: "application/json",
    },
  };

  if (payload !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = owncast.http.fetch(url, options);
  } catch (error) {
    // The URL is for the server log; the operator needs to know what to do,
    // not which address was tried.
    owncast.log.error(
      "stream-profiles: could not reach " + url + ": " + describeError(error),
    );
    return {
      ok: false,
      status: 0,
      code: "network",
      error:
        "Could not reach Owncast. If it runs somewhere other than this " +
        "machine, set its address in this plugin's settings.",
    };
  }

  const status =
    response && typeof response.status === "number" ? response.status : 0;
  const rawBody = response ? text(response.body) : "";
  const data = parseJson(rawBody);
  const rejected = data && data.success === false;
  const ok = status >= 200 && status < 300 && !rejected;

  if (ok) return { ok: true, status: status, data: data };
  return {
    ok: false,
    status: status,
    code: status === 401 ? "unauthorized" : "admin-api",
    data: data,
    error: failureText(status, data, rawBody),
  };
}

// ---------------------------------------------------------------------------
// Profile storage
// ---------------------------------------------------------------------------

function emptyProfile() {
  const profile = { id: "", name: "", skip: [] };
  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    const spec = FIELD_SPECS[i];
    profile[spec.key] = defaultFieldValue(spec);
  }
  return profile;
}

function defaultFieldValue(spec) {
  if (spec.type === "list" || spec.type === "actions" || spec.type === "socials") {
    return [];
  }
  if (spec.type === "boolean" || spec.type === "image") return false;
  if (spec.type === "enum") return spec.fallback;
  return "";
}

// Tags and other simple lists: trimmed, non-empty, de-duplicated.
function normalizeStringList(input) {
  if (!Array.isArray(input)) {
    if (typeof input === "string") input = input.split(",");
    else return [];
  }

  const seen = {};
  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const value = text(input[i]).trim();
    if (!value || seen[value]) continue;
    seen[value] = true;
    out.push(value);
  }
  return out;
}

// External actions: title plus either a URL or inline HTML. Rows missing both
// are dropped rather than sent to the server as broken buttons.
function normalizeActions(input) {
  if (!Array.isArray(input)) return [];

  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;

    const action = {
      title: text(raw.title).trim(),
      url: text(raw.url).trim(),
      description: text(raw.description).trim(),
      html: text(raw.html),
      icon: text(raw.icon).trim(),
      color: text(raw.color).trim(),
      openExternally: raw.openExternally === true,
    };

    if (!action.title || (!action.url && !action.html)) continue;
    out.push(action);
  }
  return out;
}

// Social handles: a platform key (or free text) and a URL.
function normalizeSocials(input) {
  if (!Array.isArray(input)) return [];

  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;

    const platform = text(raw.platform).trim();
    const url = text(raw.url).trim();
    if (!platform || !url) continue;

    out.push({ platform: platform, url: url, icon: text(raw.icon).trim() });
  }
  return out;
}

function normalizeFieldValue(spec, raw) {
  if (spec.type === "list") return normalizeStringList(raw);
  if (spec.type === "actions") return normalizeActions(raw);
  if (spec.type === "socials") return normalizeSocials(raw);
  if (spec.type === "boolean") return raw === true || raw === "true" || raw === 1;
  // Image data never travels inside a profile; the stored value is just a
  // presence flag filled in by profilesForClient().
  if (spec.type === "image") return false;
  if (spec.type === "enum") {
    return spec.options.indexOf(raw) !== -1 ? raw : spec.fallback;
  }
  return text(raw);
}

// ---------------------------------------------------------------------------
// Image storage
//
// Owncast's admin API accepts a logo/favicon as base64, but GET /serverconfig
// only reports the stored file path, so the plugin cannot read the bytes back.
// The admin page can: it is same-origin with Owncast, fetches /logo and
// /favicon.ico as bytes, and hands the plugin a data URI. Binary never crosses
// the plugin runtime, which is string-only anyway.
// ---------------------------------------------------------------------------

function imageKey(id, field) {
  return "image:" + id + ":" + field;
}

function loadImage(id, field) {
  const stored = owncast.kv.get(imageKey(id, field));
  return typeof stored === "string" ? stored : "";
}

function storeImage(id, field, data) {
  owncast.kv.set(imageKey(id, field), data);
}

function deleteImages(id) {
  for (const field in IMAGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(IMAGE_FIELDS, field)) continue;
    owncast.kv.set(imageKey(id, field), "");
  }
}

// A data URI is the only shape Owncast's DecodeBase64Image accepts. An empty
// query parameter is rejected, so string validation happens here instead of
// letting the server answer with a confusing error.
function validateImageData(field, data) {
  const spec = IMAGE_FIELDS[field];
  if (!spec) return "Unknown image field: " + field;
  if (typeof data !== "string") return "Expected the image as a data URI string.";
  if (data === "") return "";
  if (data.length > spec.maxChars) {
    return (
      "Image is too large: " +
      Math.round(data.length / 1024) +
      " KB of data, the limit for " +
      field +
      " is " +
      Math.round(spec.maxChars / 1024) +
      " KB."
    );
  }
  if (data.indexOf("data:image/") !== 0 || data.indexOf(";base64,") === -1) {
    return "Expected a base64 image data URI.";
  }
  return "";
}

// Keeps only keys that name a real profile field, de-duplicated.
function normalizeSkip(input) {
  if (!Array.isArray(input)) return [];

  const known = {};
  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    known[FIELD_SPECS[i].key] = true;
  }

  const seen = {};
  const skip = [];
  for (let i = 0; i < input.length; i += 1) {
    const key = input[i];
    if (typeof key !== "string" || !known[key] || seen[key]) continue;
    seen[key] = true;
    skip.push(key);
  }
  return skip;
}

// Coerces whatever the admin page posted into the shape the plugin stores:
// stable unique ids, values parsed per field type, no extra keys.
function normalizeProfiles(input, options) {
  if (!Array.isArray(input)) return [];

  // Applied only when reading profiles off the shelf, never to profiles arriving
  // from the admin page. A profile stored before a field existed has no value
  // for it, and normalising fills in an empty default; applying that would wipe
  // whatever the server is configured with now. Skipping it keeps an upgrade
  // from silently erasing a setting the operator never touched.
  const skipMissing = Boolean(options && options.skipMissingFields);

  const taken = {};
  const profiles = [];

  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!raw || typeof raw !== "object") continue;

    const profile = emptyProfile();
    const base = slugify(raw.id || raw.name || "profile-" + (index + 1));
    let id = base;
    let suffix = 2;
    while (taken[id]) {
      id = base + "-" + suffix;
      suffix += 1;
    }
    taken[id] = true;

    profile.id = id;
    profile.name = text(raw.name).trim() || id;
    for (let i = 0; i < FIELD_SPECS.length; i += 1) {
      const spec = FIELD_SPECS[i];
      profile[spec.key] = normalizeFieldValue(spec, raw[spec.key]);
    }

    const skip = normalizeSkip(raw.skip);
    if (skipMissing) {
      for (let i = 0; i < FIELD_SPECS.length; i += 1) {
        const key = FIELD_SPECS[i].key;
        const known = Object.prototype.hasOwnProperty.call(raw, key);
        if (!known && skip.indexOf(key) === -1) skip.push(key);
      }
    }
    profile.skip = skip;

    profiles.push(profile);
  }

  return profiles;
}

function storedProfiles() {
  return owncast.kv.get(PROFILES_KEY);
}

function loadProfiles() {
  const stored = storedProfiles();
  if (stored === undefined || stored === null || stored === "") {
    return normalizeProfiles(SEED_PROFILES);
  }
  return normalizeProfiles(parseJson(stored), { skipMissingFields: true });
}

function loadActiveId() {
  const stored = owncast.kv.get(ACTIVE_KEY);
  return typeof stored === "string" ? stored : "";
}

// ---------------------------------------------------------------------------
// Applying and capturing
// ---------------------------------------------------------------------------

function applyProfile(profile, password) {
  if (!usablePassword(password)) {
    return {
      ok: false,
      status: 400,
      code: "missing-password",
      results: [],
      error: "Enter the Owncast admin password to apply a profile.",
    };
  }

  const results = [];

  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    const field = FIELD_SPECS[i];

    if (profile.skip.indexOf(field.key) !== -1) {
      results.push({ field: field.key, skipped: true });
      continue;
    }

    let value = profile[field.key];
    let method = "POST";

    if (field.type === "image") {
      const stored = loadImage(profile.id, field.key);

      if (stored) {
        value = stored;
      } else if (IMAGE_FIELDS[field.key].reset) {
        // No image in this profile: ask Owncast to drop the custom one, which
        // puts its stock image back. Nothing to upload.
        value = undefined;
        method = "DELETE";
      } else {
        value = defaultImageData(field.key);
        if (!value) {
          results.push({ field: field.key, label: field.label, skipped: true });
          continue;
        }
      }
    }

    const payload = value === undefined ? undefined : { value: value };
    const result = adminRequest(method, field.path, payload, password);

    results.push({
      field: field.key,
      label: field.label,
      ok: result.ok,
      status: result.status,
      error: result.error,
    });

    if (!result.ok) {
      return {
        ok: false,
        status: result.status === 401 ? 401 : 502,
        code: result.code,
        results: results,
        error:
          "Could not set " + field.label + ": " + result.error,
      };
    }
  }

  owncast.kv.set(ACTIVE_KEY, profile.id);
  return { ok: true, results: results, pending: pendingChanges(results) };
}

// Fields that were written but will not be visible straight away, so the admin
// page can say so instead of leaving the user wondering.
function pendingChanges(results) {
  const pending = [];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result.ok) continue;

    const spec = findFieldSpec(result.field);
    if (!spec || !spec.activation) continue;

    pending.push({
      field: spec.key,
      label: spec.label,
      activation: spec.activation,
      note: ACTIVATION_NOTES[spec.activation] || "",
    });
  }

  return pending;
}

function findFieldSpec(key) {
  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    if (FIELD_SPECS[i].key === key) return FIELD_SPECS[i];
  }
  return null;
}

function readServerProfile(password) {
  if (!usablePassword(password)) {
    return {
      ok: false,
      status: 400,
      code: "missing-password",
      error: "Enter the Owncast admin password to read the server settings.",
    };
  }

  const result = adminRequest("GET", "/serverconfig", undefined, password);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status === 401 ? 401 : 502,
      code: result.code,
      error: result.error,
    };
  }

  const root = result.data || {};
  const details = root.instanceDetails || {};

  const profile = emptyProfile();
  profile.name =
    text(details.streamTitle) || text(details.name) || "Captured profile";

  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    const spec = FIELD_SPECS[i];
    let raw;
    try {
      raw = spec.capture(details, root);
    } catch (error) {
      raw = undefined;
    }
    profile[spec.key] = normalizeFieldValue(spec, raw);
  }

  // A captured profile describes exactly what the server has right now, so
  // every field is included rather than inheriting the opt-in defaults.
  profile.skip = [];

  return { ok: true, profile: profile };
}

// ---------------------------------------------------------------------------
// Viewer authentication
//
// The active profile decides who may watch. Owncast's host owns the session
// cookie and calls into this plugin only to decide whether to mint one, so
// nothing here ever sees or stores a cookie.
//
// Owncast grants the `auth.gate` middleware whenever an admin enables this
// plugin as the gate; the plugin cannot turn it off per request. So the three
// states have to be deliberate:
//
//   no active profile      -> closed, with a page that says why
//   profile, no credentials -> open: viewers are granted a session silently
//   profile with credentials -> the login page
//
// A native HTTP Basic prompt is not reachable from a plugin: Owncast filters
// response headers through an allowlist that has no `WWW-Authenticate`, so a
// 401 challenge never leaves the server. Browsers therefore get a form, and the
// Authorization header is honoured only when a client sends one unprompted.
// ---------------------------------------------------------------------------

function credentialsKey(profileId) {
  return CREDENTIALS_PREFIX + profileId;
}

function loadCredentials(profileId) {
  if (!profileId) return [];
  return normalizeCredentials(owncast.kv.get(credentialsKey(profileId)));
}

function saveCredentials(profileId, entries) {
  owncast.kv.set(credentialsKey(profileId), JSON.stringify(entries));
}

function deleteCredentials(profileId) {
  owncast.kv.set(credentialsKey(profileId), "");
}

function loadAdminEntry() {
  const entries = normalizeCredentials(owncast.kv.get(ADMIN_CREDENTIAL_KEY));
  return entries.length ? entries[0] : null;
}

function saveAdminEntry(entry) {
  owncast.kv.set(ADMIN_CREDENTIAL_KEY, JSON.stringify([entry]));
}

function clearAdminEntry() {
  owncast.kv.set(ADMIN_CREDENTIAL_KEY, "");
}

// Deletes the credentials of any profile that disappeared from the list, so a
// removed profile cannot keep gating the site from orphaned storage.
function pruneCredentials(before, after) {
  const keep = {};
  for (let i = 0; i < after.length; i += 1) keep[after[i].id] = true;
  for (let i = 0; i < before.length; i += 1) {
    if (!keep[before[i].id]) deleteCredentials(before[i].id);
  }
}

// The credential set currently in force. `known` is false when no profile is
// active or the active id no longer names a profile. `admin` is deliberately
// independent of both, so every caller sees it whatever the profile state.
function activeAuth() {
  const admin = loadAdminEntry();
  const activeId = loadActiveId();
  if (!activeId) return { profileId: "", entries: [], known: false, admin: admin };

  const exists = loadProfiles().some(function (profile) {
    return profile.id === activeId;
  });
  if (!exists) return { profileId: "", entries: [], known: false, admin: admin };

  return {
    profileId: activeId,
    entries: loadCredentials(activeId),
    known: true,
    admin: admin,
  };
}

// Resolves a username and password against everything that can grant access,
// in the order that makes the result predictable:
//
//   1. a profile credential that names this viewer
//   2. the admin credential
//   3. a profile credential with no username (accepts any)
//
// Named entries come first because a profile shares one salt, so two entries
// holding the same password have identical hashes and the shared one would
// otherwise stand in and put the viewer in chat as "Guest". The admin
// credential is checked before the shared entries for the same reason: signing
// in as the admin must not quietly become Guest.
function authenticate(auth, username, password) {
  const supplied = text(username);
  if (text(password) === "") return null;

  // Every salt and round count in force is hashed, whatever username was
  // supplied, so a failed attempt costs the same work whether the name exists
  // or not. The candidate list below only decides which hashes are compared.
  const work = credentialWork(auth);

  // Exact username matches are tried before the owner login, which is tried
  // before password-only entries. Both are legitimate candidates, but an entry
  // that names the viewer must win. Because a profile shares one salt, two
  // entries with the same password have identical hashes, so without this
  // ordering an earlier password-only entry would silently stand in and the
  // viewer would appear in chat as "Guest" instead of their username.
  const candidates = [];

  for (let i = 0; i < auth.entries.length; i += 1) {
    const entry = auth.entries[i];
    if (entry.user !== "" && entry.user === supplied) {
      candidates.push({ entry: entry, admin: false });
    }
  }

  if (auth.admin && auth.admin.user === supplied) {
    candidates.push({ entry: auth.admin, admin: true });
  }

  for (let i = 0; i < auth.entries.length; i += 1) {
    const entry = auth.entries[i];
    if (entry.user === "") candidates.push({ entry: entry, admin: false });
  }

  const match = findMatchingCredential(candidates, password, work);
  if (match) persistUpgradedCredential(auth, match);
  return match;
}

// Every { salt, rounds } the active credential set has to be hashed at, one per
// distinct pair. Two callers depend on this being the same list: verification
// hashes it, and the attempt budget is charged for it, so they must not drift.
function credentialWork(auth) {
  const work = [];
  const seen = {};

  function add(entry) {
    const counts = roundsToTry(entry);
    for (let i = 0; i < counts.length; i += 1) {
      const key = entry.salt + "|" + counts[i];
      if (seen[key]) continue;
      seen[key] = true;
      work.push({ salt: entry.salt, rounds: counts[i] });
    }
  }

  for (let i = 0; i < auth.entries.length; i += 1) add(auth.entries[i]);
  if (auth.admin) add(auth.admin);
  return work;
}

// What one verification will cost, in rounds, before it runs. Falls back to the
// cost of the fixed-salt hash performed when there is nothing to check.
function signInCostRounds(auth) {
  const work = credentialWork(auth);
  let rounds = 0;
  for (let i = 0; i < work.length; i += 1) rounds += work[i].rounds;
  return rounds > 0 ? rounds : ROUNDS;
}

// A credential verified at an older count is re-hashed at the current one by
// findMatchingCredential. Writing it back keeps that upgrade from being redone
// on every later sign-in, and stamps the count so a future ROUNDS change can
// migrate deliberately instead of locking everyone out.
function persistUpgradedCredential(auth, match) {
  const entry = match && match.entry;
  if (!entry || entry.upgraded !== true) return;
  delete entry.upgraded;

  if (match.admin) {
    saveAdminEntry(entry);
    return;
  }
  saveCredentials(auth.profileId, auth.entries);
}

// scope is a profile id, or ADMIN_SCOPE. A stable, provider-free identity: one
// Owncast user per credential rather than per viewer, which is what a shared
// password can support.
function grantAccess(scope, entry) {
  const entryId = entry ? entry.id : "open";
  const authId = scope + ":" + entryId;
  const displayName = entry && entry.user ? entry.user : "Guest";

  const registered = owncast.users.register({
    authId: authId,
    displayName: displayName,
  });
  const userId =
    registered && registered.userId ? registered.userId : registered;

  if (!userId) throw new Error("could not register the viewer identity");

  // Recorded before the session exists, so onAuthCheck can never see a session
  // it cannot attribute to an issuer.
  owncast.kv.set(SESSION_PREFIX + userId, scope + "|" + entryId);
  owncast.auth.grantSession({ userId: userId });

  return userId;
}

function hasSessionBinding(userId) {
  const binding = owncast.kv.get(SESSION_PREFIX + userId);
  return typeof binding === "string" ? binding : "";
}

function redirectTo(location) {
  return {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  };
}

function htmlResponse(status, body) {
  return {
    status: status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: body,
  };
}

function plainResponse(status, body) {
  return {
    status: status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: body,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The gate page is a viewer page, not an admin page, so the host injects no
// stylesheet into it: everything it needs travels with it.
function loginPage(options) {
  const showUsername = Boolean(options.showUsername);
  const message = options.message
    ? '<p class="sp-error">' + escapeHtml(options.message) + "</p>"
    : "";

  const username = showUsername
    ? '<label>Username<input name="user" autocomplete="username" autocapitalize="none" required></label>'
    : "";

  return (
    "<!doctype html><html lang=en><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>Sign in</title>" +
    "<style>" +
    ":root{color-scheme:dark}" +
    "body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "background:#0f0f14;color:#efeff1;font:15px/1.5 system-ui,-apple-system,sans-serif}" +
    "form{width:min(22rem,88vw);display:grid;gap:.85rem;padding:1.6rem;" +
    "background:#191920;border:1px solid #2c2c36;border-radius:12px}" +
    "h1{margin:0;font-size:1.15rem;font-weight:600}" +
    "p{margin:0;color:#b6b3c6;font-size:.9rem}" +
    ".sp-error{color:#ff8a8a}" +
    "label{display:grid;gap:.35rem;font-size:.85rem;color:#b6b3c6}" +
    "input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;" +
    "border:1px solid #34343f;background:#101016;color:inherit;font:inherit}" +
    "input:focus{outline:2px solid #2087e2;outline-offset:1px;border-color:#2087e2}" +
    "button{margin-top:.35rem;padding:.65rem;border:0;border-radius:8px;font:inherit;" +
    "font-weight:600;color:#fff;background:#2087e2;cursor:pointer}" +
    "button:hover{background:#1a72c2}" +
    "</style>" +
    "<form method=post>" +
    "<h1>This stream is private</h1>" +
    message +
    username +
    '<label>Password<input name="password" type="password" ' +
    'autocomplete="current-password" autofocus required></label>' +
    '<input type="hidden" name="return_to" value="' +
    escapeHtml(options.returnTo) +
    '">' +
    "<button type=submit>Watch</button>" +
    "</form></html>"
  );
}

function blockedPage(message) {
  return (
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>Not available</title>" +
    "<body style='font:15px/1.5 system-ui,sans-serif;background:#0f0f14;color:#efeff1;" +
    "display:grid;place-items:center;min-height:100vh;margin:0;text-align:center'>" +
    "<div style='max-width:26rem;padding:1.5rem'>" +
    "<h1 style='font-size:1.1rem'>This stream is not available</h1>" +
    "<p style='color:#b6b3c6'>" +
    escapeHtml(message) +
    "</p></div>"
  );
}

// Form bodies arrive as raw application/x-www-form-urlencoded text; the host
// does not parse them and the sandbox has no URLSearchParams.
function parseFormBody(body) {
  const out = {};
  const raw = text(body);

  for (let i = 0; i < raw.length; ) {
    let end = raw.indexOf("&", i);
    if (end === -1) end = raw.length;
    const pair = raw.slice(i, end);
    i = end + 1;
    if (pair === "") continue;

    const split = pair.indexOf("=");
    const key = split === -1 ? pair : pair.slice(0, split);
    const value = split === -1 ? "" : pair.slice(split + 1);

    try {
      out[decodeURIComponent(key.replace(/\+/g, " "))] = decodeURIComponent(
        value.replace(/\+/g, " "),
      );
    } catch (error) {
      // A malformed escape cannot name a field we care about.
    }
  }

  return out;
}

function requestHeader(req, name) {
  const headers = req.headers || {};
  const wanted = name.toLowerCase();
  for (const key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) {
      return text(headers[key]);
    }
  }
  return "";
}

// Host part of an absolute URL (scheme://host[:port]/...), without the URL API
// the sandbox does not have.
function urlHost(value) {
  const lower = text(value).trim().toLowerCase();
  const schemeEnd = lower.indexOf("://");
  if (schemeEnd === -1) return "";

  const rest = lower.slice(schemeEnd + 3);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

// The public host, when a reverse proxy reports it. Go keeps the Host header
// out of `r.Header`, and the host builds this plugin's request envelope from
// `r.Header`, so `host` is normally absent. X-Forwarded-Host is the one
// server-side value we can compare against.
function publicHost(req) {
  const forwarded = requestHeader(req, "x-forwarded-host");
  const first = forwarded.split(",")[0].trim().toLowerCase();
  if (first !== "") return first;
  return requestHeader(req, "host").trim().toLowerCase();
}

// True when the request was issued by this site. Browsers set Sec-Fetch-Site,
// which page script cannot forge: a cross-site form post is "cross-site" or
// "same-site". A request with no Sec-Fetch-Site is not a browser form post --
// curl, a player app, or a proxy that strips it -- so it falls back to comparing
// Origin/Referer with X-Forwarded-Host when that is available. Requests with
// neither browser header are allowed so scripted clients keep working.
function isSameOrigin(req) {
  const site = requestHeader(req, "sec-fetch-site").trim().toLowerCase();
  if (site === "same-origin" || site === "none") return true;
  if (site === "cross-site" || site === "same-site") return false;

  const host = publicHost(req);

  const origin = requestHeader(req, "origin");
  if (origin !== "") {
    if (origin.trim().toLowerCase() === "null") return false;
    return host === "" || urlHost(origin) === host;
  }

  const referer = requestHeader(req, "referer");
  if (referer !== "") {
    return host === "" || urlHost(referer) === host;
  }

  return true;
}

// GET / — where the host sends an unauthenticated viewer. Every branch ends in
// a session, a form, or an explanation; never a silent pass-through.
function gateEntry(req) {
  const auth = activeAuth();
  const query = req.query || {};
  const returnTo = safeReturnTo(query.return_to);

  if (!auth.known) {
    // Without a profile the operator has expressed no intent, so the site stays
    // closed. The admin credential is the exception: it exists precisely so a
    // profile mistake cannot lock the owner out, so it still gets a login page.
    if (!auth.admin) {
      return htmlResponse(
        200,
        blockedPage("No profile is active. The owner needs to apply one in the admin."),
      );
    }
    return htmlResponse(
      200,
      loginPage({ returnTo: returnTo, showUsername: true, message: "No profile is active." }),
    );
  }

  // An open profile stays open even when an admin credential exists: "no
  // credentials" means "let everyone in", and adding a separate admin login
  // must not silently change that.
  if (!auth.entries.length) {
    try {
      grantAccess(auth.profileId, null);
    } catch (error) {
      owncast.log.error(
        "stream-profiles: could not open a session: " + describeError(error),
      );
      return htmlResponse(503, blockedPage("Could not start a session. Check the server log."));
    }
    return redirectTo(returnTo);
  }

  const authorization = requestHeader(req, "authorization");
  if (authorization !== "") {
    const credentials = parseBasicAuthorization(authorization);
    if (!credentials) {
      return plainResponse(401, "Expected HTTP Basic credentials.");
    }
    // An empty password is rejected before the budget is touched: it costs no
    // hash, so letting it spend a token would be a free way to drain the bucket.
    if (text(credentials.password) === "") {
      return plainResponse(401, "Invalid credentials.");
    }
    // This branch hashes a password too, so it spends from the same budget.
    const cost = signInCostRounds(auth);
    if (!reserveSignInAttempt(credentials.user, cost)) {
      return plainResponse(429, "Too many sign-in attempts. Wait a moment, then try again.");
    }
    const match = authenticate(auth, credentials.user, credentials.password);
    if (!match) return plainResponse(401, "Invalid credentials.");
    refundSignInAttempt(credentials.user, cost);
    try {
      grantAccess(match.admin ? ADMIN_SCOPE : auth.profileId, match.entry);
    } catch (error) {
      owncast.log.error(
        "stream-profiles: could not start a session: " + describeError(error),
      );
      return plainResponse(503, "Could not start a session.");
    }
    return redirectTo(returnTo);
  }

  return htmlResponse(
    200,
    loginPage({ returnTo: returnTo, showUsername: showsUsernameField(auth) }),
  );
}

// One attempt's worth of budget. A token bucket rather than a fixed window so a
// viewer is not locked out for the whole window after one typo. `cost` is in
// rounds for the site-wide bucket and 1 for the per-username one; `refillMs` is
// how long a completely empty bucket takes to refill.
function takeTokens(key, burst, refillMs, cost) {
  const now = Date.now();
  const stored = parseJson(owncast.kv.get(key));
  let tokens = burst;
  let at = now;

  if (stored && typeof stored === "object") {
    if (typeof stored.tokens === "number" && isFinite(stored.tokens)) tokens = stored.tokens;
    if (typeof stored.at === "number" && isFinite(stored.at)) at = stored.at;
  }

  const refilled = Math.min(burst, tokens + (Math.max(0, now - at) * burst) / refillMs);
  // A single attempt is always allowed even if it costs more than the bucket
  // holds: refusing it forever would lock the deployment out, which is the
  // failure this whole change exists to prevent.
  const allowed = refilled >= cost;
  owncast.kv.set(key, JSON.stringify({ tokens: allowed ? refilled - cost : refilled, at: now }));
  return allowed;
}

// Returns what an attempt spent after a successful sign-in, so a viewer who
// mistyped once does not spend the site's budget.
function refundTokens(key, burst, cost) {
  const stored = parseJson(owncast.kv.get(key));
  if (!stored || typeof stored !== "object") return;

  const tokens = typeof stored.tokens === "number" && isFinite(stored.tokens) ? stored.tokens : 0;
  const at = typeof stored.at === "number" && isFinite(stored.at) ? stored.at : Date.now();
  owncast.kv.set(key, JSON.stringify({ tokens: Math.min(burst, tokens + cost), at: at }));
}

// Hashed so the KV key is a fixed, safe alphabet whatever the viewer typed.
function usernameAttemptKey(username) {
  return ATTEMPT_USER_PREFIX + sha256Hex(text(username).trim()).slice(0, 32);
}

// Reserves one attempt across both buckets. The username bucket is checked
// first, so a name that is already exhausted does not also drain the site-wide
// budget.
function reserveSignInAttempt(username, cost) {
  if (!takeTokens(usernameAttemptKey(username), ATTEMPT_USER_BURST, ATTEMPT_USER_REFILL_MS, 1)) {
    return false;
  }
  // Clamped so a record set too large to ever fit still gets one attempt
  // through rather than a permanent refusal.
  const charge = Math.min(cost, ATTEMPT_ROUNDS);
  return takeTokens(ATTEMPT_KEY, ATTEMPT_ROUNDS, ATTEMPT_ROUNDS_REFILL_MS, charge);
}

function refundSignInAttempt(username, cost) {
  refundTokens(usernameAttemptKey(username), ATTEMPT_USER_BURST, 1);
  refundTokens(ATTEMPT_KEY, ATTEMPT_ROUNDS, Math.min(cost, ATTEMPT_ROUNDS));
}

// 429 rendered with the ordinary sign-in page, so a throttled viewer gets a
// readable explanation instead of a bare status.
function tooManyAttempts(returnTo, auth) {
  return htmlResponse(
    429,
    loginPage({
      returnTo: returnTo,
      message: "Too many sign-in attempts. Wait a moment, then try again.",
      showUsername: showsUsernameField(auth),
    }),
  );
}

// The username input is only useful when something actually checks a username:
// a named profile credential or the admin one. A profile with only shared
// passwords keeps the single-field form.
function showsUsernameField(auth) {
  if (auth.admin) return true;
  return auth.entries.some(function (entry) {
    return entry.user !== "";
  });
}

// POST /auth/login — the only place a password may arrive. Deliberately not
// GET: a password in a URL ends up in logs, browser history and Referer headers.
function gateLogin(req) {
  const auth = activeAuth();
  const form = parseFormBody(req.body);
  const returnTo = safeReturnTo(form.return_to);

  // Signing in is a state change, so another site must not be able to submit
  // this form with the viewer's browser.
  if (!isSameOrigin(req)) {
    return htmlResponse(403, blockedPage("That sign-in did not come from this site."));
  }

  // Nothing can authenticate: an open profile needs no password, and with no
  // profile and no admin credential the site is closed by gateEntry.
  if ((!auth.known || !auth.entries.length) && !auth.admin) {
    return redirectTo(returnTo);
  }

  // An empty password costs no hash, so it is refused before it can spend a
  // token. authenticate() would also reject it; doing it here keeps the budget
  // from being drained for free.
  if (text(form.password) === "") {
    return htmlResponse(
      401,
      loginPage({
        returnTo: returnTo,
        message: "That username and password do not match.",
        showUsername: showsUsernameField(auth),
      }),
    );
  }

  // Metered before the hash, because the hash is the cost being abused. The
  // charge is the work this attempt will actually do, which is 32 rounds for a
  // current record and 544 while an older one is verified at both counts.
  const cost = signInCostRounds(auth);
  if (!reserveSignInAttempt(form.user, cost)) {
    return tooManyAttempts(returnTo, auth);
  }

  const match = authenticate(auth, text(form.user), text(form.password));
  if (!match) {
    return htmlResponse(
      401,
      loginPage({
        returnTo: returnTo,
        message: "That username and password do not match.",
        showUsername: showsUsernameField(auth),
      }),
    );
  }

  refundSignInAttempt(form.user, cost);

  try {
    grantAccess(match.admin ? ADMIN_SCOPE : auth.profileId, match.entry);
  } catch (error) {
    owncast.log.error(
      "stream-profiles: could not start a session: " + describeError(error),
    );
    return htmlResponse(
      503,
      loginPage({
        returnTo: returnTo,
        message: "Could not start a session. Check the server log.",
        showUsername: false,
      }),
    );
  }

  return redirectTo(returnTo);
}

function gateLogout(req) {
  // Signing out is a state change, so another site must not be able to end a
  // viewer's session with a link, an image or a prefetch.
  if (!isSameOrigin(req)) {
    return htmlResponse(403, blockedPage("That sign-out did not come from this site."));
  }

  // `req.user` is absent on this plugin's own public routes, so this only
  // revokes the server-side binding when the host supplies an identity. The
  // host strips the Cookie header before the handler runs, which leaves no
  // other way for the plugin to learn which binding to clear. endSession()
  // still expires the browser's copy; see CONTRIBUTING.md for the constraint.
  const user = req.user;
  if (user && user.id) owncast.kv.set(SESSION_PREFIX + user.id, "");
  owncast.auth.endSession();
  return redirectTo("/");
}

// Signing out is a POST. The documented URL still works: it renders a
// one-button confirmation instead of acting on the GET, so no other origin can
// end a viewer's session with a top-level navigation.
function logoutPage() {
  return htmlResponse(
    200,
    "<!doctype html><meta charset=utf-8>" +
      "<meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>Sign out</title>" +
      "<body style='font:15px/1.5 system-ui,sans-serif;background:#0f0f14;color:#efeff1;" +
      "display:grid;place-items:center;min-height:100vh;margin:0;text-align:center'>" +
      "<form method=post action=/auth/logout style='max-width:26rem;padding:1.5rem'>" +
      "<h1 style='font-size:1.1rem'>Sign out of this stream?</h1>" +
      "<p style='color:#b6b3c6'>This browser will be signed out.</p>" +
      "<button type=submit style='padding:.65rem 1rem;border:0;border-radius:8px;" +
      "font:inherit;font-weight:600;color:#fff;background:#2087e2;cursor:pointer'>Sign out</button>" +
      "</form></body>",
  );
}

// The profile-independent admin credential. One at a time, so "set" replaces.
//
// Replacing gives it a new id, which deliberately ends the sessions it issued:
// the reason to change an admin password is usually that it leaked, and a
// sliding session would otherwise keep the holder signed in indefinitely.
function adminAccessAction(body) {
  const action = text(body.action) || "set";

  if (action === "clear") {
    clearAdminEntry();
    owncast.log.info("stream-profiles: owner login removed");
    return jsonResponse(200, { ok: true, adminAccess: null });
  }

  if (action !== "set") {
    return jsonResponse(400, { error: "Unknown action: " + action });
  }

  const user = text(body.user).trim();
  const password = text(body.password);

  if (user === "") {
    return jsonResponse(400, { error: "Enter a username for the owner login." });
  }
  if (user.indexOf(":") !== -1) {
    return jsonResponse(400, { error: "A username cannot contain a colon." });
  }
  if (password === "") {
    return jsonResponse(400, { error: "Enter a password." });
  }

  const salt = newSalt();
  saveAdminEntry({
    id: "admin-" + newSalt().slice(0, 8),
    user: user,
    salt: salt,
    hash: hashPassword(password, salt),
    rounds: ROUNDS,
  });

  owncast.log.info('stream-profiles: owner login set for "' + user + '"');
  return jsonResponse(200, { ok: true, adminAccess: { user: user } });
}

// Credential management for one profile. Passwords arrive here, are hashed
// immediately, and are never written back out: the response carries summaries.
function authAdminAction(body) {
  const id = text(body.id);
  const action = text(body.action) || "add";

  const profile = loadProfiles().find(function (candidate) {
    return candidate.id === id;
  });
  if (!profile) {
    return jsonResponse(404, { error: "Unknown profile: " + (id || "(none)") });
  }

  let entries = loadCredentials(id);

  if (action === "add") {
    const user = text(body.user).trim();
    const password = text(body.password);

    // A colon is Basic auth's separator, so it cannot appear in a username.
    if (user.indexOf(":") !== -1) {
      return jsonResponse(400, { error: "A username cannot contain a colon." });
    }
    if (password === "") {
      return jsonResponse(400, { error: "Enter a password." });
    }
    const duplicate = entries.some(function (entry) {
      return user !== "" && entry.user === user;
    });
    if (duplicate) {
      return jsonResponse(400, {
        error: "That username already exists in this profile.",
      });
    }

    // One salt per profile, reused for every credential it holds. That keeps a
    // check to a single hash regardless of how many entries exist.
    const salt = entries.length ? entries[0].salt : newSalt();
    entries = entries.concat([
      {
        id: newSalt().slice(0, 16),
        user: user,
        salt: salt,
        hash: hashPassword(password, salt),
        rounds: ROUNDS,
      },
    ]);
  } else if (action === "remove") {
    const entryId = text(body.entryId);
    entries = entries.filter(function (entry) {
      return entry.id !== entryId;
    });
  } else if (action === "clear") {
    entries = [];
  } else {
    return jsonResponse(400, { error: "Unknown action: " + action });
  }

  saveCredentials(id, entries);
  owncast.log.info(
    "stream-profiles: credentials for \"" +
      profile.name +
      "\" " +
      action +
      " (" +
      entries.length +
      " total)",
  );

  return jsonResponse(200, {
    ok: true,
    credentials: summarizeCredentials(entries),
  });
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function jsonResponse(status, value) {
  return {
    status: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(value),
  };
}

function parseBody(body) {
  const data = parseJson(body);
  return data && typeof data === "object" ? data : null;
}

function statePayload() {
  const stored = storedProfiles();
  const admin = loadAdminEntry();
  return {
    profiles: profilesForClient(loadProfiles()),
    activeId: loadActiveId(),
    owncastUrl: baseUrl(),
    seeded: stored === undefined || stored === null || stored === "",
    // Username only, like every other credential summary.
    adminAccess: admin ? { user: admin.user } : null,
  };
}

// Profiles go to the browser with image presence flags, never with image data.
// Credentials travel as a summary: usernames and which entries are
// password-only, never a salt or a hash.
function profilesForClient(profiles) {
  return profiles.map(function (profile) {
    const out = {};
    for (const key in profile) {
      if (Object.prototype.hasOwnProperty.call(profile, key)) out[key] = profile[key];
    }
    out.logo = Boolean(loadImage(profile.id, "logo"));
    out.favicon = Boolean(loadImage(profile.id, "favicon"));
    out.credentials = summarizeCredentials(loadCredentials(profile.id));
    return out;
  });
}

// Deletes the stored images of any profile that disappeared from the list.
function pruneImages(before, after) {
  const keep = {};
  for (let i = 0; i < after.length; i += 1) keep[after[i].id] = true;
  for (let i = 0; i < before.length; i += 1) {
    if (!keep[before[i].id]) deleteImages(before[i].id);
  }
}

// Reads the optional password from a parsed request body. Returns an empty
// string when absent so callers can branch on usablePassword().
function bodyPassword(body) {
  return body && typeof body.password === "string" ? body.password : "";
}

module.exports = definePlugin({
  onHttpRequest(req) {
    const path = typeof req.path === "string" ? req.path : "";

    // Viewer gate first: these are the only paths a visitor reaches without a
    // session, and they must not collide with the admin surface below.
    if (req.method === "GET" && (path === "/" || path === "")) {
      return gateEntry(req);
    }

    // The form posts back to the URL that rendered it, with no `action`, so the
    // plugin does not have to guess whether the host stripped a trailing slash.
    // `/auth/login` stays as a stable endpoint for scripts and tests.
    if (req.method === "POST" && (path === "/" || path === "")) {
      return gateLogin(req);
    }

    if (req.method === "POST" && path === "/auth/login") {
      return gateLogin(req);
    }

    if (req.method === "GET" && path === "/auth/logout") {
      return logoutPage();
    }

    if (req.method === "POST" && path === "/auth/logout") {
      return gateLogout(req);
    }

    if (req.method === "GET" && path === "/admin/api/state") {
      return jsonResponse(200, statePayload());
    }

    // Credentials for one profile. The host already gates /admin/*, so no
    // admin password is involved here.
    if (req.method === "GET" && path === "/admin/api/auth") {
      const query = req.query || {};
      const id = typeof query.id === "string" ? query.id : "";
      const known = loadProfiles().some(function (profile) {
        return profile.id === id;
      });
      if (!known) {
        return jsonResponse(404, { error: "Unknown profile: " + (id || "(none)") });
      }
      return jsonResponse(200, {
        credentials: summarizeCredentials(loadCredentials(id)),
      });
    }

    if (req.method === "POST" && path === "/admin/api/auth") {
      return authAdminAction(parseBody(req.body) || {});
    }

    if (req.method === "POST" && path === "/admin/api/profiles") {
      const body = parseBody(req.body);
      if (!body || !Array.isArray(body.profiles)) {
        return jsonResponse(400, {
          error: "Expected a JSON body with a profiles array.",
        });
      }

      const profiles = normalizeProfiles(body.profiles);
      const requested = typeof body.activeId === "string" ? body.activeId : "";
      const activeId = profiles.some((profile) => profile.id === requested)
        ? requested
        : "";

      pruneImages(loadProfiles(), profiles);
      pruneCredentials(loadProfiles(), profiles);
      owncast.kv.set(PROFILES_KEY, JSON.stringify(profiles));
      owncast.kv.set(ACTIVE_KEY, activeId);

      return jsonResponse(200, {
        profiles: profilesForClient(profiles),
        activeId: activeId,
      });
    }

    // Image upload/read. Plugin-local storage, so no admin password is needed;
    // the host already gates these paths behind the admin session.
    if (req.method === "POST" && path === "/admin/api/image") {
      const body = parseBody(req.body);
      const id = body && typeof body.id === "string" ? body.id : "";
      const field = body && typeof body.field === "string" ? body.field : "";
      const data = body && typeof body.data === "string" ? body.data : "";

      const known = loadProfiles().some(function (profile) {
        return profile.id === id;
      });
      if (!known) {
        return jsonResponse(404, { error: "Unknown profile: " + (id || "(none)") });
      }

      const problem = validateImageData(field, data);
      if (problem) return jsonResponse(400, { error: problem });

      storeImage(id, field, data);
      return jsonResponse(200, { ok: true, present: Boolean(data) });
    }

    if (req.method === "GET" && path === "/admin/api/image") {
      const query = req.query || {};
      const id = typeof query.id === "string" ? query.id : "";
      const field = typeof query.field === "string" ? query.field : "";

      if (!IMAGE_FIELDS[field]) {
        return jsonResponse(400, { error: "Unknown image field: " + field });
      }

      return jsonResponse(200, { data: loadImage(id, field) });
    }

    // The stock images this plugin can apply, so the editor can show what an
    // "empty" image field actually does. A field without an asset has a native
    // Owncast reset instead, and reports `reset: true`.
    if (req.method === "GET" && path === "/admin/api/defaults") {
      return jsonResponse(200, {
        logo: defaultImageData("logo"),
        favicon: defaultImageData("favicon"),
        resets: { favicon: Boolean(IMAGE_FIELDS.favicon.reset) },
      });
    }

    if (req.method === "POST" && path === "/admin/api/apply") {
      const body = parseBody(req.body);
      const id = body && typeof body.id === "string" ? body.id : "";
      const profiles = loadProfiles();
      const profile = profiles.find((candidate) => candidate.id === id);

      if (!profile) {
        return jsonResponse(404, { error: "Unknown profile: " + (id || "(none)") });
      }

      const result = applyProfile(profile, bodyPassword(body));
      if (!result.ok) {
        // Never log or echo the password, and keep the message free of it.
        owncast.log.error("stream-profiles: " + result.error);
        return jsonResponse(result.status || 502, {
          error: result.error,
          code: result.code,
          results: result.results,
        });
      }

      owncast.log.info('stream-profiles: applied "' + profile.name + '"');
      return jsonResponse(200, {
        ok: true,
        activeId: profile.id,
        results: result.results,
        pending: result.pending || [],
      });
    }

    if (req.method === "POST" && path === "/admin/api/server") {
      const result = readServerProfile(bodyPassword(parseBody(req.body)));
      if (!result.ok) {
        return jsonResponse(result.status || 200, {
          ok: false,
          code: result.code,
          error: result.error,
        });
      }
      return jsonResponse(200, { ok: true, profile: result.profile });
    }

    // The profile-independent admin credential. Separate from the per-profile
    // endpoint above so it can never be reached through a profile id.
    if (req.method === "GET" && path === "/admin/api/admin-access") {
      const entry = loadAdminEntry();
      return jsonResponse(200, { adminAccess: entry ? { user: entry.user } : null });
    }

    if (req.method === "POST" && path === "/admin/api/admin-access") {
      return adminAccessAction(parseBody(req.body) || {});
    }

    return jsonResponse(404, { error: "Not found" });
  },

  // Called by the host on a viewer's page load, for the active gate plugin
  // only. Fails closed: an unreadable session is ended, not honoured.
  onAuthCheck(req) {
    const user = req && req.user;
    if (!user || !user.id) return authCheck.deny("no viewer identity");

    const binding = hasSessionBinding(user.id);
    const parts = binding === "" ? [] : binding.split("|");
    const auth = activeAuth();

    // The admin credential is the lockout escape hatch, so its sessions are
    // checked before anything profile-related: they must survive a profile
    // switch and a missing profile, which is the whole point of it existing.
    if (parts[0] === ADMIN_SCOPE) {
      if (!auth.admin || auth.admin.id !== parts[1]) {
        return authCheck.deny("the owner login was removed or replaced");
      }
      return authCheck.refresh({ ttl: SESSION_RENEW_SECONDS });
    }

    if (!auth.known) {
      return authCheck.deny("no profile is active");
    }

    // An open profile admits anyone, so there is nothing to revoke and no
    // reason to end a session we cannot attribute: the viewer would be granted
    // a new one on the next request anyway.
    if (!auth.entries.length) return authCheck.ok();

    if (binding === "") {
      return authCheck.deny("session does not belong to a credential");
    }

    if (parts[0] !== auth.profileId) {
      return authCheck.deny("a different profile is active");
    }

    const stillExists = auth.entries.some(function (entry) {
      return entry.id === parts[1];
    });
    if (!stillExists) return authCheck.deny("that credential was removed");

    // Still entitled: renew rather than merely accept. Without this the host's
    // fixed expiry logs out a viewer who has done nothing wrong but not reloaded
    // for a day.
    return authCheck.refresh({ ttl: SESSION_RENEW_SECONDS });
  },
});
