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

## Composer face — RESOLVED

`inputActions` is documented by `@deepseek-ai/dsh-client-ui-conversation`
(`lib/types/client/input/contract.d.ts`):

    setDraft(text)   single public draft write path — the FULL next draft
    submit()         enter submission
    addImages / removeImage / pruneImages

Note `setDraft` REPLACES; there is no append. `deliverToComposer` therefore
appends below an existing draft itself and only submits when the composer was
empty. The name probe is kept as a narrow fallback for other shells.

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

## Job folder naming vs. a hand-kept convention

Folders already kept by hand look like `coinbase/7866674-senior-sw-engineer-trading-intx`
— the job id AND the title. `jobSlug` produces the id alone when the post has
one, so plugin-made folders read `3812345678/` instead.

Not changed, deliberately: the folder name is the upsert's identity, and
`jobTitle` is optional on `POST /jobcv/workspace`. Folding it into the path
would mean one call with a title and one without produce two folders for the
same job — losing the property the whole design defends. Closing this needs
the title to become required, or a lookup that matches an existing folder by
id prefix before creating a new one.

## Smaller

- The preview polls `/jobcv/doc` every 2.5s. A push channel (SSE, or the
  harness's own session stream) would drop the latency and the idle traffic.
- `test/annotate.test.mjs` builds fake nodes by hand. If a DOM harness ever
  lands here (dsh-trader uses jsdom), the picking effect in `CvPane` itself
  becomes reachable, not just its helpers.
- The rollback UI restores whole versions. A finer "restore just this
  section from an older version" would need diffing the two documents —
  probably more than the workflow needs today.
