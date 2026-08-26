
    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var options = { name: 'conversation.input.dock', id: 'dsh-job-cv-dock', order: 1 }
      var disposers = []
      disposers.push(slots.inject('conversation.input.dock', function () {
        return slots.register(options, JobDockRoot)
      }))
      try {
        console.log('[dsh-job-cv] client mounted; job dock registered')
      } catch (e) { /* ignore */ }
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (e) { /* ignore */ }
        }
      }
    }

    exports.name = 'dsh-job-cv'
    exports.inject = ['slots']
    exports.apply = apply

    // Test surface: the pure helpers behind the annotate-and-comment flow.
    // Not part of the loader contract (name/inject/apply) — exported so the
    // message the agent actually receives can be asserted from node, without
    // a DOM or a browser.
    exports.__annotate = {
      buildRevisionMessage: buildRevisionMessage,
      deliverToComposer: deliverToComposer,
      deliveryNotice: deliveryNotice,
      pickableFrom: pickableFrom,
      nodePath: nodePath,
      sectionOf: sectionOf,
      noteFrom: noteFrom,
      visibleText: visibleText,
      squish: squish,
      clip: clip,
      COMMENT_PRESETS: COMMENT_PRESETS,
      buildLetterRequest: buildLetterRequest,
      buildWorkingCss: buildWorkingCss,
      buildQueuedCss: buildQueuedCss,
      rangeNoteFrom: rangeNoteFrom,
      anchorPathsFor: anchorPathsFor,
      sanitizeAnchorPath: sanitizeAnchorPath,
      ANNOTATE_CSS: ANNOTATE_CSS,
      pageDeckCss: pageDeckCss,
      isBlankPage: isBlankPage,
      markBlankSheets: markBlankSheets,
      markSheets: markSheets,
      pageOverflows: pageOverflows,
      buildOverflowRequest: buildOverflowRequest,
      injectPageDeck: injectPageDeck,
      PAGE_DRAWS: PAGE_DRAWS,
      attachSwipe: attachSwipe,
      attachTouchPicking: attachTouchPicking,
      TAP_SLOP: TAP_SLOP,
      setSwipeHandler: setSwipeHandler,
    }

    // Test surface for the onboarding start form: the pure helpers (the
    // component itself needs a DOM). Same idea as __annotate above.
    exports.__review = { buildDecisionMessage: buildDecisionMessage, pickedOption: pickedOption }

    exports.__diagnostics = { offlineReason: offlineReason, sameDoc: sameDoc, workingDone: workingDone }

    // Test surface for the fit panel: the messages a gap turns into, and the
    // staleness rule that decides whether the score on screen is about the
    // document on screen.
    exports.__fit = {
      buildFitRequest: buildFitRequest,
      buildGapMessage: buildGapMessage,
      buildPostFetchRequest: buildPostFetchRequest,
      buildBriefRequest: buildBriefRequest,
      POST_GAP_CSS: POST_GAP_CSS,
      GAP_OPEN_CSS: GAP_OPEN_CSS,
      attachGapTaps: attachGapTaps,
      injectPostGapCss: injectPostGapCss,
      fitStale: fitStale,
      fitBand: fitBand,
    }

    // Test surface for the split: how the column is divided is arithmetic,
    // and a preview squeezed down to a sliver is invisible in review.
    exports.__layout = {
      chatWidthFor: chatWidthFor,
      splitFits: splitFits,
      clampChatW: clampChatW,
      MIN_PREVIEW_PX: MIN_PREVIEW_PX,
      SHEET_W: SHEET_W,
      CHAT_MIN: CHAT_MIN,
      CHAT_MAX: CHAT_MAX,
      PREVIEW_MIN: PREVIEW_MIN,
      SPLIT_MIN: SPLIT_MIN,
    }

    // Test surface for the per-session preferences: loadPrefs normalizes a
    // stored shape, savePrefs merges into it — the dock writes open/chatW,
    // the pane writes swipeHintSeen, and a replace would drop whichever wrote
    // first.
    exports.__prefs = {
      loadPrefs: loadPrefs,
      savePrefs: savePrefs,
      prefsKey: prefsKey,
    }

    // Test surface for the panels. The browser half has no DOM in CI, but a
    // component that throws on render takes the whole dock down with it (that
    // is how a preview crash reads to the user: "the button is gone"), so the
    // components themselves are reachable and can be rendered with stub hooks.
    exports.__ui = {
      CvPane: CvPane,
      EditBar: EditBar,
      JobDock: JobDock,
      FitPanel: FitPanel,
      PostSurface: PostSurface,
      HistoryPanel: HistoryPanel,
      CommentPanel: CommentPanel,
      ApplicationsPanel: ApplicationsPanel,
      ApplicationRow: ApplicationRow,
      StatusSelect: StatusSelect,
    }

    // Test surface for editing by hand: what comes back out of an edited
    // document is what gets SAVED over the user's CV, so the rule for which
    // nodes are the parent's and which are the author's is asserted directly.
    exports.__edit = {
      serializeEditedDoc: serializeEditedDoc,
      stripInjected: stripInjected,
      isInjectedNode: isInjectedNode,
      allElements: allElements,
      editNote: editNote,
      saveEditedDoc: saveEditedDoc,
      setDocEditable: setDocEditable,
      EDIT_CSS: EDIT_CSS,
      EDIT_STYLE_ID: EDIT_STYLE_ID,
      EDIT_STRIP_ATTRS: EDIT_STRIP_ATTRS,
      EDIT_DEFAULT_NOTE: EDIT_DEFAULT_NOTE,
    }

    // Test surface for the exported PDF's filename: the browser names the
    // download after the document title, and that name is what a recruiter
    // sees on the attachment.
    exports.__export = {
      exportFileName: exportFileName,
      candidateNameFrom: candidateNameFrom,
      fileSlug: fileSlug,
      wearPrintTitle: wearPrintTitle,
    }

    exports.__onboard = {
      buildStartMessage: buildStartMessage,
      intakeCv: intakeCv,
      upsertWorkspace: upsertWorkspace,
      readFileAsBase64: readFileAsBase64,
      fetchRecentCvs: fetchRecentCvs,
      recentLabel: recentLabel,
      recentSubline: recentSubline,
      usableRecent: usableRecent,
    }

    // Test surface for the jobs list: URL comparison, row states, and the
    // start message a picked line composes — all pure, all asserted from
    // node without a DOM.
    exports.__jobs = {
      normJobUrl: normJobUrl,
      usableJobList: usableJobList,
      jobRowLabel: jobRowLabel,
      shortUrl: shortUrl,
      findCandidacyFor: findCandidacyFor,
      jobsRowState: jobsRowState,
      buildJobsStartMessage: buildJobsStartMessage,
    }

    // Test surface for the application tracker. The panel needs a DOM, but
    // what a status tag looks like, how an activity age is phrased, and the
    // message "Resume here" composes are all pure — and the resume message
    // is what the agent actually acts on. The search/filter/sort workbench
    // is pure end to end, so its whole contract is asserted here too.
    exports.__tracker = {
      STATUS_ORDER: STATUS_ORDER,
      statusColor: statusColor,
      relTime: relTime,
      shortDate: shortDate,
      effectiveStatus: effectiveStatus,
      optimisticApplication: optimisticApplication,
      applicationKey: applicationKey,
      applicationLabel: applicationLabel,
      buildResumeMessage: buildResumeMessage,
      TRACKER_VIEWS: TRACKER_VIEWS,
      SORT_FIELDS: SORT_FIELDS,
      HAS_TOKENS: HAS_TOKENS,
      FIT_BAND_OPTIONS: FIT_BAND_OPTIONS,
      RECENCY_OPTIONS: RECENCY_OPTIONS,
      applicationHas: applicationHas,
      applicationHaystack: applicationHaystack,
      applicationMatchesQuery: applicationMatchesQuery,
      defaultFilters: defaultFilters,
      applicationFitBand: applicationFitBand,
      applicationRecency: applicationRecency,
      applicationMatchesFilters: applicationMatchesFilters,
      filterApplications: filterApplications,
      sortApplications: sortApplications,
      countByStatus: countByStatus,
      facetCompanies: facetCompanies,
      filtersActive: filtersActive,
      trackerPrefsKey: trackerPrefsKey,
      loadTrackerPrefs: loadTrackerPrefs,
      saveTrackerPrefs: saveTrackerPrefs,
    }

    return module.exports
  },
})
