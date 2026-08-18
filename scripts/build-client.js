/**
 * Build lib/client.js from lib/client/ fragments.
 *
 * The browser half is one window.__ModuleLoader__.load({...}) bundle: a
 * single IIFE whose declarations share one scope, so it is split into
 * ordered source fragments that are concatenated verbatim.
 *
 * lib/client.js stays COMMITTED: `dsh plugin add <path>` installs a
 * checkout as-is. --check verifies it matches the sources.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const clientPath = fileURLToPath(new URL('lib/client.js', root))
const manifestPath = fileURLToPath(new URL('lib/client/manifest.txt', root))

export function buildClient() {
  const manifest = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
  const pieces = []
  for (const entry of manifest) {
    const body = readFileSync(fileURLToPath(new URL('lib/client/' + entry, root)), 'utf8')
    pieces.push(body.replace(/\n+$/, ''))
  }
  return pieces.join('\n\n') + '\n'
}

const built = buildClient()
if (process.argv.includes('--check')) {
  const onDisk = readFileSync(clientPath, 'utf8')
  if (onDisk !== built) {
    console.log('  STALE lib/client.js does not match lib/client/ — run: npm run build:client')
    process.exit(1)
  }
  console.log('  ok  lib/client.js matches lib/client/ (' + built.split('\n').length + ' lines)')
} else {
  writeFileSync(clientPath, built, 'utf8')
  console.log('[dsh-job-cv] built lib/client.js — ' + built.split('\n').length + ' lines')
}
