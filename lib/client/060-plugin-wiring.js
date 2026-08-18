
    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var options = { name: 'conversation.input.dock', id: 'dsh-job-cv-dock', order: 1 }
      var disposers = []
      disposers.push(slots.inject('conversation.input.dock', function () {
        return slots.register(options, JobDock)
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

    return module.exports
  },
})
