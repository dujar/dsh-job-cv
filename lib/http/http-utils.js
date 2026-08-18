// ---- job-cv routes: same-origin/localhost trust ----
//
// Same fail-closed CSRF posture as the other local plugins: the socket
// being local is not proof the request came from the harness page.
//   1. a cross-origin Origin/Referer REJECTS (never falls through);
//   2. an unparseable Referer/Origin rejects rather than throwing;
//   3. only then does a localhost Host count as trusted;
//   4. CORS-simple content types are refused on JSON routes.

/** The host (with port) of a Referer/Origin header, or null when unparseable. */
function headerHost(value) {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The hostname of a Host header: port stripped, IPv6 brackets unwrapped.
 * Real IPv6 Host headers are bracketed ("[::1]:3080"), so a naive prefix
 * test never matches loopback over IPv6 — and matches "127.0.0.1.evil.com".
 */
function hostname(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    return close === -1 ? '' : raw.slice(1, close)
  }
  return raw.split(':')[0]
}

/** Exact loopback match — never a prefix test. */
function isLoopbackHost(value) {
  const name = hostname(value)
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function isTrustedRequest(req) {
  const headers = req.headers ?? {}
  const host = String(headers.host ?? '').toLowerCase()
  for (const header of [headers.origin, headers.referer]) {
    if (header === undefined || header === null || header === '') continue
    if (header === 'null') return false // opaque origin (sandboxed frame, data: URL)
    const sourceHost = headerHost(header)
    if (sourceHost === null || sourceHost !== host) return false
  }
  if (simpleContentType(headers['content-type'])) return false
  return isLoopbackHost(host)
}

/**
 * Whether the content type is one a cross-origin page can send without a
 * CORS preflight. JSON routes never legitimately receive these.
 */
function simpleContentType(value) {
  if (typeof value !== 'string' || value === '') return false
  const type = value.split(';')[0].trim().toLowerCase()
  return (
    type === 'text/plain' ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'multipart/form-data'
  )
}

const DEFAULT_BODY_LIMIT = 256 * 1024

function readJsonBody(req, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : DEFAULT_BODY_LIMIT
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Send a plain-text (non-JSON) response, for the agent-facing skill page. */
function sendText(res, status, text) {
  const body = String(text)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * The port `dsh web` is actually serving on (DSH_WEB_PORT, else the port in
 * DSH_WEB_URL, else 3080) — agent-facing URLs must not hardcode it.
 */
function webPort() {
  const explicit = process.env.DSH_WEB_PORT
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  if (typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL !== '') {
    try {
      const port = new URL(process.env.DSH_WEB_URL).port
      if (port !== '') return port
    } catch {
      /* malformed — fall through to the default */
    }
  }
  return '3080'
}

/** Route base for agent-facing instructions. */
function jobCvBaseUrl() {
  return 'http://127.0.0.1:' + webPort()
}

export {
  DEFAULT_BODY_LIMIT,
  isTrustedRequest,
  isLoopbackHost,
  hostname,
  readJsonBody,
  sendJson,
  sendText,
  simpleContentType,
  webPort,
  jobCvBaseUrl,
}
