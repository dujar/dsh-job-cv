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
  lib/routes/       │  defineJobCvRoutes(deps) — the /jobcv/* handlers, given `store`,    │
  routes.js    ─────┤  `resolveRoot`, `sendJson`… (NEVER a DSH `ctx`)                     │
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
  mount.js    │  mountRouteGroups(ctx, …)     │        │  ui-server.js: the SAME route  │
              │                               │        │  groups on a plain http.Server │
  lib/client/*│  the preview: 14 source       │        │  + one self-contained preview  │
  → client.js │  fragments built into one     │        │  page (ui.html)                │
              │  IIFE bundle injected into    │        │                                │
              │  the DSH web GUI              │        │  server.js: newline-delimited  │
              │                               │        │  JSON-RPC 2.0 over stdio, 14   │
              │                               │        │  tools wrapping the routes     │
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

**`defineJobCvRoutes(deps)` takes injected dependencies, not a DSH context.**
That is the single decision that makes two shells possible. The plugin passes
`store`, a `resolveRoot` that reads the session's cwd, and the harness's
`sendJson`; the MCP shell passes the same shapes built from its own config. The
handlers cannot tell which shell they are running under.

**`lib/routes/mount.js` is the only DSH-coupled route code.** It registers each
guarded handler on `ctx.webServer` and derives the boot-log summary from the
declarations. The MCP shell has its own ~40-line equivalent
(`buildRouteTable` in `ui-server.js`) that puts the same guarded handlers into
a `Map` an `http.Server` dispatches on.

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
