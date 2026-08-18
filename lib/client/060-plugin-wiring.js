
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
    }

    // Test surface for the onboarding start form: the pure helpers (the
    // component itself needs a DOM). Same idea as __annotate above.
    exports.__review = { buildDecisionMessage: buildDecisionMessage, pickedOption: pickedOption }

    exports.__diagnostics = { offlineReason: offlineReason }

    // Test surface for the split: how the column is divided is arithmetic,
    // and a preview squeezed down to a sliver is invisible in review.
    exports.__layout = {
      chatWidthFor: chatWidthFor,
      splitFits: splitFits,
      CHAT_MIN: CHAT_MIN,
      CHAT_MAX: CHAT_MAX,
      PREVIEW_MIN: PREVIEW_MIN,
      SPLIT_MIN: SPLIT_MIN,
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
