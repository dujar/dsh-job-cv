import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

// The MCP shell must not fork the document contract: it stands the SAME
// /jobcv/* routes on a plain http.Server and drives them through typed tools
// with a server-held session id the client never sees.

const home = await mkdtemp(join(tmpdir(), 'jobcv-mcp-home-'))
const appsRoot = await mkdtemp(join(tmpdir(), 'jobcv-mcp-apps-'))
process.env.DSH_HOME = home

const { startUiServer } = await import('../lib/mcp/ui-server.js')
const { startMcpServer } = await import('../lib/mcp/server.js')

const ui = await startUiServer({ sessionId: 'mcp-test-abc123', applicationsRoot: appsRoot })

const stdin = new PassThrough()
const stdout = new PassThrough()
const lines = []
let carry = ''
stdout.setEncoding('utf8')
stdout.on('data', (chunk) => {
  carry += chunk
  let nl
  while ((nl = carry.indexOf('\n')) !== -1) {
    const line = carry.slice(0, nl).trim()
    carry = carry.slice(nl + 1)
    if (line !== '') lines.push(JSON.parse(line))
  }
})

startMcpServer({ ui, stdin, stdout, onClose: () => {} })

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return waitFor(id)
}
function waitFor(id) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      const hit = lines.find((m) => m.id === id)
      if (hit) {
        clearInterval(tick)
        resolve(hit)
      } else if (Date.now() - started > 5000) {
        clearInterval(tick)
        reject(new Error('no reply to rpc id ' + id))
      }
    }, 10)
  })
}
const toolJson = (reply) => {
  assert.ok(!reply.result.isError, 'tool call errored: ' + JSON.stringify(reply.result))
  return JSON.parse(reply.result.content[0].text)
}

