
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
      attachSwipe: attachSwipe,
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

    // Test surface for the panels. The browser half has no DOM in CI, but a
    // component that throws on render takes the whole dock down with it (that
    // is how a preview crash reads to the user: "the button is gone"), so the
    // components themselves are reachable and can be rendered with stub hooks.
    exports.__ui = {
      CvPane: CvPane,
      JobDock: JobDock,
      FitPanel: FitPanel,
      PostSurface: PostSurface,
      HistoryPanel: HistoryPanel,
      CommentPanel: CommentPanel,
    }

    // Test surface for the exported PDF's filename: the browser names the
    // download after the document title, and that name is what a recruiter
    // sees on the attachment.
    exports.__export = {
      exportFileName: exportFileName,
      candidateNameFrom: candidateNameFrom,
      fileSlug: fileSlug,
    }

    exports.__onboard = {
      buildStartMessage: buildStartMessage,
      intakeCv: intakeCv,
      upsertWorkspace: upsertWorkspace,
      readFileAsBase64: readFileAsBase64,
    }

    return module.exports
  },
})
