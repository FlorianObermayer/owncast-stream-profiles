---
description: "Use when writing interface text for operators — README.md, INSTRUCTIONS.md, and any string a non-developer reads. Covers the no-implementation-details rule."
name: "User-facing copy"
applyTo: ["README.md", "INSTRUCTIONS.md"]
---

# Copy for operators

These files are read by someone who wants their stream to work, not by someone
who wants to know how it works. `CONTRIBUTING.md`, code comments and commit
messages are for maintainers and are expected to be technical.

## Never in operator-facing text

Each of these was in the copy at some point and had to be removed:

| Don't | Do |
| --- | --- |
| "stored as a salted SHA-256 hash" | "never stored or shown in readable form" |
| "Owncast's admin API needs your admin password" | "Enter your Owncast admin password to apply these settings." |
| "`auth.gate`", "`users.register`", permission names | describe the outcome: "the site's sign-in", "the login" |
| "`/hls/*` stays public", "`/api/status`" | "the video itself stays public", "the 'is it live' status" |
| "the response header a browser needs is filtered" | "a player app cannot use a sign-in page" |
| storage keys, endpoint paths, header names | nothing — the operator cannot act on them |
| the address a request was sent to | put it in the server log; the operator needs the next step |

## Accuracy over comfort

Name a thing for what it grants. The profile-independent credential was "Admin
access" and implied privileges it does not have; it is "Owner login", and the hint
says explicitly that it grants no more than any viewer.

Say when a limitation changes what the operator should do, in the same place they
read the feature. The default access mode protects the page but not the video, so
that belongs next to the viewer-access section, not in a footnote — and it should
be stated as the consequence ("anyone with a copy of the video link can still
watch"), not as the mechanism.

## Shape

- Lead with what the operator does. Setup first, then the one rule they need, then
  the exceptions.
- Short paragraphs. A table only to compare options.
- No marketing adjectives, no "simply", no "powerful", no overview paragraph that
  restates the title.
- Every claim must be true of the current release. If a release turns out to have
  misled someone, fix the copy in the same release that fixes the behaviour, and
  mention it in the release notes.

## Structural constraint

`INSTRUCTIONS.md` is rendered inline inside Owncast's admin, not in an iframe.
A relative link 404s, an absolute link navigates the whole admin away. Keep it
self-contained; `scripts/check-release.mjs` enforces absolute links.

`README.md` is the landing page and may link to `INSTRUCTIONS.md`. Never the
reverse.
