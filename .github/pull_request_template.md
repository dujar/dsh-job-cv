<!-- Subject line convention: job-cv: <imperative summary> -->

## What and why

<!-- The change, and the reason for it. Link an issue if there is one. -->

## Conventions

- [ ] `npm test` is green (lint, format, typecheck, client-bundle check, tests)
- [ ] No new runtime `dependencies`
- [ ] `lib/store/*` changes stay framework-free; new route deps are passed from **both** shells
- [ ] Touched a `lib/client/` fragment → ran `npm run build:client` and committed `lib/client.js`
- [ ] New behaviour has a test covering the failure mode
