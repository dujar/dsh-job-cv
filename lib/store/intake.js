/**
 * Staging area for a CV dropped into the browser.
 *
 * The browser only ever sees a File, never a path — the OS path is withheld
 * from web pages on purpose. So a dropped CV arrives as bytes, lands here
 * under the session id, and the agent copies it into the candidacy folder
 * once it knows the company. A CV the user already has on disk skips all of
 * this: they type the path and nothing is uploaded.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Base64 of ~9MB of file; a CV that exceeds this is not a CV. */
export const INTAKE_LIMIT = 12 * 1024 * 1024

/**
 * A filename safe to join onto a path: no separators, no traversal, no
 * leading dot, and a length a filesystem will accept.
 */
export function sanitizeFileName(name, fallback) {
  const base = String(name === undefined || name === null ? '' : name)
    .split(/[\\/]/)
    .pop()
  const safe = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100)
  return safe === '' ? fallback : safe
}

/**
 * Where an upload should land. Once the candidacy folder exists the CV
 * belongs in it — the whole point of the folder is that the application
 * lives there. Before that (the usual onboarding order: drop the CV, then
 * the agent reads the post and opens the folder) it goes to session staging.
 */
export function intakeDirFor(intakeRoot, sessionId, workspace) {
  if (typeof workspace === 'string' && workspace !== '') return join(workspace, 'source')
  return join(intakeRoot, sessionId)
}

/** Write one uploaded file into `dir` and return where it landed. */
export async function saveIntakeFile(dir, filename, dataBase64) {
  const bytes = Buffer.from(String(dataBase64), 'base64')
  if (bytes.length === 0) throw new Error('file is empty or not valid base64')
  await mkdir(dir, { recursive: true })
  const target = join(dir, sanitizeFileName(filename, 'cv'))
  await writeFile(target, bytes)
  return { path: target, bytes: bytes.length }
}
