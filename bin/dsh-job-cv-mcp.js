#!/usr/bin/env node
/**
 * `dsh-job-cv-mcp` — run the job-CV workflow as a Model Context Protocol
 * server for any MCP client (Claude Code, Claude Desktop, …), with a live
 * preview page the user watches while the client drives the tools.
 *
 * The DSH plugin is unaffected: both shells read and write the same state
 * under $DSH_HOME/dsh-job-cv, so an application opened in one shows up in the
 * other.
 *
 * Usage:
 *   dsh-job-cv-mcp [--root <dir>] [--port <n>] [--session <id>] [--fresh]
 *                  [--http] [--http-port <n>] [--http-host <h>] [--http-token <t>]
 *
 *   --root <dir>       where candidacy folders are written
 *                      (default: $DSH_JOB_CV_ROOT, else $DSH_HOME/dsh-job-cv/applications)
 *   --port <n>         preview server port (default: an OS-chosen free port)
 *   --session <id>     use this session id instead of the remembered one
 *   --fresh            mint a new session id (starts an empty active candidacy)
 *
 *   --http             serve MCP over HTTP instead of stdio — for a remote
 *                      connector (claude.ai) reached through a tunnel
 *   --http-port <n>    HTTP port (default 8123)
 *   --http-host <h>    bind address (default 127.0.0.1 — keep it, put a tunnel
 *                      in front; only use 0.0.0.0 with --http-token)
 *   --http-token <t>   require "Authorization: Bearer <t>" on every request
 *                      (default: $DSH_JOB_CV_MCP_TOKEN)
 *   --http-path <p>    endpoint path (default /mcp)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { startUiServer } from '../lib/mcp/ui-server.js'
import { startMcpServer, startMcpHttpServer } from '../lib/mcp/server.js'
import { dshHome } from '../lib/preset/preset-seed.js'
import { sanitizeSessionId } from '../lib/store/doc-store.js'

function parseArgs(argv) {
  const out = { fresh: false, http: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--fresh') out.fresh = true
    else if (a === '--http') out.http = true
    else if (a === '--root' || a === '--applications-root') out.root = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--session') out.session = argv[++i]
    else if (a === '--http-port') out.httpPort = Number(argv[++i])
    else if (a === '--http-host') out.httpHost = argv[++i]
    else if (a === '--http-token') out.httpToken = argv[++i]
    else if (a === '--http-path') out.httpPath = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function sessionFile() {
  return join(dshHome(), 'dsh-job-cv', 'mcp-session.json')
}

async function resolveSessionId(args) {
  if (typeof args.session === 'string' && args.session.trim() !== '') {
    const safe = sanitizeSessionId(args.session)
    if (safe === null) throw new Error('--session is not a usable id')
    return safe
  }
  const file = sessionFile()
  if (!args.fresh) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (typeof parsed.sessionId === 'string' && sanitizeSessionId(parsed.sessionId)) {
        return sanitizeSessionId(parsed.sessionId)
      }
    } catch {
      // none remembered — mint one below
    }
  }
  const minted = 'mcp-' + randomBytes(6).toString('hex')
  try {
    await mkdir(join(dshHome(), 'dsh-job-cv'), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({ sessionId: minted, writtenAt: Date.now() }, null, 2),
      'utf8',
    )
  } catch {
    // a non-persisted session still works for this run
  }
  return minted
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(
      'dsh-job-cv-mcp [--root <dir>] [--port <n>] [--session <id>] [--fresh]\n' +
        '              [--http] [--http-port <n>] [--http-host <h>] [--http-token <t>] [--http-path <p>]\n',
    )
    return
  }
  if (args.port !== undefined && !Number.isInteger(args.port)) {
    throw new Error('--port must be an integer')
  }
  if (args.httpPort !== undefined && !Number.isInteger(args.httpPort)) {
    throw new Error('--http-port must be an integer')
  }

  const sessionId = await resolveSessionId(args)
  const ui = await startUiServer({
    sessionId,
    applicationsRoot: args.root,
    port: args.port,
  })
  process.stderr.write(
    '[dsh-job-cv-mcp] preview: ' +
      ui.url +
      '\n[dsh-job-cv-mcp] candidacy folders: ' +
      ui.applicationsRoot +
      '\n',
  )

  if (args.http) {
    const token = args.httpToken || process.env.DSH_JOB_CV_MCP_TOKEN || ''
    const http = await startMcpHttpServer({
      ui,
      port: Number.isInteger(args.httpPort) ? args.httpPort : 8123,
      host: args.httpHost || '127.0.0.1',
      path: args.httpPath || '/mcp',
      token,
    })
    process.stderr.write(
      '[dsh-job-cv-mcp] MCP over HTTP: ' +
        http.url +
        (token ? '  (bearer token required)' : '  (NO AUTH — tunnel + token before exposing)') +
        '\n[dsh-job-cv-mcp] add this URL as a claude.ai custom connector; keep this process running.\n',
    )
    return
  }

  startMcpServer({ ui })
}

main().catch((error) => {
  process.stderr.write(
    '[dsh-job-cv-mcp] fatal: ' + String(error && error.message ? error.message : error) + '\n',
  )
  process.exit(1)
})
