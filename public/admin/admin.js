// Admin page for stream-profiles. Runs in the plugin's sandboxed iframe, so
// every request is same-origin and already authenticated by the host (the
// paths are declared under manifest.admin.pages).

(function () {
  "use strict";

  const API = {
    state: "./api/state",
    profiles: "./api/profiles",
    apply: "./api/apply",
    server: "./api/server",
    image: "./api/image",
    defaults: "./api/defaults",
  };

  // Fields whose change is not visible immediately. Nothing here needs an
  // Owncast restart (there is no restart API); these are values Owncast reads
  // later than the write. Mirrors ACTIVATION_NOTES in src/plugin.js.
  const ACTIVATION_LABELS = {
    "next-stream": "Applies at next stream start",
    "directory-ping": "Listed within ~4 minutes",
    "new-connections": "Applies to new chat connections",
    "browser-cache": "Browsers may cache the old image",
  };

  // Mirrors FIELD_SPECS in src/plugin.js. `type` picks the widget:
  //
  //   text / textarea  free text, `hint` states the expected format
  //   list             comma-separated input, stored as an array
  //   boolean          checkbox
  //   enum             select over `options`
  //   actions          repeating rows for Owncast external actions
  //   socials          repeating rows for Owncast social handles
  //
  // `local: true` marks a field the plugin keeps for itself and never sends
  // to Owncast, so it gets no apply checkbox.
  const FIELD_DEFS = [
    {
      key: "name",
      label: "Profile name",
      type: "text",
      local: true,
      hint: "Only used inside this plugin, never sent to the server.",
    },

    {
      key: "streamTitle",
      label: "Stream title",
      type: "text",
      group: "Content",
      hint: "Plain text. Shown next to the player while you are live.",
    },
    {
      key: "summary",
      label: "About text",
      type: "textarea",
      rows: 3,
      group: "Content",
      hint: "Markdown is supported.",
    },
    {
      key: "welcomeMessage",
      label: "Welcome message",
      type: "textarea",
      rows: 2,
      group: "Content",
      hint: "Markdown is supported. Shown above the page content.",
    },
    {
      key: "offlineMessage",
      label: "Offline message",
      type: "textarea",
      rows: 4,
      group: "Content",
      hint: "Markdown is supported. Shown while you are not streaming.",
    },
    {
      key: "extraPageContent",
      label: "Custom page content",
      type: "textarea",
      rows: 6,
      group: "Content",
      hint: "Markdown is supported. Extra block below the stream.",
    },
    {
      key: "serverName",
      label: "Server name",
      type: "text",
      group: "Content",
      hint:
        "Plain text. Site name and page title; changing it also updates your " +
        "fediverse profile.",
    },
    {
      key: "tags",
      label: "Tags",
      type: "list",
      group: "Content",
      hint: "Comma-separated, e.g. familie, event. Shown on the page.",
    },
    {
      key: "federationGoLiveMessage",
      label: "Fediverse go-live message",
      type: "textarea",
      rows: 2,
      group: "Content",
      activation: "next-stream",
      hint: "Plain text. Posted to followers when the stream starts.",
    },

    {
      key: "nsfw",
      label: "Mark as NSFW",
      type: "boolean",
      group: "Discoverability",
      hint: "Blurs the preview and warns viewers.",
    },
    {
      key: "directoryEnabled",
      label: "List in the Owncast directory",
      type: "boolean",
      group: "Discoverability",
      activation: "directory-ping",
      hint: "Turn off for private or family-only streams.",
    },
    {
      key: "disableSearchIndexing",
      label: "Opt out of search indexing",
      type: "boolean",
      group: "Discoverability",
    },
    {
      key: "autoplay",
      label: "Autoplay",
      type: "enum",
      options: ["always", "sound-only", "off"],
      optionLabels: {
        always: "Autoplay",
        "sound-only": "Autoplay, sound on if the browser allows",
        off: "Viewer presses play",
      },
      group: "Discoverability",
      hint: "How playback starts when a viewer opens the page.",
    },

    {
      key: "chatDisabled",
      label: "Disable chat",
      type: "boolean",
      group: "Chat",
      activation: "new-connections",
      hint: "Hides the chat panel entirely.",
    },
    {
      key: "chatJoinMessagesEnabled",
      label: "Join and part messages",
      type: "boolean",
      group: "Chat",
      hint: "Announce viewers joining and leaving chat.",
    },
    {
      key: "hideViewerCount",
      label: "Hide viewer count",
      type: "boolean",
      group: "Chat",
    },

    {
      key: "customStyles",
      label: "Custom CSS",
      type: "textarea",
      rows: 5,
      mono: true,
      group: "Advanced",
      hint: "CSS injected into the viewer page.",
    },
    {
      key: "customJavascript",
      label: "Custom JavaScript",
      type: "textarea",
      rows: 5,
      mono: true,
      group: "Advanced",
      hint: "JavaScript injected into the viewer page.",
    },
    {
      key: "videoServingEndpoint",
      label: "Video serving endpoint",
      type: "text",
      group: "Advanced",
      activation: "next-stream",
      hint:
        "Where HLS segments are fetched from, e.g. an S3/CDN base URL. " +
        "Leave empty to serve from Owncast itself.",
    },
    {
      key: "socialHandles",
      label: "Social links",
      type: "socials",
      group: "Advanced",
      hint: "Platform key plus URL. Leave the platform blank to use a custom name.",
    },
    {
      key: "externalActions",
      label: "Action buttons",
      type: "actions",
      group: "Advanced",
      hint: "Buttons under the stream. A label plus either a URL or inline HTML.",
    },
    {
      key: "logo",
      label: "Logo",
      type: "image",
      group: "Branding",
      activation: "browser-cache",
      serverPath: "/logo",
      hint:
        "PNG, JPEG, SVG or GIF. Empty applies Owncast's own logo: there is no " +
        "\"remove logo\" call, so the stock file is uploaded instead.",
    },
    {
      key: "favicon",
      label: "Favicon",
      type: "image",
      group: "Branding",
      activation: "browser-cache",
      serverPath: "/favicon.ico",
      hint:
        "PNG or ICO, up to 200 KB. Empty resets the favicon to Owncast's " +
        "default.",
    },
  ];

  // Fields a new profile starts out not touching. These are site or
  // infrastructure settings: rewriting them from a stream profile is legal,
  // but doing it by surprise clears a theme, a CDN host, or the chat policy.
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

  const state = {
    profiles: [],
    activeId: "",
    owncastUrl: "",
    // Stock images to show for an empty image field. `defaultResets.favicon`
    // means Owncast resets it natively, so there is nothing to preview.
    defaultImages: { logo: "", favicon: "" },
    defaultResets: { favicon: false, logo: false },
  };

  // The admin password is never sent to the plugin for storage. It is cached
  // in sessionStorage only when the admin ticks "keep it in this browser tab",
  // so it dies with the tab. Same-origin script could read it, but that is the
  // same trust boundary as the admin UI itself: an XSS there already owns the
  // session. Nothing here writes it to Owncast's database.
  const PASSWORD_KEY = "stream-profiles:admin-password";

  let dirty = false;
  let busy = false;
  let passwordResolver = null;

  // Image bytes live in the plugin's key/value store, not in the profile JSON,
  // so a profile save stays small. `imageCache` holds what the preview needs
  // (data URIs); `pendingImages` holds edits to flush after the next save.
  const IMAGE_KEYS = ["logo", "favicon"];
  const imageCache = {};
  const pendingImages = {};
  const imageLoading = {};
  const imageListeners = {};

  const els = {
    profiles: document.getElementById("profiles"),
    status: document.getElementById("status"),
    connection: document.getElementById("connection"),
    target: document.getElementById("target"),
    empty: document.getElementById("empty"),
    save: document.getElementById("save"),
    add: document.getElementById("add"),
    capture: document.getElementById("capture"),
    test: document.getElementById("test"),
    reload: document.getElementById("reload"),
    forget: document.getElementById("forget"),
    dialog: document.getElementById("password-dialog"),
    form: document.getElementById("password-form"),
    dialogTitle: document.getElementById("password-title"),
    dialogReason: document.getElementById("password-reason"),
    dialogError: document.getElementById("password-error"),
    passwordInput: document.getElementById("password-input"),
    passwordRemember: document.getElementById("password-remember"),
    passwordCancel: document.getElementById("password-cancel"),
  };

  // -------------------------------------------------------------------------
  // Password cache and prompt
  // -------------------------------------------------------------------------

  function cachedPassword() {
    try {
      return window.sessionStorage.getItem(PASSWORD_KEY) || "";
    } catch (error) {
      // Storage can be blocked in a sandboxed frame; fall back to prompting.
      return "";
    }
  }

  function cachePassword(password) {
    try {
      window.sessionStorage.setItem(PASSWORD_KEY, password);
    } catch (error) {
      // Ignore: the password still works for this call.
    }
  }

  function forgetPassword() {
    try {
      window.sessionStorage.removeItem(PASSWORD_KEY);
    } catch (error) {
      // Nothing to clear.
    }
  }

  // Resolves with the entered password, or "" when the admin cancels.
  function askPassword(reason) {
    if (passwordResolver) {
      // A dialog is already open; let the existing one win.
      return Promise.resolve("");
    }

    els.dialogTitle.textContent = "Admin password";
    els.dialogReason.textContent = reason;
    els.dialogError.hidden = true;
    els.dialogError.textContent = "";
    els.passwordInput.value = "";
    els.passwordRemember.checked = true;

    if (typeof els.dialog.showModal === "function") {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute("open", "");
    }
    els.passwordInput.focus();

    return new Promise(function (resolve) {
      passwordResolver = resolve;
    });
  }

  function closePasswordDialog(value) {
    const resolve = passwordResolver;
    passwordResolver = null;

    if (typeof els.dialog.close === "function") {
      els.dialog.close();
    } else {
      els.dialog.removeAttribute("open");
    }

    els.passwordInput.value = "";
    if (resolve) resolve(value);
  }

  // Returns a password, using the cached one when present. Prompts otherwise.
  async function resolvePassword(reason) {
    const cached = cachedPassword();
    if (cached) return cached;
    return askPassword(reason);
  }

  // Runs fn(password), re-prompting once if the server rejects the password.
  async function callWithRetry(password, fn) {
    try {
      return await fn(password);
    } catch (error) {
      if (!error || error.code !== "unauthorized") throw error;

      // The cached password was wrong or changed. Drop it and ask again.
      forgetPassword();
      render();
      const fresh = await askPassword("That password was rejected. Try again.");
      if (!fresh) return null;
      return fn(fresh);
    }
  }

  // Resolves a password (prompting when nothing is cached) and runs fn with it.
  // Returns null when the admin cancels.
  async function withPassword(reason, fn) {
    const password = await resolvePassword(reason);
    if (!password) return null;
    return callWithRetry(password, fn);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function slugify(value) {
    const slug = String(value || "")
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

  function uniqueId(base) {
    const taken = {};
    state.profiles.forEach(function (profile) {
      taken[profile.id] = true;
    });
    if (!taken[base]) return base;
    let index = 2;
    while (taken[base + "-" + index]) index += 1;
    return base + "-" + index;
  }

  function defaultFieldValue(def) {
    if (def.type === "list" || def.type === "actions" || def.type === "socials") {
      return [];
    }
    if (def.type === "boolean" || def.type === "image") return false;
    if (def.type === "enum") return (def.options && def.options[0]) || "";
    return "";
  }

  function newProfile(seed, options) {
    const source = seed || {};
    const settings = options || {};
    const name = source.name || "New profile";

    const profile = {
      id: uniqueId(slugify(name)),
      name: name,
      skip: (settings.skip || DEFAULT_SKIPPED).slice(),
    };

    FIELD_DEFS.forEach(function (def) {
      if (def.local) return;
      const value = source[def.key];
      if (value === undefined) {
        profile[def.key] = defaultFieldValue(def);
      } else if (Array.isArray(value)) {
        profile[def.key] = JSON.parse(JSON.stringify(value));
      } else {
        profile[def.key] = value;
      }
    });

    return profile;
  }

  function setStatus(message, kind) {
    els.status.textContent = message || "";
    els.status.className = "sp-status" + (kind ? " " + kind : "");
  }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    els.save.disabled = false;
    els.save.textContent = "Save changes";
  }

  // Only used to keep a runaway HTML error page from swamping the status line.
  // Everything below this length is shown verbatim.
  const MAX_ERROR_CHARS = 4000;

  function describeResponseBody(raw) {
    const body = String(raw || "").replace(/\s+/g, " ").trim();
    if (!body) return "";
    return body.length > MAX_ERROR_CHARS
      ? body.slice(0, MAX_ERROR_CHARS) + "…"
      : body;
  }

  async function request(path, body) {
    const options = { method: body === undefined ? "GET" : "POST", headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      // Offline, blocked by the sandbox, or the response was cut off.
      throw new Error("Request to " + path + " failed: " + error.message);
    }

    // Read once as text, then try JSON. A 413 from the host is plain text or
    // HTML, not JSON, and the body is the only thing that says what happened.
    let raw = "";
    try {
      raw = await response.text();
    } catch (error) {
      raw = "";
    }

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const detail =
        (data && (data.error || data.message)) || describeResponseBody(raw);

      // The plugin's own JSON errors are already complete sentences; a raw
      // gateway body is not, so label it with the status.
      const message = data && detail
        ? detail
        : "HTTP " +
          response.status +
          (response.statusText ? " " + response.statusText : "") +
          (detail ? ": " + detail : " (no response body)");

      const error = new Error(message);
      error.code = data && data.code;
      error.status = response.status;
      error.results = data && data.results;
      throw error;
    }

    return data || {};
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderBanner() {
    if (cachedPassword()) {
      els.connection.hidden = true;
      els.connection.textContent = "";
      return;
    }

    els.connection.hidden = false;
    els.connection.className = "sp-banner";
    els.connection.textContent =
      "Applying a profile or reading the server settings will ask for your " +
      "Owncast admin password. Leave \"keep it\" ticked and it is remembered " +
      "for this tab only.";
  }

  function renderProfile(profile) {
    const card = document.createElement("details");
    card.className = "sp-card";
    card.dataset.id = profile.id;
    card.open = state.profiles.length === 1;

    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.textContent = profile.name || profile.id;
    summary.appendChild(title);

    if (profile.id === state.activeId) {
      const badge = document.createElement("span");
      badge.className = "sp-badge";
      badge.textContent = "Active";
      summary.appendChild(badge);
    }

    if (profile.streamTitle && profile.streamTitle !== profile.name) {
      const preview = document.createElement("span");
      preview.className = "sp-hint";
      preview.textContent = profile.streamTitle;
      summary.appendChild(preview);
    }

    card.appendChild(summary);

    const actions = document.createElement("div");
    actions.className = "sp-row";

    actions.appendChild(
      makeButton("Apply now", "apply-profile", "", function () {
        applyProfile(profile);
      })
    );
    actions.appendChild(
      makeButton("Duplicate", "duplicate-profile", "secondary", function () {
        duplicateProfile(profile);
      })
    );

    const spacer = document.createElement("span");
    spacer.className = "sp-spacer";
    actions.appendChild(spacer);

    actions.appendChild(
      makeButton("Delete", "delete-profile", "secondary", function () {
        deleteProfile(profile);
      })
    );

    card.appendChild(actions);

    let lastGroup = "";

    FIELD_DEFS.forEach(function (def) {
      if (def.group && def.group !== lastGroup) {
        const heading = document.createElement("h3");
        heading.className = "sp-group";
        heading.textContent = def.group;
        card.appendChild(heading);
        lastGroup = def.group;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "sp-field";

      const inputId = "f-" + profile.id + "-" + def.key;

      const head = document.createElement("div");
      head.className = "sp-field-head";

      let toggle = null;
      if (!def.local) {
        toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.id = "t-" + inputId;
        toggle.checked = !profile.skip || profile.skip.indexOf(def.key) === -1;
        toggle.title = "Apply this field when the profile is applied";
        head.appendChild(toggle);
      }

      const label = document.createElement("label");
      label.setAttribute("for", inputId);
      label.textContent = def.label;
      head.appendChild(label);

      if (def.activation && ACTIVATION_LABELS[def.activation]) {
        const badge = document.createElement("span");
        badge.className = "sp-activation";
        badge.textContent = ACTIVATION_LABELS[def.activation];
        badge.title =
          "Owncast reads this value later than it is written. No restart is " +
          "involved.";
        head.appendChild(badge);
      }

      wrapper.appendChild(head);

      const control = buildFieldControl(def, profile, inputId, title, markDirty);
      wrapper.appendChild(control);

      if (def.hint) {
        const hint = document.createElement("span");
        hint.className = "sp-hint";
        hint.textContent = def.hint;
        wrapper.appendChild(hint);
      }

      if (toggle) {
        const syncDisabled = function () {
          const included = toggle.checked;

          // The control is either a single input/textarea/select or a
          // container of row inputs, so handle both shapes.
          if (
            control.matches &&
            control.matches("input, textarea, select, button")
          ) {
            control.disabled = !included;
          }

          const nested = control.querySelectorAll
            ? control.querySelectorAll("input, textarea, select, button")
            : [];
          for (let i = 0; i < nested.length; i += 1) {
            nested[i].disabled = !included;
          }

          wrapper.classList.toggle("sp-field-excluded", !included);
        };

        toggle.addEventListener("change", function () {
          const skip = (profile.skip || []).filter(function (key) {
            return key !== def.key;
          });
          if (!toggle.checked) skip.push(def.key);
          profile.skip = skip;
          syncDisabled();
          markDirty();
        });

        syncDisabled();
      }

      card.appendChild(wrapper);
    });

    els.profiles.appendChild(card);
  }

  // -------------------------------------------------------------------------
  // Field widgets
  // -------------------------------------------------------------------------

  const SOCIAL_PLATFORMS = [
    ["fediverse", "Fediverse"],
    ["matrix", "Matrix"],
    ["xmpp", "XMPP"],
    ["bandcamp", "Bandcamp"],
    ["discord", "Discord"],
    ["facebook", "Facebook"],
    ["github", "GitHub"],
    ["gitlab", "GitLab"],
    ["instagram", "Instagram"],
    ["keyoxide", "Keyoxide"],
    ["kofi", "Ko-Fi"],
    ["linkedin", "LinkedIn"],
    ["mastodon", "Mastodon"],
    ["patreon", "Patreon"],
    ["paypal", "Paypal"],
    ["snapchat", "Snapchat"],
    ["soundcloud", "Soundcloud"],
    ["spotify", "Spotify"],
    ["steam", "Steam"],
    ["tiktok", "TikTok"],
    ["twitch", "Twitch"],
    ["twitter", "X"],
    ["youtube", "YouTube"],
    ["odysee", "Odysee"],
    ["lbry", "LBRY"],
    ["liberapay", "LiberaPay"],
    ["bluesky", "BlueSky"],
    ["donate", "Donations"],
    ["follow", "Follow"],
    ["pixelfed", "Pixelfed"],
    ["peertube", "Peertube"],
    ["rss", "RSS"],
    ["tumblr", "Tumblr"],
  ];

  // The platform suggestions live in a datalist so a custom value still works:
  // Owncast accepts any label and simply shows no icon for unknown platforms.
  function platformList() {
    let list = document.getElementById("sp-social-platforms");
    if (list) return list;

    list = document.createElement("datalist");
    list.id = "sp-social-platforms";
    SOCIAL_PLATFORMS.forEach(function (entry) {
      const option = document.createElement("option");
      option.value = entry[0];
      option.label = entry[1];
      list.appendChild(option);
    });
    document.body.appendChild(list);
    return list;
  }

  function buildFieldControl(def, profile, inputId, titleEl, onChange) {
    if (def.type === "boolean") {
      return buildBooleanControl(def, profile, inputId, onChange);
    }
    if (def.type === "enum") {
      return buildEnumControl(def, profile, inputId, onChange);
    }
    if (def.type === "list") {
      return buildListControl(def, profile, inputId, onChange);
    }
    if (def.type === "actions") {
      return buildActionsControl(profile, onChange);
    }
    if (def.type === "socials") {
      return buildSocialsControl(profile, onChange);
    }
    if (def.type === "image") {
      return buildImageControl(def, profile, inputId, onChange);
    }
    return buildTextControl(def, profile, inputId, titleEl, onChange);
  }

  // -------------------------------------------------------------------------
  // Image fields
  //
  // The plugin cannot read image bytes (Owncast only reports the file path),
  // but this page shares an origin with Owncast, so it can fetch /logo and
  // /favicon.ico directly and hand the plugin a data URI.
  // -------------------------------------------------------------------------

  const imageEls = {};
  const imageCaptions = {};
  const imageRefreshers = {};

  // Mirrors IMAGE_FIELDS[*].maxChars in src/plugin.js. Checked here as well so
  // an oversized pick fails in the dialog with the real reason, instead of
  // costing a round trip that the host would answer with a bare 413.
  const IMAGE_LIMITS = { logo: 700 * 1024, favicon: 300 * 1024 };

  function imageLimitMessage(field, length) {
    return (
      "Image is too large: " +
      Math.round(length / 1024) +
      " KB of data, the limit for " +
      field +
      " is " +
      Math.round((IMAGE_LIMITS[field] || 0) / 1024) +
      " KB."
    );
  }

  // Applies an image to the profile, refusing anything the server would reject.
  function adoptImage(profile, field, data, onChange) {
    const limit = IMAGE_LIMITS[field] || 0;
    if (data && limit && data.length > limit) {
      setStatus(imageLimitMessage(field, data.length), "error");
      return false;
    }

    setImage(profile, field, data, onChange);
    return true;
  }

  function cacheKey(profile, field) {
    return profile.id + ":" + field;
  }

  function currentImage(profile, field) {
    const key = cacheKey(profile, field);
    if (key in pendingImages) return pendingImages[key];
    return imageCache[key] || "";
  }

  function setImage(profile, field, data, onChange) {
    const key = cacheKey(profile, field);
    pendingImages[key] = data;
    imageCache[key] = data;
    refreshImage(key);
    onChange();
  }

  // Repaints one image field: the profile's own image when it has one,
  // otherwise the stock image (or a note that Owncast resets it natively).
  function refreshImage(key) {
    const refresh = imageRefreshers[key];
    if (refresh) refresh();
  }

  function describeFallback(field) {
    if (state.defaultResets[field]) {
      return "No image: applying resets it to Owncast's default.";
    }
    if (state.defaultImages[field]) {
      return "No image: applying uses Owncast's default, shown above.";
    }
    return "No image: applying leaves it untouched.";
  }

  function loadImageFromServer(profile, field, onChange) {
    const key = cacheKey(profile, field);
    if (imageLoading[key]) return Promise.resolve();

    imageLoading[key] = true;
    return fetch("/" + (field === "logo" ? "logo" : "favicon.ico"))
      .then(function (response) {
        if (!response.ok) throw new Error("The server has no " + field + ".");
        return response.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          const reader = new FileReader();
          reader.onload = function () {
            resolve(String(reader.result || ""));
          };
          reader.onerror = function () {
            reject(new Error("Could not read the image."));
          };
          reader.readAsDataURL(blob);
        });
      })
      .then(function (dataURI) {
        delete imageLoading[key];
        if (!dataURI) throw new Error("The image was empty.");
        adoptImage(profile, field, dataURI, onChange);
      })
      .catch(function (error) {
        delete imageLoading[key];
        setStatus(
          "Could not read the current " + field + ": " + error.message,
          "error"
        );
      });
  }

  function buildImageControl(def, profile, inputId, onChange) {
    const key = cacheKey(profile, def.key);
    const wrap = document.createElement("div");
    wrap.className = "sp-image";

    const img = document.createElement("img");
    img.className = "sp-image-preview";
    img.alt = def.label + " preview";
    img.hidden = true;
    img.id = inputId;
    imageEls[key] = img;
    wrap.appendChild(img);

    const caption = document.createElement("p");
    caption.className = "sp-hint sp-image-caption";
    imageCaptions[key] = caption;
    wrap.appendChild(caption);

    const actions = document.createElement("div");
    actions.className = "sp-row";

    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.hidden = true;

    file.addEventListener("change", function () {
      const chosen = file.files && file.files[0];
      if (!chosen) return;

      const reader = new FileReader();
      reader.onload = function () {
        adoptImage(profile, def.key, String(reader.result || ""), onChange);
        file.value = "";
      };
      reader.onerror = function () {
        setStatus("Could not read that file.", "error");
      };
      reader.readAsDataURL(chosen);
    });

    wrap.appendChild(file);

    actions.appendChild(
      makeButton("Choose file", "choose-image", "secondary", function () {
        file.click();
      })
    );

    actions.appendChild(
      makeButton("Use current from server", "use-server-image", "secondary", function () {
        loadImageFromServer(profile, def.key, onChange);
      })
    );

    actions.appendChild(
      makeButton("Use Owncast default", "reset-image", "secondary", function () {
        setImage(profile, def.key, "", onChange);
      })
    );

    wrap.appendChild(actions);

    // Paints the effective image: the profile's own when set, otherwise the
    // stock one this plugin would apply for an empty field.
    imageRefreshers[key] = function () {
      const own = currentImage(profile, def.key);
      const shown = own || state.defaultImages[def.key] || "";

      if (shown) {
        img.src = shown;
        img.hidden = false;
      } else {
        img.removeAttribute("src");
        img.hidden = true;
      }

      wrap.classList.toggle("sp-image-default", !own);
      caption.textContent = own
        ? "Custom image for this profile."
        : describeFallback(def.key);
    };
    imageRefreshers[key]();

    // Fetch what is already stored for this profile, lazily.
    if (profile[def.key] === true && !currentImage(profile, def.key) && !imageLoading[key]) {
      imageLoading[key] = true;
      request(
        API.image +
          "?id=" +
          encodeURIComponent(profile.id) +
          "&field=" +
          encodeURIComponent(def.key)
      )
        .then(function (result) {
          delete imageLoading[key];
          imageCache[key] = result && result.data ? result.data : "";
          refreshImage(key);
        })
        .catch(function () {
          delete imageLoading[key];
        });
    }

    return wrap;
  }

  function buildTextControl(def, profile, inputId, titleEl, onChange) {
    let control;
    if (def.type === "textarea") {
      control = document.createElement("textarea");
      control.rows = def.rows || 3;
      if (def.mono) control.classList.add("sp-mono");
    } else {
      control = document.createElement("input");
      control.type = "text";
      control.autocomplete = "off";
    }

    control.id = inputId;
    control.value = profile[def.key] || "";

    control.addEventListener("input", function () {
      profile[def.key] = control.value;
      if (def.key === "name") {
        titleEl.textContent = control.value || profile.id;
      }
      onChange();
    });

    return control;
  }

  function buildListControl(def, profile, inputId, onChange) {
    const control = document.createElement("input");
    control.type = "text";
    control.id = inputId;
    control.autocomplete = "off";
    control.value = (profile[def.key] || []).join(", ");

    control.addEventListener("input", function () {
      profile[def.key] = control.value
        .split(",")
        .map(function (part) {
          return part.trim();
        })
        .filter(function (part) {
          return part !== "";
        });
      onChange();
    });

    return control;
  }

  function buildBooleanControl(def, profile, inputId, onChange) {
    const wrapper = document.createElement("label");
    wrapper.className = "sp-inline";
    wrapper.setAttribute("for", inputId);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = inputId;
    box.checked = profile[def.key] === true;

    const caption = document.createElement("span");
    caption.textContent = "Enabled";

    box.addEventListener("change", function () {
      profile[def.key] = box.checked;
      onChange();
    });

    wrapper.appendChild(box);
    wrapper.appendChild(caption);
    return wrapper;
  }

  function buildEnumControl(def, profile, inputId, onChange) {
    const select = document.createElement("select");
    select.id = inputId;

    (def.options || []).forEach(function (value) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent =
        (def.optionLabels && def.optionLabels[value]) || value;
      select.appendChild(option);
    });

    select.value = profile[def.key];
    select.addEventListener("change", function () {
      profile[def.key] = select.value;
      onChange();
    });

    return select;
  }

  function smallInput(placeholder, value, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.value = value || "";
    input.addEventListener("input", function () {
      onInput(input.value);
    });
    return input;
  }

  function buildActionsControl(profile, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "sp-rows";

    const rows = document.createElement("div");
    rows.className = "sp-rows-list";
    wrap.appendChild(rows);

    function paint() {
      rows.textContent = "";

      if (!profile.externalActions.length) {
        const empty = document.createElement("p");
        empty.className = "sp-hint";
        empty.textContent = "No action buttons.";
        rows.appendChild(empty);
      }

      profile.externalActions.forEach(function (action, index) {
        const row = document.createElement("div");
        row.className = "sp-row-item";

        row.appendChild(
          smallInput("Button label", action.title, function (value) {
            action.title = value;
            onChange();
          })
        );
        row.appendChild(
          smallInput("https://example.com", action.url, function (value) {
            action.url = value;
            onChange();
          })
        );
        row.appendChild(
          smallInput("Description (optional)", action.description, function (value) {
            action.description = value;
            onChange();
          })
        );

        if (action.html) {
          const note = document.createElement("span");
          note.className = "sp-hint";
          note.textContent = "Uses inline HTML; kept as-is.";
          row.appendChild(note);
        }

        row.appendChild(
          makeButton("Remove", "remove-action", "secondary", function () {
            profile.externalActions.splice(index, 1);
            onChange();
            paint();
          })
        );

        rows.appendChild(row);
      });
    }

    wrap.appendChild(
      makeButton("Add action button", "add-action", "secondary", function () {
        profile.externalActions.push({
          title: "",
          url: "",
          description: "",
          html: "",
          icon: "",
          color: "",
          openExternally: false,
        });
        onChange();
        paint();
      })
    );

    paint();
    return wrap;
  }

  function buildSocialsControl(profile, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "sp-rows";

    const rows = document.createElement("div");
    rows.className = "sp-rows-list";
    wrap.appendChild(rows);

    platformList();

    function paint() {
      rows.textContent = "";

      if (!profile.socialHandles.length) {
        const empty = document.createElement("p");
        empty.className = "sp-hint";
        empty.textContent = "No social links.";
        rows.appendChild(empty);
      }

      profile.socialHandles.forEach(function (handle, index) {
        const row = document.createElement("div");
        row.className = "sp-row-item";

        const platform = smallInput("github", handle.platform, function (value) {
          handle.platform = value;
          onChange();
        });
        platform.setAttribute("list", "sp-social-platforms");
        row.appendChild(platform);

        row.appendChild(
          smallInput("https://example.com/you", handle.url, function (value) {
            handle.url = value;
            onChange();
          })
        );

        row.appendChild(
          makeButton("Remove", "remove-social", "secondary", function () {
            profile.socialHandles.splice(index, 1);
            onChange();
            paint();
          })
        );

        rows.appendChild(row);
      });
    }

    wrap.appendChild(
      makeButton("Add social link", "add-social", "secondary", function () {
        profile.socialHandles.push({ platform: "", url: "", icon: "" });
        onChange();
        paint();
      })
    );

    paint();
    return wrap;
  }

  function makeButton(label, action, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", onClick);
    return button;
  }

  function render() {
    els.profiles.textContent = "";
    els.empty.hidden = state.profiles.length > 0;

    els.save.disabled = busy || !dirty;
    els.save.textContent = dirty ? "Save changes" : "Saved";

    els.target.textContent = state.owncastUrl
      ? "Applies to " + state.owncastUrl
      : "";

    els.forget.hidden = !cachedPassword();

    renderBanner();
    state.profiles.forEach(renderProfile);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function load() {
    busy = true;
    setStatus("Loading…");
    try {
      const data = await request(API.state);
      state.profiles = data.profiles || [];
      state.activeId = data.activeId || "";
      state.owncastUrl = data.owncastUrl || "";

      // Loaded before the first render so image previews are correct without
      // a second pass over the list.
      try {
        const defaults = await request(API.defaults);
        state.defaultImages.logo = defaults.logo || "";
        state.defaultImages.favicon = defaults.favicon || "";
        state.defaultResets.favicon = Boolean(
          defaults.resets && defaults.resets.favicon
        );
      } catch (error) {
        // Preview-only nicety; ignore.
      }
      dirty = Boolean(data.seeded);
      busy = false;
      render();
      setStatus(
        data.seeded
          ? "Starting profiles loaded. Save to keep them."
          : "",
        data.seeded ? "ok" : ""
      );
    } catch (error) {
      busy = false;
      render();
      setStatus("Could not load: " + error.message, "error");
    }
  }

  async function saveProfiles(silent) {
    const local = state.profiles.slice();

    const data = await request(API.profiles, {
      profiles: state.profiles,
      activeId: state.activeId,
    });

    const saved = Array.isArray(data.profiles) ? data.profiles : state.profiles;
    state.profiles = saved;
    state.activeId = data.activeId || "";

    await flushImages(local, saved);

    dirty = false;

    if (!silent) {
      render();
      setStatus("Saved.", "ok");
    }
  }

  // Images are stored per profile id. The server may normalize an id ("A"
  // collides with "a"), so map pending edits positionally onto the saved list.
  async function flushImages(local, saved) {
    const pendingKeys = Object.keys(pendingImages);
    if (!pendingKeys.length) return;

    for (let i = 0; i < local.length; i += 1) {
      const savedProfile = saved[i];
      if (!savedProfile) continue;

      for (let k = 0; k < IMAGE_KEYS.length; k += 1) {
        const field = IMAGE_KEYS[k];
        const oldKey = local[i].id + ":" + field;
        if (!(oldKey in pendingImages)) continue;

        const data = pendingImages[oldKey];
        try {
          await request(API.image, {
            id: savedProfile.id,
            field: field,
            data: data,
          });
        } catch (error) {
          // Say which image failed; the server message explains why.
          throw new Error(
            "Could not store the " +
              field +
              ' of "' +
              (savedProfile.name || savedProfile.id) +
              '": ' +
              error.message
          );
        }

        delete pendingImages[oldKey];
        const newKey = savedProfile.id + ":" + field;
        if (data) imageCache[newKey] = data;
        else delete imageCache[newKey];
        savedProfile[field] = Boolean(data);
      }
    }
  }

  async function save() {
    if (busy) return;
    busy = true;
    setStatus("Saving…");
    try {
      await saveProfiles(true);
      busy = false;
      render();
      setStatus("Saved.", "ok");
    } catch (error) {
      busy = false;
      render();
      setStatus("Save failed: " + error.message, "error");
    }
  }

  async function applyProfile(profile) {
    if (busy) return;

    const reason =
      "Owncast's admin API needs your admin password to change these settings.";
    const password = await resolvePassword(reason);
    if (!password) {
      setStatus("Cancelled.");
      return;
    }

    busy = true;
    render();
    setStatus("Applying " + (profile.name || profile.id) + "…");

    try {
      // Saved only now, so cancelling the password dialog leaves edits alone.
      await saveProfiles(true);
      const result = await callWithRetry(password, function (value) {
        return request(API.apply, { id: profile.id, password: value });
      });

      busy = false;
      render();

      if (!result) {
        setStatus("Cancelled.");
        return;
      }

      state.activeId = result.activeId || profile.id;
      render();

      const pending = Array.isArray(result.pending) ? result.pending : [];
      if (pending.length) {
        const notes = pending.map(function (entry) {
          return entry.label + " " + entry.note;
        });
        setStatus(
          "Applied " + (profile.name || profile.id) + ". Still pending: " + notes.join("; ") + ".",
          "ok"
        );
      } else {
        setStatus("Applied " + (profile.name || profile.id) + ".", "ok");
      }
    } catch (error) {
      busy = false;
      render();
      setStatus("Apply failed: " + error.message + fieldFailureSummary(error.results), "error");
    }
  }

  // The plugin applies fields one request at a time, so a mid-way failure leaves
  // the earlier ones written. Spell that out rather than implying nothing stuck.
  function fieldFailureSummary(results) {
    if (!Array.isArray(results)) return "";

    const failed = results.filter(function (entry) {
      return entry && entry.ok === false;
    });
    if (!failed.length) return "";

    const applied = results.filter(function (entry) {
      return entry && entry.ok === true;
    });

    const lines = failed.map(function (entry) {
      return (
        (entry.label || entry.field) +
        " (HTTP " +
        entry.status +
        "): " +
        (entry.error || "failed")
      );
    });

    return (
      " Failed: " +
      lines.join("; ") +
      ". Fields already applied: " +
      applied.length +
      "."
    );
  }

  function addProfile() {
    const profile = newProfile();
    state.profiles.push(profile);
    dirty = true;
    render();
    const card = els.profiles.querySelector('[data-id="' + profile.id + '"]');
    if (card) {
      card.open = true;
      const input = card.querySelector("input");
      if (input) input.focus();
    }
  }

  function duplicateProfile(profile) {
    const copy = newProfile(
      Object.assign({}, profile, { name: profile.name + " (copy)" }),
      { skip: profile.skip }
    );
    const index = state.profiles.indexOf(profile);
    state.profiles.splice(index + 1, 0, copy);
    dirty = true;
    render();
  }

  function deleteProfile(profile) {
    const label = profile.name || profile.id;
    if (!window.confirm('Delete the profile "' + label + '"?')) return;

    state.profiles = state.profiles.filter(function (candidate) {
      return candidate.id !== profile.id;
    });
    if (state.activeId === profile.id) state.activeId = "";
    dirty = true;
    render();
  }

  async function capture() {
    if (busy) return;
    busy = true;
    render();
    setStatus("Reading the current server settings…");

    const readReason =
      "Owncast's admin API needs your admin password to read the current settings.";

    try {
      const result = await withPassword(readReason, function (password) {
        return request(API.server, { password: password });
      });

      busy = false;
      render();

      if (!result) {
        setStatus("Cancelled.");
        return;
      }
      if (!result.ok) throw new Error(result.error || "The server did not answer");

      // A captured profile describes exactly what the server has right now, so
      // every field is included rather than inheriting the opt-in defaults.
      const captured = newProfile(result.profile, { skip: [] });
      state.profiles.push(captured);
      dirty = true;
      render();
      setStatus("Captured the current settings as a new profile.", "ok");

      // Images come from Owncast's public URLs, read by this page (the plugin
      // cannot fetch binary). Failures are reported by each field.
      IMAGE_KEYS.forEach(function (field) {
        loadImageFromServer(captured, field, markDirty);
      });
    } catch (error) {
      busy = false;
      render();
      setStatus("Capture failed: " + error.message, "error");
    }
  }

  async function testConnection() {
    if (busy) return;
    busy = true;
    render();
    setStatus("Testing…");

    const reason =
      "Owncast's admin API needs your admin password to verify the connection.";

    try {
      const result = await withPassword(reason, function (password) {
        return request(API.server, { password: password });
      });

      busy = false;
      render();

      if (!result) {
        setStatus("Cancelled.");
        return;
      }
      if (!result.ok) {
        setStatus(
          "Connection failed: " + (result.error || "unknown error"),
          "error"
        );
        return;
      }
      setStatus("Connected to Owncast and authenticated.", "ok");
    } catch (error) {
      busy = false;
      render();
      setStatus("Connection failed: " + error.message, "error");
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  els.save.addEventListener("click", save);
  els.add.addEventListener("click", addProfile);
  els.capture.addEventListener("click", capture);
  els.test.addEventListener("click", testConnection);
  els.reload.addEventListener("click", function () {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    load();
  });
  els.forget.addEventListener("click", function () {
    forgetPassword();
    render();
    setStatus("Password forgotten. You will be asked for it again.", "ok");
  });

  els.form.addEventListener("submit", function (event) {
    event.preventDefault();

    const password = els.passwordInput.value;
    if (!password) {
      els.dialogError.textContent = "Enter the admin password.";
      els.dialogError.hidden = false;
      els.passwordInput.focus();
      return;
    }

    if (els.passwordRemember.checked) cachePassword(password);
    else forgetPassword();

    closePasswordDialog(password);
  });

  els.passwordCancel.addEventListener("click", function () {
    closePasswordDialog("");
  });

  // Esc closes the dialog; treat it as a cancel so the pending action unwinds.
  els.dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    closePasswordDialog("");
  });

  window.addEventListener("beforeunload", function (event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  load();
})();
