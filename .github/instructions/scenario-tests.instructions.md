---
description: "Use when writing or fixing scenario tests in __tests__/ — the JSON scenario format, exact HTTP assertions, fixtures, and the traps that cost time."
name: "Scenario tests"
applyTo: "__tests__/**"
---

# Scenario tests

`npm test` builds the plugin, then drives it through the real host runtime with
mocked side effects. No server is needed. There is no test framework to learn: the
scenarios are data.

```json
{
  "name": "the correct password grants a session",
  "given": { "kv": { "active-profile": "a" }, "httpResponses": [ ... ] },
  "events": [ { "http": { "method": "POST", "path": "/auth/login", ... } } ],
  "expect": { "sessionGrants": [ { "userId": "u-a:c1" } ] }
}
```

## Traps that have already cost time

- **`expect.httpRequests` is an exact, ordered list.** Adding a field to the schema
  changes which outbound calls an apply makes, so unrelated scenarios fail. That is
  the assertion working, not a flaky test: update the expectation, and check the
  new call is one you meant to add.
- **Every outbound call needs a canned response.** Without a matching
  `given.httpResponses` entry the request fails and the handler answers 500. One
  glob fixtures the whole batch:
  `{"url": "http://127.0.0.1:8080/api/admin/config/*", "status": 200, "body": "{\"success\":true}"}`.
- **There is no `query` field on an http step.** Put the query string in `path`:
  `"/admin/api/auth?id=a"`.
- **`expect.kv` is partial.** Only the keys listed are checked, so a scenario can
  pass while storage is otherwise wrong.
- **Admin routes need `"authenticated": true`**, or the host answers 401 before the
  plugin runs. Omit it only to assert that gate.
- **The admin password goes in the request body**, never `given.config`.
- Credential hashes depend on `ROUNDS` in `src/auth.js`. Changing it means
  regenerating the fixtures, and the failure looks like "wrong password" rather
  than a hashing change.
- There is no `bodyContains2` or similar. Two string assertions need two steps or
  two scenarios; an invented key is silently ignored, which is worse than failing.

## What a test is for

Write the scenario **first** when fixing a bug, and make it fail for the reason
the report describes. A fix without a reproduction is a guess.

Cover the boundary that was actually wrong, not the happy path that already
worked. The credential-precedence bug shipped because every fixture used a
different password, so the colliding case could not be expressed: when an
invariant depends on two values being equal, test them equal.

Prefer a scenario that pins server behaviour the page depends on — a `404` for an
unknown profile id — over one that restates an implementation detail.
