# Stream Profiles

An Owncast plugin that stores the settings describing a broadcast as a named
profile and switches between them. Ships as a `.ocpkg` and runs in Owncast's
sandboxed plugin runtime.

This file holds the working agreements for the whole repository. The
`.github/instructions/` files add detail for specific file types, and
`.github/skills/release-plugin/` covers shipping a version.

## The habit that matters most

**Verify against Owncast's source, not its documentation.** Nearly every correct
decision in this project came from reading the Go source; nearly every wrong one
came from assuming. Behaviour that is only visible in code, and that has already
bitten us:

- A plugin cannot prompt for HTTP Basic auth: the response-header allowlist has no
  `WWW-Authenticate`, so a 401 challenge is dropped.
- `.js` and `.css` are served with a 30-day `max-age`, so an unchanged asset URL
  means the browser keeps running the previous release.
- Owncast ignores a suggested-username list with fewer than 10 entries.
- A gate session's TTL is absolute, and revocation is only noticed on a page load.

When a claim about Owncast matters, read `owncast/owncast` (or
`owncast/plugin-sdk`) and quote the file. Do not write "should work".

**Measure rather than estimate.** The SHA-256 round count is 512 because 4096 was
measured to exceed the 5 s handler budget. If a number is load-bearing, time it.

## Writing

Two audiences, and they must not be mixed:

| Audience | Where | Rule |
| --- | --- | --- |
| Operators | `README.md`, `INSTRUCTIONS.md`, every string in `public/admin/` | What it does and what to click. No implementation. |
| Maintainers | `CONTRIBUTING.md`, code comments, commit messages, PR bodies | Mechanisms, constraints, and why. |

For the first group, these are the failures to avoid, all of which were fixed
after review:

- No permission names, endpoint paths, storage keys, header names, or hashing
  details. "Passwords are never stored or shown in readable form" is fine;
  "stored as a salted SHA-256 hash" is not.
- No internal component names. "Owncast's admin API" is jargon; say "your admin
  password".
- Name a thing for what it grants, not what it aspires to. It was called "Admin
  access" and had to be renamed to "Owner login" because it grants no privileges.
- Errors say what to do, not what failed internally. The address that could not be
  reached belongs in the server log, not in the operator's face.
- Describe what an operator observes, not the machinery: "the video stays public",
  not "`/hls/*` is exempt".

Write fewer words. Short paragraphs, no marketing adjectives, no filler
transitions. A table is for comparing options; prose is for explaining behaviour.

## Code

- Comments explain *why*. A comment restating the code is noise. Where a design
  looks arbitrary (a round count, a deliberate ordering, a stored key that no
  longer matches its label), say what would break if it changed.
- Plain ES2020 inside the sandbox, and plain DOM in the admin page. There is no
  build step for `public/admin/` on purpose: keep it three static files.
- No new runtime dependency without a reason. Each one is a supply-chain surface,
  and `scripts/check-release.mjs` treats a widened permission set as a
  user-visible change.
- Default to not touching what the operator configured. A field added to a
  released plugin is skipped for profiles captured before it existed, because
  normalising fills in an empty default that would overwrite a real setting.
- Keep compatibility that costs nothing: storage keys and session scopes keep
  their names after a rename, so saved credentials and live sessions survive.
- Hand-written crypto is pinned by known-answer tests. A subtle error there would
  only ever surface as "wrong password" for every viewer.

## Workflow

- `main` is protected. Branch, open a pull request, wait for **Test and package**
  and **Review dependency changes**, then squash-merge. Never push to `main`.
- Every behaviour change gets a scenario in `__tests__/`. A fix that cannot be
  reproduced as a failing scenario first is not yet understood.
- UI changes get checked in a browser. Markup that looks right is not evidence.
- Bump with `npm run version:bump patch|minor|major`. Never `npm version`, which
  updates two of the four version sites.
- Merging a version bump is the release; nothing is tagged by hand.

## Reporting

State what was verified and what was not. If a path could not be exercised (the
dev server does not wire `users.register`, so sign-in cannot be tested locally),
say so plainly instead of implying coverage. Flag remaining gaps and irreversible
consequences — a published version, a permission change that forces re-approval,
an immutable tag — before acting on them.
