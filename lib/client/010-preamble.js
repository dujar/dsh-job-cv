// dsh-job-cv browser half.
//
// Zero-build hand-written client bundle (same proven pattern as dsh-trader):
// CJS factory + ModuleLoader wrapper. React comes from the shell's static
// module table; slot components receive the framework standard kit
// (sessionId, useSession, useSessions, useInput, inputActions) via props.
//
// When the current session's agent preset is "job" this plugin restructures
// the conversation column: the chat narrows into a right-hand sidebar and a
// CV preview pane (a sandboxed iframe rendering the stored HTML document)
// becomes the main layout. The pane hosts the toolbar with the live version,
// the job post link and the Export PDF button (browser print dialog, Save as
// PDF). The session agent updates the document through POST /jobcv/doc and
// the preview follows within a few seconds.
window.__ModuleLoader__.load({
  // Must equal package.json "name" exactly.
  id: 'dsh-job-cv',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = require('react-dom')
    var createElement = React.createElement

    // ------------------------- theme -------------------------
    function isDark() {
      return typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-ds-dark-theme')
    }
    function palette() {
      var dark = isDark()
      return {
        dark: dark,
        text: dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
        textStrong: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)',
        panelBg: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        panelBorder: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)',
        baseBg: dark ? '#1b1d21' : '#f5f5f4',
        controlBg: 'rgba(128,128,128,0.08)',
        controlBorder: 'rgba(128,128,128,0.25)',
        controlActive: 'rgba(128,128,128,0.28)',
        accent: dark ? '#7ab8ff' : '#2e6fdb',
      }
    }

    // The shell flips a body attribute to change theme; React gets no signal
    // for it, so anything we inject outside React's tree keeps the old
    // palette until an unrelated re-render. Components that paint with
    // palette() subscribe to this instead.
    function useThemeTick() {
      var state = React.useState(0)
      React.useEffect(function () {
        if (typeof MutationObserver === 'undefined' || !document.body) return undefined
        var observer = new MutationObserver(function () {
          state[1](function (n) { return n + 1 })
        })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return function () { observer.disconnect() }
      }, [])
      return state[0]
    }

    // ------------------------- per-session preferences -------------------------
    // Each job session keeps its own layout preference (pane open/closed)
    // under a session-scoped localStorage key.
    function prefsKey(sessionId) {
      return 'dsh-job-cv:prefs:' + sessionId
    }
    function loadPrefs(sessionId) {
      try {
        var raw = localStorage.getItem(prefsKey(sessionId))
        if (raw !== null) {
          var parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            return {
              open: parsed.open !== false,
              // The chat share the user dragged the divider to; null = the
              // computed share. Zero is how a reset is persisted.
              chatW:
                typeof parsed.chatW === 'number' && parsed.chatW > 0 ? parsed.chatW : null,
            }
          }
        }
      } catch (e) { /* fall through */ }
      // The empty-prefs fallback must carry the same shape as a stored one:
      // chatW missing meant undefined, and undefined is not null — the split
      // treated it as a dragged share and computed a NaN pane width.
      return { open: true, chatW: null }
    }
    function savePrefs(sessionId, prefs) {
      try {
        localStorage.setItem(prefsKey(sessionId), JSON.stringify(prefs))
      } catch (e) { /* storage full/blocked — preference stays ephemeral */ }
    }

    // ------------------------- document client -------------------------
    // Talks to the host half's /jobcv/* surface. All requests are same-origin
    // relative paths, JSON in and out.
    function fetchDoc(sessionId) {
      return fetch('/jobcv/doc?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) {
          var error = new Error('doc fetch failed: ' + res.status)
          error.status = res.status
          throw error
        }
        return res.json()
      })
    }

    /**
     * Is this poll the same document as the last one?
     *
     * The poll discards a response that matches, so what this compares is
     * what the preview is able to notice. Version-and-html alone missed
     * everything that changes WITHOUT a save: a proposal (which lands with no
     * new version at all, and so did not open the review panel until some
     * later save happened to change the html), a cover letter, a fit score, a
     * job post. Each of those has its own version line or timestamp, and each
     * is compared here.
     */
    function sameDoc(a, b) {
      if (a.version !== b.version || a.html !== b.html) return false
      if (a.jobUrl !== b.jobUrl || a.workspace !== b.workspace) return false
      if (a.company !== b.company || a.jobTitle !== b.jobTitle) return false
      if (a.postChars !== b.postChars || a.postUpdatedAt !== b.postUpdatedAt) return false
      if (a.postHtmlUpdatedAt !== b.postHtmlUpdatedAt) return false
      if (a.briefUpdatedAt !== b.briefUpdatedAt) return false
      if (!a.fit !== !b.fit) return false
      if (a.fit && b.fit && (a.fit.updatedAt !== b.fit.updatedAt || a.fit.score !== b.fit.score))
        return false
      if (!a.letter !== !b.letter) return false
      if (a.letter && b.letter && a.letter.version !== b.letter.version) return false
      if (!a.proposal !== !b.proposal) return false
      if (a.proposal && b.proposal && a.proposal.id !== b.proposal.id) return false
      return true
    }

    /** One historical body, fetched only when the user asks to look at it. */
    function fetchVersion(sessionId, version, kind) {
      return fetch(
        '/jobcv/history?session=' +
          encodeURIComponent(sessionId) +
          '&version=' +
          String(version) +
          kindParam(kind),
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      ).then(function (res) {
        if (!res.ok) throw new Error('version fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Why the poll stopped working, in words the user can act on. A 403 is
    // the one that looks like a hang rather than an error: the host only
    // trusts loopback, so opening the GUI on a LAN address or through a
    // tunnel makes every poll fail and the preview silently never updates.
    function offlineReason(error) {
      if (error && error.status === 403) {
        var host = typeof location === 'undefined' ? '' : location.hostname
        return (
          'the host refused this origin' +
          (host === '' ? '' : ' (' + host + ')') +
          ' — open the GUI on localhost, not a LAN address or tunnel'
        )
      }
      if (error && error.status !== undefined) return 'the host answered ' + error.status
      return 'the plugin host is not answering — is `dsh web` still running?'
    }

    // The candidacy folder for a session (path + files), so the dock can
    // show what the agent has saved into the workspace.
    function fetchWorkspace(sessionId) {
      return fetch('/jobcv/workspace?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('workspace fetch failed: ' + res.status)
        return res.json()
      })
    }

    // The job post text. Deliberately its own request: it is thousands of
    // characters and the document poll runs every 2.5s, so /jobcv/doc carries
    // only a marker (postChars/postUpdatedAt) and the body is fetched when
    // the Post tab actually wants it.
    function fetchPost(sessionId) {
      return fetch('/jobcv/post?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('post fetch failed: ' + res.status)
        return res.json()
      })
    }

    // The structured brief of the posting. Same marker pattern as the post:
    // /jobcv/doc carries briefUpdatedAt only, and the body is fetched when
    // the Post tab wants it.
    function fetchBrief(sessionId) {
      return fetch('/jobcv/brief?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('brief fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Store post text the user pasted. source:'you' so the panel can say the
    // requirements came from them and not from a scrape that may have missed.
    function savePost(sessionId, text) {
      return fetch('/jobcv/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, text: text, source: 'you' }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'post save failed')
          return body
        })
      })
    }

    /**
     * How long the working state must be VISIBLE, even when the thing asked
     * for lands immediately.
     *
     * The poll runs every 2.5s, and a fast agent can save inside one window:
     * without a floor, the loading flashes for less than a poll and reads as
     * "nothing happened". The floor keeps it on screen long enough to be seen
     * before the next poll clears it.
     */
    var WORKING_MIN_VISIBLE_MS = 3000

    /**
     * Is the working state over?
     *
     * The agent's work is bounded by the thing that was asked for landing:
     * a CV request ends when the CV saves, a letter request when the letter
     * does, a post request when the post text, page or brief moves, a fit
     * request when the score moves. Any OTHER marker advancing says nothing —
     * a save landing while a letter is being revised is not the letter.
     * Returns null when done, the snapshot itself while it is not.
     */
    function workingDone(from, next) {
      if (from === null) return null
      var landed = false
      if (from.target === 'cv') landed = next.version > from.version
      if (from.target === 'letter') landed = !!next.letter && next.letter.version > from.letterVersion
      if (from.target === 'post')
        landed =
          next.postUpdatedAt > from.postUpdatedAt ||
          next.postHtmlUpdatedAt > from.postHtmlUpdatedAt ||
          next.briefUpdatedAt > from.briefUpdatedAt
      if (from.target === 'fit') landed = !!next.fit && next.fit.updatedAt > from.fitUpdatedAt
      if (!landed) return from
      return Date.now() - (from.startedAt || 0) >= WORKING_MIN_VISIBLE_MS ? null : from
    }

    // The saved versions (newest first, bodies omitted) for the rollback UI.
    // kind:'letter' reads the cover letter's own timeline — it is a separate
    // document with its own version line, so it has separate history.
    function fetchHistory(sessionId, kind) {
      return fetch(
        '/jobcv/history?session=' + encodeURIComponent(sessionId) + kindParam(kind),
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      ).then(function (res) {
        if (!res.ok) throw new Error('history fetch failed: ' + res.status)
        return res.json()
      })
    }

    /** '&kind=letter', or nothing at all for the CV. */
    function kindParam(kind) {
      return kind === 'letter' ? '&kind=letter' : ''
    }

    // Roll the document back to an earlier version; resolves to the new
    // version number.
    function restoreVersion(sessionId, version, kind) {
      return fetch('/jobcv/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          version: version,
          kind: kind === 'letter' ? 'letter' : 'cv',
        }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var detail = body && body.error ? body.error : 'restore failed'
            throw new Error(detail + ' (' + res.status + ')')
          }
          if (!body || typeof body.version !== 'number') throw new Error('host returned no version')
          return body.version
        })
      })
    }