try {
  // ---- initialize ----
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  assert.equal(init.result.serverInfo.name, 'dsh-job-cv', 'serverInfo names the plugin')
  assert.equal(init.result.protocolVersion, '2025-06-18', 'echoes the requested protocol version')
  assert.ok(init.result.capabilities.tools, 'declares the tools capability')
  assert.ok(/never invent/i.test(init.result.instructions), 'instructions carry the honesty rule')

  // ---- tools/list ----
  const list = await rpc('tools/list', {})
  const names = list.result.tools.map((t) => t.name)
  for (const need of [
    'jobcv_context',
    'jobcv_open',
    'jobcv_save_cv',
    'jobcv_score',
    'jobcv_propose',
  ]) {
    assert.ok(names.includes(need), 'tools/list includes ' + need)
  }
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name + ' has an object input schema')
    assert.ok(
      !('sessionId' in (t.inputSchema.properties || {})),
      t.name + ' never exposes sessionId',
    )
  }

  // ---- jobcv_context on an empty workspace ----
  const ctx = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(ctx.previewUrl, ui.url, 'context hands back the preview URL')
  assert.equal(ctx.active.cvVersion, 0, 'a fresh session has no CV')

  // ---- a formatting save goes straight through ----
  const html =
    '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page">Alex Rivera</div></body></html>'
  const saved = toolJson(
    await rpc('tools/call', { name: 'jobcv_save_cv', arguments: { html, note: 'first draft' } }),
  )
  assert.equal(saved.ok, true, 'save succeeded')
  assert.equal(saved.version, 1, 'first save is version 1')

  // ---- read it back through the same surface ----
  const cv = toolJson(await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'cv' } }))
  assert.equal(cv.version, 1, 'jobcv_get sees version 1')
  assert.ok(cv.html.includes('Alex Rivera'), 'the stored document round-trips')

  // ---- sync from master: the incoming delta and the lineage marker ----
  // no master yet — the master-delta says so, and no sync is offered
  const preSync = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'master-delta' } }),
  )
  assert.equal(preSync.direction, 'incoming')
  assert.equal(preSync.empty, 'no-master')
  const ctxNoMaster = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(ctxNoMaster.active.masterSyncAvailable, false, 'no master, no sync')

  // set a master, then move it on
  await rpc('tools/call', {
    name: 'jobcv_save_master',
    arguments: {
      html: '<!doctype html><html><body><div class="page"><p>Alex Rivera</p><p>Engineer</p></div></body></html>',
      note: 'master v1',
    },
  })
  await rpc('tools/call', {
    name: 'jobcv_save_master',
    arguments: {
      html: '<!doctype html><html><body><div class="page"><p>Alex Rivera</p><p>Staff Engineer</p><p>Rust, TypeScript</p></div></body></html>',
      note: 'master v2 — title + stack',
    },
  })
  const masterDelta = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'master-delta' } }),
  )
  assert.equal(masterDelta.direction, 'incoming')
  assert.equal(masterDelta.masterVersion, 2)
  assert.ok(
    masterDelta.changes.some((c) => c.op === 'add' && c.text.includes('Rust')),
    'the master-delta shows what the master gained',
  )
  const ctxSyncable = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(
    ctxSyncable.active.masterSyncAvailable,
    true,
    'the master moved past the CV — sync is available',
  )

  // a sync save carries the reconciled master version; the marker moves
  const syncSaved = toolJson(
    await rpc('tools/call', {
      name: 'jobcv_save_cv',
      arguments: {
        html: '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page">Alex Rivera — Staff Engineer</div></body></html>',
        note: 'Synced master v2',
        baseMasterVersion: 2,
      },
    }),
  )
  assert.equal(syncSaved.version, 2)
  const ctxSynced = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(ctxSynced.active.baseMasterVersion, 2)
  assert.equal(ctxSynced.active.masterSyncAvailable, false, 'reconciled — nothing left to pull in')
  const afterSync = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'master-delta' } }),
  )
  assert.equal(afterSync.empty, 'in-sync')

  // ---- the contract resource is reachable ----
  const rlist = await rpc('resources/list', {})
  assert.ok(
    rlist.result.resources.some((r) => r.uri === 'jobcv://skill'),
    'skill is a resource',
  )
  const skill = await rpc('resources/read', { uri: 'jobcv://skill' })
  assert.ok(
    skill.result.contents[0].text.includes('/jobcv/doc'),
    'the skill resource is the real contract',
  )

  // ---- the candidate profile: a tool round-trip and a resource ----
  assert.ok(
    rlist.result.resources.some((r) => r.uri === 'jobcv://profile'),
    'the profile is a resource',
  )
  const savedProfile = toolJson(
    await rpc('tools/call', {
      name: 'jobcv_save_profile',
      arguments: { text: '# Standing facts\n\n- 7 years in the field' },
    }),
  )
  assert.equal(savedProfile.ok, true, 'the profile saved')
  const profileRes = await rpc('resources/read', { uri: 'jobcv://profile' })
  assert.ok(
    profileRes.result.contents[0].text.includes('7 years in the field'),
    'the profile resource returns what was saved',
  )
  const profileGet = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'profile' } }),
  )
  assert.ok(profileGet.text.includes('7 years'), 'jobcv_get what:profile round-trips')

  // ---- retag a job by jobUrl without switching to it (the Jobs list) ----
  const jobA = 'https://boards.example.com/acme/senior-engineer'
  const jobB = 'https://boards.example.com/globex/staff-engineer'
  await rpc('tools/call', {
    name: 'jobcv_open',
    arguments: { jobUrl: jobA, company: 'Acme', jobTitle: 'Senior Engineer' },
  })
  await rpc('tools/call', {
    name: 'jobcv_open',
    arguments: { jobUrl: jobB, company: 'Globex', jobTitle: 'Staff Engineer' },
  })
  // Globex is now the active candidacy — tag Acme by its URL
  const tagged = toolJson(
    await rpc('tools/call', {
      name: 'jobcv_set_status',
      arguments: { status: 'applied', note: 'via careers portal', jobUrl: jobA },
    }),
  )
  assert.equal(tagged.ok, true, 'a jobUrl-routed status change succeeds')
  const apps = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'applications' } }),
  )
  const acme = apps.applications.find((a) => a.jobUrl === jobA)
  const globex = apps.applications.find((a) => a.jobUrl === jobB)
  assert.equal(
    acme.application && acme.application.status,
    'applied',
    'the non-active job got the tag',
  )
  assert.ok(
    !globex.application || globex.application.status === 'drafting',
    'the active job was left alone',
  )

  // ---- the request inbox: the preview raises an ask, the agent sees + clears it ----
  await fetch(ui.url + 'jobcv/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'mcp-test-abc123',
      kind: 'cover-letter',
      summary: 'Write a cover letter',
      detail: { note: 'their rails are the problem I want next' },
    }),
  })
  // a sync-from-master ask is a first-class kind, not coerced to a note
  await fetch(ui.url + 'jobcv/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'mcp-test-abc123',
      kind: 'sync-master',
      summary: 'Sync the latest master CV improvements into this tailored CV',
    }),
  })
  const ctx2 = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(ctx2.pendingRequests.length, 2, 'jobcv_context surfaces the raised requests')
  const kinds = ctx2.pendingRequests.map((r) => r.kind).sort()
  assert.deepEqual(kinds, ['cover-letter', 'sync-master'], 'both kinds survive intact')
  const ids = ctx2.pendingRequests.map((r) => r.id)
  const resolved = toolJson(
    await rpc('tools/call', { name: 'jobcv_resolve_requests', arguments: { ids } }),
  )
  assert.equal(resolved.pending, 0, 'the agent clears what it acted on')
  const ctx3 = toolJson(await rpc('tools/call', { name: 'jobcv_context', arguments: {} }))
  assert.equal(ctx3.pendingRequests.length, 0, 'and they are gone from context')

  // ---- the preview page is served with the session baked in ----
  const page = await fetch(ui.url).then((r) => r.text())
  assert.ok(page.includes('"mcp-test-abc123"'), 'the page carries the injected session id')
  assert.ok(!page.includes('__JOBCV_SESSION__'), 'the placeholder is replaced')
  assert.ok(page.includes("get('tab')"), 'the page deep-links a tab from ?tab=')
  assert.ok(page.includes("get('live')"), 'and supports ?live=0 for a static snapshot')
  assert.ok(page.includes('.dsh-gap'), 'and paints the gap-mark convention into its iframes')
  assert.ok(page.includes('data-theme'), 'the page has a light/dark theme')
  assert.ok(page.includes('paintRows'), 'the applications drawer virtualises its rows')
  assert.ok(page.includes('data-tab="master"'), 'the page has a Master tab')
  assert.ok(page.includes('function rMaster'), 'and a renderer for it')
  assert.ok(page.includes("raise('sync-master'"), 'with a one-tap sync-from-master ask')
  assert.ok(page.includes('dir=incoming'), 'the page polls the incoming master delta')
  assert.ok(
    page.includes('function outgoingDeltaCard'),
    'the Master tab renders the outgoing delta (what this CV changed from the master)',
  )
  assert.ok(
    page.includes('function buildDiff') && page.includes('function renderDiff'),
    'the deltas render as git-style diffs — hunks, line numbers, context — computed client-side',
  )
  assert.ok(
    page.includes('dfold') && page.includes('wordMarks'),
    'long unchanged runs fold away and reworded pairs carry word-level marks',
  )
  assert.ok(
    page.includes('kind=master&version='),
    'the incoming diff fetches the base master version it reconciles against',
  )
  assert.ok(
    page.includes('function renderSig') && page.includes('renderSig() !== lastSig'),
    'the poll timer re-renders only when the data changed (no per-tick iframe reload)',
  )
  assert.ok(
    page.includes('data-tab="jobs"') && page.includes('function rJobs'),
    'the page has a Jobs workbench tab and a renderer for it',
  )
  assert.ok(
    page.includes('function jMatch') &&
      page.includes('function jSort') &&
      page.includes('function jLeaderboard'),
    'the Jobs tab carries the search/filter/sort helpers and the fit leaderboard',
  )
  assert.ok(
    page.includes('function jSourceLink') && page.includes('JOB_PORTALS'),
    'each job links back to its source posting, labelled by portal',
  )
  assert.ok(
    page.includes('function jStatusSelect') && page.includes("post('/jobcv/status'"),
    'the Jobs list retags a row inline via an editable stage select',
  )
  assert.ok(
    page.includes('window.printDoc') && page.includes('w.print()'),
    'the CV / letter / master toolbars have a Print / Save-PDF action that opens the doc and prints it',
  )
  // a syntax error in the preview script blanks the whole preview and no
  // assertion above would catch it — parse it for real
  const script = page.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(script, 'the preview carries an inline script')
  new Function(script[1]) // throws on a syntax error

  // ---- unknown method is a JSON-RPC error, not a crash ----
  const bad = await rpc('does/not/exist', {})
  assert.equal(bad.error.code, -32601, 'unknown method → method-not-found')

  console.log(
    'ok  mcp: stdio JSON-RPC, typed tools over the shared /jobcv/* routes, live preview page',
  )
} finally {
  stdin.end()
  await ui.close()
  await rm(home, { recursive: true, force: true })
  await rm(appsRoot, { recursive: true, force: true })
}
