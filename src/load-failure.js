// =============================================================================
// SHOULD A FAILED LOAD REPLACE THE APP WITH THE OFFLINE SCREEN?
//
// Its own file, with no electron import, so it can be tested in plain node. The
// rule is small and the cost of getting it wrong is high in both directions:
// too eager and the app throws people out mid-use; too shy and they get the
// blank window this was written to kill.
// =============================================================================

/** Chromium's ERR_ABORTED. Not a failure — it is what a normal navigation looks
 *  like when the page navigates away before the previous load finished. */
const ERR_ABORTED = -3;

/**
 * @param {number} code        did-fail-load errorCode
 * @param {boolean} isMainFrame did-fail-load isMainFrame
 */
function shouldShowOffline(code, isMainFrame) {
  // A failed image, iframe or beacon must never replace the whole app.
  if (!isMainFrame) return false;
  if (code === ERR_ABORTED) return false;
  return true;
}

module.exports = { shouldShowOffline, ERR_ABORTED };
