# TODO

## Onboarding flow — hand-off shape

A fresh session shows a start form in the preview (job post link + CV as a
typed path or a dropped file, staged via `POST /jobcv/intake`, plus an
optional company name). Submitting composes a chat message telling the
agent to open the candidacy workspace (`POST /jobcv/workspace`) and tailor
the CV.

When the composer is unreachable and a company name was given, the form
falls back to calling `POST /jobcv/workspace` itself so the folder exists
anyway, and shows the message to copy into the chat. The agent is still the
reliable path for the normal case — it reads the company name and job id
off the fetched post.

## Confirm the composer action name

`lib/client/025-cv-annotate.js` sends a marked-up revision request to the chat
through the standard kit's `inputActions`. That prop comes from the shell's
composer plugin, which is not among this plugin's peer deps, so its method
names could not be read from any contract available here.

`sendToComposer()` therefore probes: a list of plausible names
(`appendText`, `append`, `insertText`, `insert`, `addText`, `setText`,
`setDraft`, `setValue`, `setInput`, `setPrompt`), then any action whose name
matches `^(set|append|insert|add)` **and** `(text|draft|input|value|prompt|
message|content)`, then the clipboard. Whichever path it takes is reported to
the user, so nothing is silently dropped.

**To close this:** find the real action name (log `Object.keys(inputActions)`
from `JobDock`, or read the composer plugin), put it first in
`COMPOSER_ACTIONS`, and narrow the fallback. Keep the clipboard path — it is
the only thing that works when the composer is not mounted.

Also worth settling: whether the right call is `append` (add to whatever the
user has already typed) or `set` (replace the draft). The current order
prefers appending, which is the safer of the two.

## Reading job posts: no fetch provider exists

`web_fetch` cannot work in this harness. `dsh-web` resolves a provider per
capability, and while `dsh-web-search-deepseek` calls `registerSearchProvider`,
**nothing anywhere calls `registerFetchProvider`** — so every `web_fetch` call
raises `WEB_PROVIDER_UNAVAILABLE` ("no usable web provider is registered").
The shipped `standard` preset pins `fetch: false` for exactly this reason; the
job preset now does too, and the contract tells the agent to read the post with
`curl | perl` instead. `test/routes.test.mjs` pins this so it cannot regress.

Worth deciding: the host half could register its own fetch provider
(`ctx.web.registerFetchProvider`) and make `web_fetch` genuinely work for job
posts — better extraction than a shell pipeline, and it would benefit every
preset. That means owning redirect/size/timeout limits and an SSRF policy
(a job link is user-supplied and would be fetched by the host), so it is a
real feature rather than a config change. Until then the shell path stands.

## Smaller

- The preview polls `/jobcv/doc` every 2.5s. A push channel (SSE, or the
  harness's own session stream) would drop the latency and the idle traffic.
- `test/annotate.test.mjs` builds fake nodes by hand. If a DOM harness ever
  lands here (dsh-trader uses jsdom), the picking effect in `CvPane` itself
  becomes reachable, not just its helpers.
- The rollback UI restores whole versions. A finer "restore just this
  section from an older version" would need diffing the two documents —
  probably more than the workflow needs today.
