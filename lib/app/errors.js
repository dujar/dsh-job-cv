/**
 * App-layer errors carry the HTTP status a route should answer with, so the
 * shared guard (lib/routes/mount.js) maps them and the MCP shell can surface
 * the same message without a status at all.
 */

export class AppError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }
}

/** The request body was missing or malformed. */
export class BadRequest extends AppError {
  constructor(message) {
    super(message, 400)
    this.name = 'BadRequest'
  }
}

/** The thing asked for is not there (a version, a workspace, a resource). */
export class NotFound extends AppError {
  constructor(message) {
    super(message, 404)
    this.name = 'NotFound'
  }
}

/**
 * A save that names its posting (jobUrl) arrived after the session switched
 * to a different candidacy — applying it would misfile the document.
 */
export class StaleSave extends AppError {
  constructor(message) {
    super(message, 409)
    this.name = 'StaleSave'
  }
}
