import { strict as assert } from 'node:assert'
import {
  isTrustedRequest,
  isLoopbackHost,
  hostname,
  simpleContentType,
  readJsonBody,
} from '../lib/http/http-utils.js'
import { EventEmitter } from 'node:events'

// hostname(): port stripped, IPv6 brackets unwrapped
assert.equal(hostname('127.0.0.1:3080'), '127.0.0.1')
assert.equal(hostname('[::1]:3080'), '::1')
assert.equal(hostname('LocalHost:3080'), 'localhost')
assert.equal(hostname(undefined), '')

// loopback is matched EXACTLY: a prefix test would admit the rebind names
assert.equal(isLoopbackHost('127.0.0.1:3080'), true)
assert.equal(isLoopbackHost('localhost:3080'), true)
assert.equal(isLoopbackHost('[::1]:3080'), true, 'real IPv6 Host headers are bracketed')
assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false)
assert.equal(isLoopbackHost('localhost.evil.com'), false)

// the trust gate as a whole
const trusted = (headers) => isTrustedRequest({ headers })
assert.equal(trusted({ host: '127.0.0.1:3080' }), true, 'agent-side POST, no Origin')
assert.equal(trusted({ host: '[::1]:3080' }), true)
assert.equal(
  trusted({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/' }),
  true,
  'same-origin browser poll',
)
assert.equal(trusted({ host: '127.0.0.1:3080', origin: 'http://evil.com' }), false)
assert.equal(trusted({ host: '127.0.0.1:3080', origin: 'null' }), false, 'opaque origin')
assert.equal(trusted({ host: '127.0.0.1:3080', origin: 'not a url' }), false, 'unparseable')
assert.equal(trusted({ host: '127.0.0.1.evil.com' }), false, 'DNS-rebind shaped host')
assert.equal(trusted({}), false, 'no Host header at all')

// CORS-simple content types are what a cross-origin form can send unpreflighted
assert.equal(simpleContentType('text/plain'), true)
assert.equal(simpleContentType('application/x-www-form-urlencoded'), true)
assert.equal(simpleContentType('multipart/form-data; boundary=x'), true)
assert.equal(simpleContentType('application/json'), false)
assert.equal(simpleContentType(undefined), false)
assert.equal(
  trusted({ host: '127.0.0.1:3080', 'content-type': 'application/x-www-form-urlencoded' }),
  false,
  'this is the `curl -d` default the skill contract warns about',
)

// readJsonBody: parses, defaults empty, and caps the body
function feed(chunks) {
  const req = new EventEmitter()
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c))
    req.emit('end')
  })
  req.destroy = () => {}
  return req
}
assert.deepEqual(await readJsonBody(feed(['{"a":', '1}'])), { a: 1 })
assert.deepEqual(await readJsonBody(feed([])), {})
await assert.rejects(readJsonBody(feed(['{bad'])))
await assert.rejects(readJsonBody(feed(['x'.repeat(300 * 1024)])), /body too large/)

// EventSource cannot set request headers, so /jobcv/stream arrives with no
// content-type at all — bare, plus whatever Referer the page carries. If the
// gate ever stops trusting that shape, the preview silently falls back to
// polling and nobody notices the push is gone.
assert.equal(trusted({ host: '127.0.0.1:7788' }), true, 'a header-less loopback GET is trusted')
assert.equal(
  trusted({ host: '127.0.0.1:7788', referer: 'http://127.0.0.1:7788/' }),
  true,
  'the stream carries the page as its referer',
)

console.log('ok  http trust gate')
