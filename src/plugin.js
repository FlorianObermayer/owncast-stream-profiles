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
// admin page asks for it, optionally caches it in the browser's sessionStorage,
// and sends it with each request that needs it. Nothing here logs it.
//
// Every endpoint below takes { value: ... } under /api/admin and replies with
// { success, message }, except GET /serverconfig which returns the whole config.

const { definePlugin, owncast } = require("@owncast/plugin-sdk");

const PROFILES_KEY = "profiles";
const ACTIVE_KEY = "active-profile";

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
// doing it by surprise clears a theme, a CDN host, or the chat policy.
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
// Basic auth helpers
//
// The sandbox is QuickJS, not a browser: no btoa. Encode by hand.
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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
    return {
      ok: false,
      status: 0,
      code: "network",
      error: "Could not reach " + url + ": " + describeError(error),
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
function normalizeProfiles(input) {
  if (!Array.isArray(input)) return [];

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
    profile.skip = normalizeSkip(raw.skip);

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
  return normalizeProfiles(parseJson(stored));
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
  return {
    profiles: profilesForClient(loadProfiles()),
    activeId: loadActiveId(),
    owncastUrl: baseUrl(),
    seeded: stored === undefined || stored === null || stored === "",
  };
}

// Profiles go to the browser with image presence flags, never with image data.
function profilesForClient(profiles) {
  return profiles.map(function (profile) {
    const out = {};
    for (const key in profile) {
      if (Object.prototype.hasOwnProperty.call(profile, key)) out[key] = profile[key];
    }
    out.logo = Boolean(loadImage(profile.id, "logo"));
    out.favicon = Boolean(loadImage(profile.id, "favicon"));
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

    if (req.method === "GET" && path === "/admin/api/state") {
      return jsonResponse(200, statePayload());
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

    return jsonResponse(404, { error: "Not found" });
  },
});
