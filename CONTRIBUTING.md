# Contributing

Thanks for looking. This plugin has a few load-bearing conventions that are not
obvious from the code — read these first.

## Setup

```sh
npm install      # installs dev deps AND the peer deps the tests need
npm test         # lint + format check + typecheck + client-bundle check + node --test
```

Node 22.19+ is required (`engines`). There is no build step for the host half;
`npm run build:client` regenerates the committed `lib/client.js` when you touch
a `lib/client/` fragment.

## The rules that matter

### Zero runtime dependencies

`package.json` has **no `dependencies`** and it stays that way. `devDependencies`
are limited to the toolchain (eslint, prettier, typescript, `@types/node`);
`peerDependencies` are supplied by the DSH harness at runtime and pulled in for
tests only. If you reach for a package, first check whether `node:` built-ins or
a ~30-line helper do the job — they almost always do.

### `lib/store/*` is framework-free

No `import` of anything DSH, no HTTP, no `ctx`. It is the domain layer: pure
normalisation and factory stores over `node:fs`. New behaviour that isn't
transport or UI belongs here, with a `normalize*`/`read*` function that
degrades a malformed record to sane fields instead of throwing.

### Routes take dependencies, not a context

`defineJobCvRoutes(deps)` must never import a DSH context. If a handler needs a
new capability, add it to `deps` and pass it from _both_ shells
(`lib/index.js` and `lib/mcp/ui-server.js`). This is what keeps the two shells
in sync — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### The client bundle is committed and generated

Edit `lib/client/<fragment>.js`, then `npm run build:client`. Commit both. Never
hand-edit `lib/client.js`. The fragments share one IIFE scope, so functions are
used across files and ESLint/TS are configured to expect that.

### The agent contract is generated

The text an agent reads is `skillInstructions()` in `lib/preset/preset-seed.js`.
Both shells serve it from there. Don't copy it into a shell.

## Style

- Prettier + ESLint enforce mechanics (`npm run format`, config in the repo).
- **Comments explain _why_, not _what_.** The existing code is dense with
  rationale — a comment that says what the next line already says is noise; one
  that records the bug a check prevents, or the trade-off a design makes, is the
  point. `TODO.md` keeps the longer-form "decisions worth remembering".
- Prefer existing helpers and patterns over new machinery.

## The résumé doctrine

If you touch the persona (`preset-seed.js`) or anything that shapes CV text,
the governing rule is **facts, not self-description**: a line on a CV stays only
if it names something the candidate _did_, at a place, in a period. Anything
that characterises the person — even flatteringly, even accurately — comes off,
because the reader is meant to draw that conclusion themselves. Never add a
capability for an agent to state a claim the user has not made; a missing fact
is a question, not an invention.

## Tests

Add a `test/<area>.test.mjs`: a plain script, `node:assert`, one `ok …` line at
the end, no framework. `node --test` discovers it. Cover the failure mode you
are fixing, not just the happy path.

## Commits & PRs

- Subject line: `job-cv: <imperative summary>` (match the history).
- Body: the _why_. Note any convention you had to work around.
- Green `npm test` before you push.
- One logical change per PR.

## Branch protection

`master` is guarded. Server-side rules (`.github/master-ruleset.json`: no
force-push, no deletion, CI green, PR required) apply once the repo is public
or on GitHub Pro. Until then, enable the local guard in your clone:

```sh
git config core.hooksPath .githooks
```

`.githooks/pre-push` refuses a force-push or a delete of `master`.
