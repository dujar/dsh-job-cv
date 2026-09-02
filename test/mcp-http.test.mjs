import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The HTTP transport must speak the same JSON-RPC dispatcher as stdio, add a
// bearer-token gate, and answer 202 to notifications — so a claude.ai custom
// connector reached through a tunnel drives the exact same workspace.

const home = await mkdtemp(join(tmpdir(), 'jobcv-http-home-'))
const appsRoot = await mkdtemp(join(tmpdir(), 'jobcv-http-apps-'))
process.env.DSH_HOME = home

const { startUiServer } = await import('../lib/mcp/ui-server.js')
const { startMcpHttpServer } = await import('../lib/mcp/server.js')

const ui = await startUiServer({ sessionId: 'mcp-http-test', applicationsRoot: appsRoot })
const TOKEN = 'sekret-abc-123'
const http = await startMcpHttpServer({ ui, host: '127.0.0.1', port: 0, token: TOKEN })

const auth = { authorization: 'Bearer ' + TOKEN }
async function rpc(body, headers) {
  const res = await fetch(http.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, ...(headers || {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { res, text, json: text ? JSON.parse(text) : null }
}

try {
  // ---- auth gate ----
  const noToken = await fetch(http.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(noToken.status, 401, 'a request with no bearer token is rejected')

  const wrongToken = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { authorization: 'Bearer nope' },
  )
  assert.equal(wrongToken.res.status, 401, 'a wrong bearer token is rejected')

  // ---- initialize ----
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} },
  })
  assert.equal(init.res.status, 200)
  assert.equal(init.json.result.serverInfo.name, 'dsh-job-cv', 'serverInfo names the plugin')
  assert.equal(init.json.result.protocolVersion, '2025-06-18', 'echoes the protocol version')
  assert.ok(init.res.headers.get('mcp-session-id'), 'initialize returns a Mcp-Session-Id header')
  assert.ok(
    /never invent/i.test(init.json.result.instructions),
    'instructions carry the honesty rule',
  )

  // ---- a notification gets 202, no body ----
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(note.res.status, 202, 'a notification is acknowledged with 202')
  assert.equal(note.text, '', 'and no body')

  // ---- tools/list ----
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = list.json.result.tools.map((t) => t.name)
  for (const need of ['jobcv_context', 'jobcv_open', 'jobcv_score', 'jobcv_save_cv']) {
    assert.ok(names.includes(need), 'tools/list includes ' + need)
  }
  for (const t of list.json.result.tools) {
    assert.ok(
      !('sessionId' in (t.inputSchema.properties || {})),
      t.name + ' never exposes sessionId',
    )
  }

  // ---- tools/call round-trips through the shared app ----
  const ctx = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'jobcv_context', arguments: {} },
  })
  const ctxOut = JSON.parse(ctx.json.result.content[0].text)
  assert.equal(ctxOut.previewUrl, ui.url, 'the HTTP tool call sees the same preview server')

  // a save through HTTP is visible to a read through HTTP
  await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'jobcv_save_cv',
      arguments: {
        html: '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page">Jordan Lee</div></body></html>',
        note: 'http first draft',
      },
    },
  })
  const cv = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'jobcv_get', arguments: { what: 'cv' } },
  })
  assert.ok(
    JSON.parse(cv.json.result.content[0].text).html.includes('Jordan Lee'),
    'a document saved over HTTP round-trips',
  )

  // ---- a batch: notifications drop out, requests answer ----
  const batch = await rpc([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 6, method: 'ping' },
  ])
  assert.ok(Array.isArray(batch.json), 'a batch answers with an array')
  assert.equal(batch.json.length, 1, 'only the request in the batch gets a reply')
  assert.equal(batch.json[0].id, 6)

  // ---- unknown method → JSON-RPC method-not-found ----
  const bad = await rpc({ jsonrpc: '2.0', id: 7, method: 'does/not/exist' })
  assert.equal(bad.json.error.code, -32601, 'unknown method → -32601')

  // ---- GET opens an SSE keep-alive stream ----
  const stream = await fetch(http.url, { method: 'GET', headers: auth })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') || '', /event-stream/, 'GET is an SSE stream')
  await stream.body.cancel()

  // ---- health needs no auth ----
  const health = await fetch(http.url.replace('/mcp', '/health'))
  assert.equal(health.status, 200, '/health is open')

  console.log(
    'ok  mcp-http: Streamable HTTP transport — bearer auth, JSON replies, 202 notifications',
  )
} finally {
  await http.close()
  await ui.close()
  await rm(home, { recursive: true, force: true })
  await rm(appsRoot, { recursive: true, force: true })
}
