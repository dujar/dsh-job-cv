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
          if (parsed && typeof parsed === 'object') return { open: parsed.open !== false }
        }
      } catch (e) { /* fall through */ }
      return { open: true }
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

    // The saved versions (newest first, bodies omitted) for the rollback UI.
    function fetchHistory(sessionId) {
      return fetch('/jobcv/history?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('history fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Roll the document back to an earlier version; resolves to the new
    // version number.
    function restoreVersion(sessionId, version) {
      return fetch('/jobcv/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, version: version }),
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
