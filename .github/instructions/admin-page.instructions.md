---
description: "Use when editing the plugin's admin page in public/admin/ — no build step, plain DOM, cache-busting, save semantics, and interface text rules."
name: "Admin page"
applyTo: "public/admin/**"
---

# Admin page

Three static files served by the host: `index.html`, `admin.js`, `admin.css`. No
build step, no framework, no bundler. That is a constraint, not an oversight —
keep it that way.

## Implementation notes that have already caused bugs

- **The asset URLs carry `?v=<version>`.** `.js` and `.css` are served with a
  30-day `max-age`, so without a changed query the browser keeps running the
  previous release's script and the page silently lacks whatever was added. The
  query is rewritten by `scripts/set-version.mjs` and verified by
  `scripts/check-release.mjs`; do not remove it as "noise".
- **Saving profiles and saving credentials are different.** Profile edits need
  **Save changes**. Credential changes are written immediately and are not part of
  it, so the top button legitimately reads "Saved" while a credential add is in
  flight. The hint under the section says so.
- **A credential cannot be stored against an unsaved profile.** The server answers
  `404 Unknown profile` for an id it does not know, and a profile added in this
  session exists only in the browser. Credential handlers call `saveProfiles(true)`
  first for that reason — keep that call.
- **Every branch of an async handler re-renders.** Earlier versions only repainted
  on success, so after an error the list, the dirty flag and the summary could
  disagree — which let a failed request look like a saved credential.
- **The dialog needs a real password.** Credential fields are never pre-filled, and
  the page is only ever sent `{ id, user, passwordOnly }` — never a salt or a hash.

## Style

- Plain DOM, functions rather than classes, an IIFE around the whole file.
- Reuse `makeButton`, the `sp-*` class names, and `request()`; it reads the body as
  text before trying JSON so a non-JSON error survives.
- Keep `FIELD_DEFS` and `DEFAULT_SKIPPED` in step with `src/plugin.js`.
- The host injects an admin stylesheet, and it has two real defects worth
  knowing: it styles `label` as a column, and it maps `button.secondary` text to a
  disabled token. The local CSS already works around both — do not "simplify"
  those rules away.

## Text in this page is operator-facing

Hints, buttons, status lines and the password dialog all follow
`user-facing-copy.instructions.md`: no permission names, no endpoint paths, no
hashing details, no internal component names. A hint is often the only explanation
an operator gets, so write it, and write what they should do.

An error in the status line should be actionable. Detailed diagnostics belong in
`owncast.log`, which is where a maintainer looks.
