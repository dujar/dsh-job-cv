/**
 * Run an app-layer call and serialize the result.
 *
 * The app throws the typed errors from lib/app/errors.js (400 bad input, 404
 * not found, 409 stale save); everything else is a 500. Handlers call this
 * so a route body is: parse the request → respond(res, () => app.thing(…)).
 */
import { sendJson, readJsonBody } from '../http/http-utils.js'

export async function respond(res, work) {
  try {
    return sendJson(res, 200, await work())
  } catch (error) {
    const status = error && Number.isInteger(error.status) ? error.status : 500
    return sendJson(res, status, {
      error: String(error && error.message ? error.message : error),
    })
  }
}

/** The `?session=` query parameter, or null. */
export function sessionParam(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('session')
  } catch {
    return null
  }
}

/**
 * Read a JSON body, answering 400 on malformed input the way every POST did.
 * Returns { body } on success, { body: null } after having sent the 400.
 */
export async function readBody(req, res, maxBytes) {
  try {
    return { body: await readJsonBody(req, maxBytes) }
  } catch (error) {
    const tooBig = String(error && error.message) === 'body too large'
    sendJson(res, tooBig ? 413 : 400, { error: tooBig ? 'file too large' : 'invalid body' })
    return { body: null }
  }
}
