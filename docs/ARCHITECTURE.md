# Architecture

`dsh-job-cv` is one CV-tailoring workflow behind **two shells**: a DeepSeek
Harness (DSH) web-GUI plugin, and a standalone Model Context Protocol (MCP)
server. Everything specific to _tailoring a CV against a job post_ lives in a
shared core; each shell only bolts a transport and a UI onto it.

```
                    ┌──────────────────────────── shared core ───────────────────────────┐
                    │                                                                    │
  lib/store/*  ─────┤  documents, versions, candidacy folders, master CV, fit, proposals │
  (framework-free)  │  pure normalisation + factory stores, one JSON file per session    │
                    │                                                                    │
  lib/app/     ─────┤  createJobCvApp(deps) — the workflow's operations, once: input     │
  job-cv.js         │  validation, the mid-turn-switch guard, normalize*, the multi-step │
                    │  orchestrations. Typed errors (lib/app/errors.js). No HTTP.        │
                    │                                                                    │
  lib/routes/       │  defineJobCvRoutes(deps) — thin /jobcv/* handlers: parse request → │
  routes.js    ─────┤  call the app → serialize. Takes `deps.app`, or builds one.        │
                    │                                                                    │
  lib/preset/       │  skillInstructions() — the agent-facing contract text, one         │
  preset-seed.js ───┤  generator both shells serve so it can never drift                 │
                    └────────────────────────────────────────────────────────────────────┘
                              ▲                                        ▲
              ┌───────────────┴───────────────┐        ┌───────────────┴────────────────┐
              │   DSH plugin shell            │        │   MCP shell                    │
              │                               │        │                                │
  lib/index.js│  apply(ctx): seeds the `job`  │  bin/  │  dsh-job-cv-mcp.js: mints a     │
              │  preset, mounts the routes on │  lib/  │  session id, starts both below │
  lib/routes/ │  ctx.webServer via            │  mcp/  │                                │
  mount.js    │  mountRouteGroups(ctx, …)     │        │  ui-server.js: one app instance │
              │                               │        │  → the SAME route groups on a  │
  lib/client/*│  the preview: 14 source       │        │  plain http.Server + ui.html   │
  → client.js │  fragments built into one     │        │                                │
              │  IIFE bundle injected into    │        │  server.js: JSON-RPC 2.0 over  │
              │  the DSH web GUI              │        │  stdio; 14 tools call that same │
              │                               │        │  app instance IN-PROCESS       │
              └───────────────────────────────┘        └────────────────────────────────┘
```

## Why the seams are where they are

**`lib/store/*` has no framework dependency and no I/O beyond `node:fs`.** It is
the domain layer without the DDD vocabulary: `normalizeRecord`, `normalizeFit`,
`normalizeProposal` coerce whatever is on disk into a well-formed shape (a file
written by an older build must degrade to sane fields, never throw on every
read); the factory stores (`createDocStore`, `createMasterStore`) own the
per-session write lock, the version history, and the candidacy-folder mirror.
Full documents are stored everywhere — deltas against the master are _derived_
views computed on demand (`lib/store/cv-diff.js`), never persisted patches.

**`lib/app/job-cv.js` is the application service — the workflow once.** Every
operation the plugin exposes as a route and the MCP shell exposes as a tool is
a method here: `saveCv`, `openWorkspace`, `score`, `propose`, `switchCandidacy`…
Input validation, the `assertActiveJob` mid-turn-switch guard, the `normalize*`
coercion and the multi-step orchestrations (workspace upsert, master mirror,
switch sidecar) live in this layer, not in the routes and not duplicated in the
MCP server. It throws the typed errors from `lib/app/errors.js` (`BadRequest`
400, `NotFound` 404, `StaleSave` 409); a route maps them to a status, the MCP
tool surfaces the message.

**`defineJobCvRoutes(deps)` takes injected dependencies, not a DSH context, and
the handlers are thin.** A handler parses the HTTP request and calls one app
method through `respond()` (which serialises the result or maps a typed error).
Three routes stay handler-heavy because they are pure transport, not workflow:
`/jobcv/stream` (SSE), `/jobcv/file` (content-type + CSP), `/jobcv/intake` (a
base64 upload body). The plugin lets the routes build the app from `deps`; the
MCP shell builds it once and passes it as `deps.app`, because its tools call
the same instance in-process — no loopback HTTP.

**`lib/routes/mount.js` is the only DSH-coupled route code.** It registers each
guarded handler on `ctx.webServer`, derives the boot-log summary from the
declarations, and maps a typed error's `.status`. The MCP shell has its own
~15-line equivalent (`buildRouteTable` in `ui-server.js`) that puts the same
guarded handlers into a `Map` an `http.Server` dispatches on.

**The agent contract is generated, not written twice.** `skillInstructions()`
returns the plain-text contract served at `GET /jobcv/skill` (plugin) and as
the `jobcv://skill` resource (MCP). The MCP server's `initialize.instructions`
carries a short version pointing at it.

## The client bundle

`lib/client.js` is **committed** and **generated**: `scripts/build-client.js`
concatenates the ordered fragments in `lib/client/manifest.txt` into one
`window.__ModuleLoader__.load({…})` IIFE. `dsh plugin add <checkout>` installs
the tree as-is, so the built file has to be in git; `npm test` runs
`build-client.js --check` to catch a stale bundle. The fragments share one
scope (functions are called across files), which is why ESLint treats them
specially and why they are not type-checked — `tsconfig.json` excludes them.

## State on disk

Everything lives under `$DSH_HOME/dsh-job-cv/` (default `~/.dsh/dsh-job-cv/`):

| Path                               | What                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sessions/<id>.json`               | the active candidacy for a session — current document, last 10 versions, letter, post, fit, proposal, status tag   |
| `sessions/<id>.jobs/<hash>.json`   | that session's _parked_ candidacies (one per posting), whole records                                               |
| `sessions/lists/<id>.json`         | the parsed jobs pick-list sidecar                                                                                  |
| `master.json`                      | the one master CV, its own version line                                                                            |
| `applications/` or the session cwd | mirrored candidacy folders (`<company>/<job-id>/cv/…`, `letter/…`, `notes/…`) a human can open outside the harness |
| `mcp-session.json`                 | the MCP shell's remembered session id                                                                              |

Both shells read and write the same files, so an application opened in one
shows up in the other.

## Tests

Plain Node — every `test/*.test.mjs` is a script that asserts with `node:assert`
and prints one `ok …` line; `node --test` runs them. No framework, matching the
zero-runtime-dependency rule. `test/routes.test.mjs` exercises the route
handlers directly; `test/mcp.test.mjs` drives the full JSON-RPC loop against a
real preview server.
