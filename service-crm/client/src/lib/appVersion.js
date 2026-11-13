// "A new CRM version is available": the version this tab is running is the
// hashed main script it was loaded from; the server reports the deployed one
// (GET /api/version). Pure helpers so the rules can be tested.

export function versionFromUrl(url) {
  try {
    const file = new URL(url).pathname.split('/').pop();
    return /^index-[A-Za-z0-9_-]+\.js$/.test(file) ? file : null;
  } catch {
    return null;
  }
}

/** Only a real, different deployed version counts — never in development
 * (no versions) or when the check failed. */
export function isNewerVersion(running, deployed) {
  return !!running && !!deployed && running !== deployed;
}

// How often to ask: when the tab opens, every 10 minutes, and when staff come
// back to the tab (at most once a minute). A tiny request to this CRM only.
export const VERSION_CHECK_EVERY_MS = 10 * 60 * 1000;
export const VERSION_CHECK_MIN_GAP_MS = 60 * 1000;
