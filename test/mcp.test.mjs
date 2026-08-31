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
    '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page">Fabricio Dujardin</div></body></html>'
  const saved = toolJson(
    await rpc('tools/call', { name: 'jobcv_save_cv', arguments: { html, note: 'first draft' } }),
  )
  assert.equal(saved.ok, true, 'save succeeded')
  assert.equal(saved.version, 1, 'first save is version 1')

  // ---- read it back through the same surface ----
  const cv = toolJson(await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'cv' } }))
  assert.equal(cv.version, 1, 'jobcv_get sees version 1')
  assert.ok(cv.html.includes('Fabricio Dujardin'), 'the stored document round-trips')

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
      arguments: { text: '# Standing facts\n\n- 7 years, counted from 2018' },
    }),
  )
  assert.equal(savedProfile.ok, true, 'the profile saved')
  const profileRes = await rpc('resources/read', { uri: 'jobcv://profile' })
  assert.ok(
    profileRes.result.contents[0].text.includes('counted from 2018'),
    'the profile resource returns what was saved',
  )
  const profileGet = toolJson(
    await rpc('tools/call', { name: 'jobcv_get', arguments: { what: 'profile' } }),
  )
  assert.ok(profileGet.text.includes('7 years'), 'jobcv_get what:profile round-trips')

  // ---- the preview page is served with the session baked in ----
  const page = await fetch(ui.url).then((r) => r.text())
  assert.ok(page.includes('"mcp-test-abc123"'), 'the page carries the injected session id')
  assert.ok(!page.includes('__JOBCV_SESSION__'), 'the placeholder is replaced')
  assert.ok(page.includes("get('tab')"), 'the page deep-links a tab from ?tab=')
  assert.ok(page.includes("get('live')"), 'and supports ?live=0 for a static snapshot')
  assert.ok(page.includes('.dsh-gap'), 'and paints the gap-mark convention into its iframes')

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
