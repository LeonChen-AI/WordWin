// AdaptiveTranslation Content Run State
// Keeps page translation runs isolated so stale async results cannot render after cancel/restart.

(function (root, factory) {
  'use strict';

  const createAdaptiveTranslationRunState = factory;

  if (root) {
    root.AdaptiveTranslationRunState = { createAdaptiveTranslationRunState };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createAdaptiveTranslationRunState };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdaptiveTranslationRunState() {
  'use strict';

  let running = false;
  let desiredEnabled = false;
  let runId = 0;

  function setDesiredEnabled(value) {
    desiredEnabled = Boolean(value);
  }

  function isDesiredEnabled() {
    return desiredEnabled;
  }

  function isRunning() {
    return running;
  }

  function getRunId() {
    return runId;
  }

  function start() {
    if (running || !desiredEnabled) return null;
    running = true;
    runId += 1;
    return runId;
  }

  function stop() {
    runId += 1;
    running = false;
    return runId;
  }

  function restart() {
    stop();
    return start();
  }

  function shouldAccept(candidateRunId) {
    return running && candidateRunId === runId;
  }

  return {
    getRunId,
    isDesiredEnabled,
    isRunning,
    restart,
    setDesiredEnabled,
    shouldAccept,
    start,
    stop
  };
});
